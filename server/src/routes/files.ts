import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, hasPermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { forbidDemo, DEMO_MESSAGES } from "../middleware/demo.js";
import { env } from "../config.js";
import { buildKey, putObject, getDownloadUrl, deleteObject, isAllowedMime, sniffMime, s3Configured } from "../services/s3.js";
import { isImportProvider, listProviderFiles, importProviderFile } from "../services/cloudDocs.js";

export const filesRouter = Router();
filesRouter.use(requireAuth, requireOrg);

// Beyond the file itself, cap the multipart envelope: memory storage buffers
// every text field too, so without these one request could carry thousands of
// large fields. The routes take one file plus a handful of short metadata fields.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 20, fieldSize: 16 * 1024, parts: 21 },
});

const metaSchema = z.object({
  dealId: z.string().optional(),
  buyerId: z.string().optional(),
  opportunityId: z.string().optional(),
  category: z.enum(["PSA", "LPOA", "DEED", "PLAT_MAP", "TITLE_DOC", "OTHER"]).default("OTHER"),
  // Folder is a free label (default folders are defined client-side) so new
  // folders never require a schema/route change.
  folder: z.string().trim().min(1).max(80).default("Other"),
});

filesRouter.post(
  "/",
  forbidDemo(DEMO_MESSAGES.UPLOAD),
  requirePermission("manageDocuments"),
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!s3Configured()) throw new HttpError(503, "File storage is not configured (set S3_* env vars)");
    const file = req.file;
    if (!file) throw new HttpError(400, "No file uploaded");
    const meta = metaSchema.parse(req.body);
    const owner = await requireFileOwner(req, meta);

    // Never trust the client-reported mimetype — sniff magic bytes.
    const detected = sniffMime(file.buffer, file.mimetype);
    if (!isAllowedMime(detected)) {
      throw new HttpError(415, `Unsupported file type: ${detected}`);
    }

    const key = buildKey(owner.scope, owner.id, file.originalname);
    await putObject(key, file.buffer, detected);

    const record = await prisma.fileAttachment.create({
      data: {
        dealId: meta.dealId ?? null,
        buyerId: meta.buyerId ?? null,
        opportunityId: meta.opportunityId ?? null,
        category: meta.category,
        folder: meta.folder,
        filename: file.originalname,
        mimeType: detected,
        sizeBytes: file.size,
        s3Key: key,
        uploadedByUserId: req.user!.id,
      },
    });
    res.status(201).json({ id: record.id, filename: record.filename, folder: record.folder, sizeBytes: record.sizeBytes });
  }),
);

// Only files whose parent deal/buyer/opportunity is in the caller's org are
// accessible. Exposed as its own predicate so every FileAttachment read here
// can name the org, including the ones that look up a row by something other
// than its id.
const fileOrgScope = (organizationId: string) => [
  { deal: { organizationId } },
  { buyer: { organizationId } },
  { opportunity: { organizationId } },
];

/** The one record a new document attaches to — exactly one of a deal, a buyer
 *  or an opportunity, and it must belong to the caller's organization. */
async function requireFileOwner(req: AuthedRequest, o: { dealId?: string; buyerId?: string; opportunityId?: string }) {
  const given = [o.dealId, o.buyerId, o.opportunityId].filter(Boolean).length;
  if (given !== 1) throw new HttpError(400, "Provide exactly one of dealId, buyerId or opportunityId");
  if (o.dealId) {
    const d = await prisma.deal.findFirst({ where: { id: o.dealId, organizationId: orgId(req) }, select: { id: true } });
    if (!d) throw new HttpError(404, "Deal not found");
    return { scope: "deal" as const, id: d.id };
  }
  if (o.opportunityId) {
    const p = await prisma.opportunity.findFirst({ where: { id: o.opportunityId, organizationId: orgId(req) }, select: { id: true } });
    if (!p) throw new HttpError(404, "Opportunity not found");
    return { scope: "opportunity" as const, id: p.id };
  }
  const b = await prisma.buyer.findFirst({ where: { id: o.buyerId!, organizationId: orgId(req) }, select: { id: true } });
  if (!b) throw new HttpError(404, "Buyer not found");
  return { scope: "buyer" as const, id: b.id };
}

function fileOrgWhere(id: string, organizationId: string) {
  return { id, OR: fileOrgScope(organizationId) };
}

// Reading a document is its own permission. Org scoping (fileOrgWhere) has
// always been correct here, but there was no gate beyond "is a member of this
// org" — so a role deliberately stripped of document access could still fetch
// a presigned URL for every file on every deal and buyer in the org.
filesRouter.get(
  "/:id/download",
  requirePermission("viewDocuments"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = await prisma.fileAttachment.findFirst({ where: fileOrgWhere(req.params.id, orgId(req)) });
    if (!file) throw new HttpError(404, "File not found");
    // ?inline=1 serves the file for in-browser preview instead of forcing a download.
    const inline = req.query.inline === "1" || req.query.inline === "true";
    const url = await getDownloadUrl(file.s3Key, file.filename, inline);
    res.json({ url, expiresInSeconds: env.S3.SIGNED_URL_TTL_SECONDS });
  }),
);

// Rename, move between folders, and/or toggle buyer-portal visibility.
const patchSchema = z.object({
  filename: z.string().trim().min(1).max(255).optional(),
  folder: z.string().trim().min(1).max(80).optional(),
  // Approve/revoke this document for the deal's public offering page.
  visibleToBuyers: z.boolean().optional(),
});
filesRouter.patch(
  "/:id",
  requirePermission("manageDocuments"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = await prisma.fileAttachment.findFirst({ where: fileOrgWhere(req.params.id, orgId(req)) });
    if (!file) throw new HttpError(404, "File not found");
    const patch = patchSchema.parse(req.body);
    if (patch.filename === undefined && patch.folder === undefined && patch.visibleToBuyers === undefined) throw new HttpError(400, "Nothing to update");
    // Approving a document for buyers publishes it on the PUBLIC offering page —
    // the same act as publishing the offering, so it takes the same permission.
    if (patch.visibleToBuyers !== undefined && !hasPermission(req, "publishOfferings")) {
      throw new HttpError(403, "You do not have permission to publish documents to buyers");
    }
    const updated = await prisma.fileAttachment.update({
      where: { id: file.id },
      data: {
        ...(patch.filename !== undefined ? { filename: patch.filename } : {}),
        ...(patch.folder !== undefined ? { folder: patch.folder } : {}),
        ...(patch.visibleToBuyers !== undefined ? { visibleToBuyers: patch.visibleToBuyers } : {}),
      },
    });
    res.json({ id: updated.id, filename: updated.filename, folder: updated.folder, visibleToBuyers: updated.visibleToBuyers });
  }),
);

// Replace a file with a new upload, preserving the previous version. The old
// record is kept (marked superseded); the new record becomes current and links
// back to it via supersedes.
filesRouter.post(
  "/:id/replace",
  forbidDemo(DEMO_MESSAGES.UPLOAD),
  requirePermission("manageDocuments"),
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!s3Configured()) throw new HttpError(503, "File storage is not configured (set S3_* env vars)");
    const prev = await prisma.fileAttachment.findFirst({ where: fileOrgWhere(req.params.id, orgId(req)) });
    if (!prev) throw new HttpError(404, "File not found");
    const file = req.file;
    if (!file) throw new HttpError(400, "No file uploaded");

    const detected = sniffMime(file.buffer, file.mimetype);
    if (!isAllowedMime(detected)) throw new HttpError(415, `Unsupported file type: ${detected}`);

    const scope = prev.dealId ? "deal" : prev.opportunityId ? "opportunity" : "buyer";
    const parentId = (prev.dealId ?? prev.opportunityId ?? prev.buyerId)!;
    const key = buildKey(scope, parentId, file.originalname);
    await putObject(key, file.buffer, detected);

    const created = await prisma.$transaction(async (tx) => {
      const next = await tx.fileAttachment.create({
        data: {
          dealId: prev.dealId,
          buyerId: prev.buyerId,
          opportunityId: prev.opportunityId,
          category: prev.category,
          folder: prev.folder,
          filename: file.originalname,
          mimeType: detected,
          sizeBytes: file.size,
          s3Key: key,
          uploadedByUserId: req.user!.id,
        },
      });
      // Point the old version at its replacement so it drops out of the current list.
      await tx.fileAttachment.update({ where: { id: prev.id }, data: { supersededById: next.id } });
      return next;
    });
    res.status(201).json({ id: created.id, filename: created.filename, folder: created.folder });
  }),
);

// Prior versions of a file (most recent first).
filesRouter.get(
  "/:id/versions",
  requirePermission("viewDocuments"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = await prisma.fileAttachment.findFirst({ where: fileOrgWhere(req.params.id, orgId(req)) });
    if (!file) throw new HttpError(404, "File not found");
    // Walk the chain of prior versions: each older file points at the record
    // that superseded it, so the one this record replaced has supersededById === file.id.
    const versions: { id: string; filename: string; sizeBytes: number; createdAt: Date; uploadedBy: string | null }[] = [];
    let currentId = file.id;
    for (;;) {
      const prior = await prisma.fileAttachment.findFirst({
        // Scoped by org as well as by the chain link. Redundant TODAY —
        // supersededById is only ever set in /replace, between two files on the
        // same parent record — but this was the one FileAttachment read in this
        // router that didn't name an org, and that invariant is what keeps a
        // future write path to that column (a bulk re-link, an import that
        // reuses ids) from turning this walk into a cross-org read.
        where: { supersededById: currentId, OR: fileOrgScope(orgId(req)) },
        include: { uploadedBy: { select: { name: true } } },
      });
      if (!prior) break;
      versions.push({ id: prior.id, filename: prior.filename, sizeBytes: prior.sizeBytes, createdAt: prior.createdAt, uploadedBy: prior.uploadedBy?.name ?? null });
      currentId = prior.id;
    }
    res.json({ versions });
  }),
);

filesRouter.delete(
  "/:id",
  requirePermission("manageDocuments"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = await prisma.fileAttachment.findFirst({ where: fileOrgWhere(req.params.id, orgId(req)) });
    if (!file) throw new HttpError(404, "File not found");
    await deleteObject(file.s3Key);
    await prisma.fileAttachment.delete({ where: { id: file.id } });
    res.json({ ok: true });
  }),
);

// --- Cloud document import (Google Drive / OneDrive) ---------------------------
// Lives here (not under /integrations) because importing documents is everyday
// document work — gated by manageDocuments, not the admin-only integrations
// permission. The admin connects the account once; the team imports freely.

/** Which import-capable providers this org has connected (safe for any member). */
filesRouter.get(
  "/cloud/providers",
  requirePermission("manageDocuments"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.integration.findMany({
      where: { organizationId: orgId(req), provider: { in: ["googledrive", "onedrive"] }, status: "CONNECTED" },
      select: { provider: true },
    });
    const connected = new Set(rows.map((r) => r.provider));
    res.json([
      { key: "googledrive", name: "Google Drive", connected: connected.has("googledrive") },
      { key: "onedrive", name: "OneDrive", connected: connected.has("onedrive") },
    ]);
  }),
);

async function connectedImportRow(req: AuthedRequest) {
  const provider = req.params.provider;
  if (!isImportProvider(provider)) throw new HttpError(400, "This provider does not support document import.");
  const row = await prisma.integration.findUnique({
    where: { organizationId_provider: { organizationId: orgId(req), provider } },
  });
  if (!row || row.status === "NOT_CONNECTED") {
    throw new HttpError(400, "This cloud account isn't connected. An admin can connect it in Settings → Integrations.");
  }
  return row;
}

// Browse or search the connected account's files.
filesRouter.get(
  "/cloud/:provider/list",
  requirePermission("manageDocuments"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const row = await connectedImportRow(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    res.json(await listProviderFiles(row, q));
  }),
);

// Import one file: download from the provider → same sniff/size gate as an
// upload → S3 → FileAttachment row on the deal or buyer.
filesRouter.post(
  "/cloud/:provider/import",
  forbidDemo(DEMO_MESSAGES.UPLOAD),
  requirePermission("manageDocuments"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const row = await connectedImportRow(req);
    const body = z.object({
      fileId: z.string().min(1).max(512),
      dealId: z.string().optional(),
      buyerId: z.string().optional(),
      opportunityId: z.string().optional(),
      folder: z.string().trim().min(1).max(80).default("Other"),
    }).parse(req.body);
    await requireFileOwner(req, body);

    const record = await importProviderFile(row, {
      fileId: body.fileId, dealId: body.dealId ?? null, buyerId: body.buyerId ?? null, opportunityId: body.opportunityId ?? null,
      folder: body.folder, uploadedByUserId: req.user?.id ?? null,
    });
    res.status(201).json(record);
  }),
);
