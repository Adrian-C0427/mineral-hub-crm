import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, orgId, type AuthedRequest } from "../middleware/auth.js";
import { env } from "../config.js";
import { buildKey, putObject, getDownloadUrl, deleteObject, isAllowedMime, sniffMime, s3Configured } from "../services/s3.js";

export const filesRouter = Router();
filesRouter.use(requireAuth, requireOrg);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_BYTES } });

const metaSchema = z.object({
  dealId: z.string().optional(),
  buyerId: z.string().optional(),
  category: z.enum(["PSA", "LPOA", "DEED", "PLAT_MAP", "TITLE_DOC", "OTHER"]).default("OTHER"),
  // Folder is a free label (default folders are defined client-side) so new
  // folders never require a schema/route change.
  folder: z.string().trim().min(1).max(80).default("Other"),
});

filesRouter.post(
  "/",
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!s3Configured()) throw new HttpError(503, "File storage is not configured (set S3_* env vars)");
    const file = req.file;
    if (!file) throw new HttpError(400, "No file uploaded");
    const meta = metaSchema.parse(req.body);
    if (!!meta.dealId === !!meta.buyerId) {
      throw new HttpError(400, "Provide exactly one of dealId or buyerId");
    }
    // Verify the target record belongs to the caller's organization.
    if (meta.dealId) {
      const d = await prisma.deal.findFirst({ where: { id: meta.dealId, organizationId: orgId(req) } });
      if (!d) throw new HttpError(404, "Deal not found");
    } else {
      const b = await prisma.buyer.findFirst({ where: { id: meta.buyerId!, organizationId: orgId(req) } });
      if (!b) throw new HttpError(404, "Buyer not found");
    }

    // Never trust the client-reported mimetype — sniff magic bytes.
    const detected = sniffMime(file.buffer, file.mimetype);
    if (!isAllowedMime(detected)) {
      throw new HttpError(415, `Unsupported file type: ${detected}`);
    }

    const scope = meta.dealId ? "deal" : "buyer";
    const id = (meta.dealId ?? meta.buyerId)!;
    const key = buildKey(scope, id, file.originalname);
    await putObject(key, file.buffer, detected);

    const record = await prisma.fileAttachment.create({
      data: {
        dealId: meta.dealId ?? null,
        buyerId: meta.buyerId ?? null,
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

// Only files whose parent deal/buyer is in the caller's org are accessible.
function fileOrgWhere(id: string, organizationId: string) {
  return {
    id,
    OR: [{ deal: { organizationId } }, { buyer: { organizationId } }],
  };
}

filesRouter.get(
  "/:id/download",
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = await prisma.fileAttachment.findFirst({ where: fileOrgWhere(req.params.id, orgId(req)) });
    if (!file) throw new HttpError(404, "File not found");
    // ?inline=1 serves the file for in-browser preview instead of forcing a download.
    const inline = req.query.inline === "1" || req.query.inline === "true";
    const url = await getDownloadUrl(file.s3Key, file.filename, inline);
    res.json({ url, expiresInSeconds: env.S3.SIGNED_URL_TTL_SECONDS });
  }),
);

// Rename and/or move a file between folders.
const patchSchema = z.object({
  filename: z.string().trim().min(1).max(255).optional(),
  folder: z.string().trim().min(1).max(80).optional(),
});
filesRouter.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = await prisma.fileAttachment.findFirst({ where: fileOrgWhere(req.params.id, orgId(req)) });
    if (!file) throw new HttpError(404, "File not found");
    const patch = patchSchema.parse(req.body);
    if (patch.filename === undefined && patch.folder === undefined) throw new HttpError(400, "Nothing to update");
    const updated = await prisma.fileAttachment.update({
      where: { id: file.id },
      data: { ...(patch.filename !== undefined ? { filename: patch.filename } : {}), ...(patch.folder !== undefined ? { folder: patch.folder } : {}) },
    });
    res.json({ id: updated.id, filename: updated.filename, folder: updated.folder });
  }),
);

// Replace a file with a new upload, preserving the previous version. The old
// record is kept (marked superseded); the new record becomes current and links
// back to it via supersedes.
filesRouter.post(
  "/:id/replace",
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!s3Configured()) throw new HttpError(503, "File storage is not configured (set S3_* env vars)");
    const prev = await prisma.fileAttachment.findFirst({ where: fileOrgWhere(req.params.id, orgId(req)) });
    if (!prev) throw new HttpError(404, "File not found");
    const file = req.file;
    if (!file) throw new HttpError(400, "No file uploaded");

    const detected = sniffMime(file.buffer, file.mimetype);
    if (!isAllowedMime(detected)) throw new HttpError(415, `Unsupported file type: ${detected}`);

    const scope = prev.dealId ? "deal" : "buyer";
    const parentId = (prev.dealId ?? prev.buyerId)!;
    const key = buildKey(scope, parentId, file.originalname);
    await putObject(key, file.buffer, detected);

    const created = await prisma.$transaction(async (tx) => {
      const next = await tx.fileAttachment.create({
        data: {
          dealId: prev.dealId,
          buyerId: prev.buyerId,
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
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = await prisma.fileAttachment.findFirst({ where: fileOrgWhere(req.params.id, orgId(req)) });
    if (!file) throw new HttpError(404, "File not found");
    // Walk the chain of prior versions: each older file points at the record
    // that superseded it, so the one this record replaced has supersededById === file.id.
    const versions: { id: string; filename: string; sizeBytes: number; createdAt: Date; uploadedBy: string | null }[] = [];
    let currentId = file.id;
    for (;;) {
      const prior = await prisma.fileAttachment.findFirst({
        where: { supersededById: currentId },
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
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = await prisma.fileAttachment.findFirst({ where: fileOrgWhere(req.params.id, orgId(req)) });
    if (!file) throw new HttpError(404, "File not found");
    await deleteObject(file.s3Key);
    await prisma.fileAttachment.delete({ where: { id: file.id } });
    res.json({ ok: true });
  }),
);
