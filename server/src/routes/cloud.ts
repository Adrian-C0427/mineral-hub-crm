/**
 * Cloud files — a member's OneDrive / Google Drive (services/cloud/) and the
 * links that put drive files on CRM records.
 *
 * Access, enforced here on every request:
 *  - /:accountId/…   the caller's OWN connected drive (404 for anyone else's)
 *                    + manageDocuments.
 *  - /links …        record-level: the record must be in the caller's org and
 *                    visible to their role (services/connected/records.ts);
 *                    listing needs viewDocuments, linking/unlinking
 *                    manageDocuments. Downloading a linked file through the CRM
 *                    is for the account's owner only — everyone else opens it
 *                    at the provider, where Google/Microsoft permissions apply.
 *
 * Uploads stream from a temp file in chunks (never the whole file in memory),
 * are type-checked by magic bytes, and are size-capped (CLOUD_UPLOAD_MAX_MB).
 * Destructive actions (rename, move, trash, upload, copy, link, unlink) are
 * audit-logged.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../config.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { hasPermission, orgId, requireAuth, requireOrg, requirePermission, type AuthedRequest } from "../middleware/auth.js";
import { demoReadOnly, forbidDemo } from "../middleware/demo.js";
import { logActivity } from "../services/activityLog.js";
import { loadUsableAccount } from "../services/connected/accounts.js";
import { ProviderError } from "../services/connected/client.js";
import { loadRecord, recordColumns, recordRefSchema, refOf, type RecordRef } from "../services/connected/records.js";
import { driverFor, isDriveProvider, LINK_INCLUDE, linkItem, markItemMissing, serializeLink } from "../services/cloud/index.js";
import { checkUploadType, CLOUD_UPLOAD_MAX_BYTES, contentDisposition, safeCloudName, safeItemId } from "../services/cloud/safety.js";
import type { CloudView, ExportFormat, UploadSource } from "../services/cloud/types.js";
import { buildKey, getObjectBytes, isAllowedMime, putObject, s3Configured, sniffMime } from "../services/s3.js";

export const cloudRouter = Router();
cloudRouter.use(requireAuth, requireOrg, demoReadOnly());

const readLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).user?.id ?? req.ip ?? "unknown",
  message: { error: "Too many requests to your drive. Wait a moment and try again." },
});
const writeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).user?.id ?? req.ip ?? "unknown",
  message: { error: "Too many file changes in a short time. Wait a few minutes and try again." },
});
cloudRouter.use((req, res, next) => (req.method === "GET" ? readLimiter(req, res, next) : writeLimiter(req, res, next)));

const TMP_DIR = path.join(os.tmpdir(), "mineral-hub-cloud");
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: CLOUD_UPLOAD_MAX_BYTES, files: 1, fields: 10, fieldSize: 4096, parts: 11 },
});

async function drive(req: AuthedRequest) {
  const a = await loadUsableAccount(orgId(req), req.user!.id, req.params.accountId);
  if (!isDriveProvider(a.provider)) throw new HttpError(404, "Connected account not found.");
  return { account: a, driver: driverFor(a) };
}

async function audit(req: AuthedRequest, eventType: string, summary: string, metadata: Record<string, string | null>) {
  await logActivity({ eventType, summary, organizationId: orgId(req), actorUserId: req.user!.id, metadata });
}

const VIEWS = new Set<CloudView>(["mine", "shared", "drives"]);
const FORMATS = new Set<ExportFormat>(["pdf", "docx", "xlsx", "pptx", "csv", "txt"]);

// ---------------------------------------------------------------------------
// Record links
// ---------------------------------------------------------------------------

const refFromQuery = (q: Request["query"]): RecordRef => recordRefSchema.parse({ type: q.type, id: q.id });

cloudRouter.get(
  "/links",
  requirePermission("viewDocuments"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const ref = refFromQuery(req.query);
    await loadRecord(req, ref);
    const rows = await prisma.cloudFileLink.findMany({
      where: { organizationId: orgId(req), ...recordColumns(ref) },
      include: LINK_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    res.json(rows.map((l) => serializeLink(l, req.user!.id)));
  }),
);

const linkSchema = z.object({
  accountId: z.string().min(1).max(200),
  itemIds: z.array(z.string().min(1).max(300)).min(1).max(50),
  record: recordRefSchema,
  folder: z.string().trim().min(1).max(80).default("Other"),
});

cloudRouter.post(
  "/links",
  requirePermission("manageDocuments"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = linkSchema.parse(req.body);
    const record = await loadRecord(req, body.record);
    const account = await loadUsableAccount(orgId(req), req.user!.id, body.accountId);
    if (!isDriveProvider(account.provider)) throw new HttpError(404, "Connected account not found.");
    const driver = driverFor(account);
    const linked = [];
    for (const raw of body.itemIds) {
      const item = await driver.get(account, safeItemId(raw));
      if (item.isFolder) throw new HttpError(400, `"${item.name}" is a folder — link files.`);
      linked.push(await linkItem({ account, item, record: body.record, folder: body.folder, userId: req.user!.id }));
    }
    await audit(req, "cloud.linked", `Linked ${linked.length} ${account.provider === "onedrive" ? "OneDrive" : "Google Drive"} file(s) to ${record.name}`, { record: `${body.record.type}:${body.record.id}` });
    res.status(201).json(linked.map((l) => serializeLink(l, req.user!.id)));
  }),
);

/** A link on a record the caller can see, with the permission the action needs. */
async function linkFor(req: AuthedRequest, perm: "viewDocuments" | "manageDocuments") {
  if (!hasPermission(req, perm)) throw new HttpError(403, "Your role doesn't include this.");
  const l = await prisma.cloudFileLink.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, include: LINK_INCLUDE });
  const ref = l ? refOf(l) : null;
  if (!l || !ref) throw new HttpError(404, "Linked file not found.");
  await loadRecord(req, ref);
  return l;
}

cloudRouter.patch(
  "/links/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const l = await linkFor(req, "manageDocuments");
    const { folder } = z.object({ folder: z.string().trim().min(1).max(80) }).parse(req.body);
    const row = await prisma.cloudFileLink.update({ where: { id: l.id }, data: { folder }, include: LINK_INCLUDE });
    res.json(serializeLink(row, req.user!.id));
  }),
);

/** Unlink: removes the record's pointer only — the file stays in the drive. */
cloudRouter.delete(
  "/links/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const l = await linkFor(req, "manageDocuments");
    await prisma.cloudFileLink.delete({ where: { id: l.id } });
    await audit(req, "cloud.unlinked", `Unlinked "${l.name}" from a record (the file itself was not touched)`, { linkId: l.id });
    res.json({ ok: true });
  }),
);

cloudRouter.get(
  "/links/:id/download",
  asyncHandler(async (req: AuthedRequest, res) => {
    const l = await linkFor(req, "viewDocuments");
    if (l.account.userId !== req.user!.id) {
      throw new HttpError(403, "Only the person who linked this file can download it through the CRM. Open it in the drive instead — your own access there applies.");
    }
    const account = await loadUsableAccount(orgId(req), req.user!.id, l.accountId);
    await streamDownload(res, await driverFor(account).download(account, l.providerFileId, null), req.query.inline === "1");
  }),
);

// ---------------------------------------------------------------------------
// The member's own drive
// ---------------------------------------------------------------------------

cloudRouter.use("/:accountId", requirePermission("manageDocuments"), forbidDemo());

cloudRouter.get(
  "/:accountId/items",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { account, driver } = await drive(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor.slice(0, 4000) : null;
    const folder = typeof req.query.folder === "string" && req.query.folder ? safeItemId(req.query.folder) : null;
    const view = VIEWS.has(req.query.view as CloudView) ? (req.query.view as CloudView) : "mine";
    res.json(q ? await driver.search(account, q, cursor) : await driver.list(account, folder, cursor, view));
  }),
);

cloudRouter.get(
  "/:accountId/items/:itemId",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { account, driver } = await drive(req);
    res.json(await driver.get(account, safeItemId(req.params.itemId)));
  }),
);

cloudRouter.post(
  "/:accountId/folders",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { account, driver } = await drive(req);
    const body = z.object({ parentId: z.string().max(300).nullable(), name: z.string().min(1).max(255) }).parse(req.body);
    const item = await driver.createFolder(account, body.parentId ? safeItemId(body.parentId) : null, safeCloudName(body.name));
    await audit(req, "cloud.folder_created", `Created folder "${item.name}" in ${account.provider === "onedrive" ? "OneDrive" : "Google Drive"}`, { accountId: account.id });
    res.status(201).json(item);
  }),
);

cloudRouter.patch(
  "/:accountId/items/:itemId",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { account, driver } = await drive(req);
    const id = safeItemId(req.params.itemId);
    const body = z.object({
      name: z.string().min(1).max(255).optional(),
      parentId: z.string().max(300).nullable().optional(),
      etag: z.string().max(500).nullable().optional(),
    }).parse(req.body);
    if (body.name === undefined && body.parentId === undefined) throw new HttpError(400, "Nothing to change.");
    let item = await driver.get(account, id);
    const before = item.name;
    if (body.name !== undefined) item = await driver.rename(account, id, safeCloudName(body.name), body.etag ?? null);
    if (body.parentId !== undefined) item = await driver.move(account, id, body.parentId ? safeItemId(body.parentId) : null, body.name !== undefined ? item.etag : body.etag ?? null);
    // Keep linked records' copy of the name current right away.
    await prisma.cloudFileLink.updateMany({ where: { accountId: account.id, providerFileId: id }, data: { name: item.name, webUrl: item.webUrl } });
    await audit(req, body.parentId !== undefined ? "cloud.moved" : "cloud.renamed", body.name !== undefined ? `Renamed "${before}" to "${item.name}"` : `Moved "${item.name}"`, { accountId: account.id });
    res.json(item);
  }),
);

/** To the recycle bin / trash (recoverable there). Links to it show as missing. */
cloudRouter.delete(
  "/:accountId/items/:itemId",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { account, driver } = await drive(req);
    const id = safeItemId(req.params.itemId);
    const item = await driver.get(account, id);
    if (!item.canDelete) throw new HttpError(403, "The drive doesn't let you delete this item.");
    await driver.trash(account, id, typeof req.query.etag === "string" ? req.query.etag : item.etag);
    const links = await markItemMissing(account.id, id);
    await audit(req, "cloud.trashed", `Moved "${item.name}" to the ${account.provider === "onedrive" ? "OneDrive recycle bin" : "Google Drive trash"}`, { accountId: account.id });
    res.json({ ok: true, linksAffected: links });
  }),
);

async function streamDownload(res: Response, d: { body: ReadableStream<Uint8Array>; filename: string; mimeType: string; sizeBytes: number | null }, inline: boolean): Promise<void> {
  // Inline only for types a browser renders inertly; anything else downloads.
  const inlineOk = inline && /^(application\/pdf|image\/(png|jpeg|gif)|text\/plain)$/.test(d.mimeType);
  res.setHeader("Content-Type", inlineOk ? d.mimeType : "application/octet-stream");
  res.setHeader("Content-Disposition", contentDisposition(d.filename, inlineOk));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  if (d.sizeBytes != null) res.setHeader("Content-Length", String(d.sizeBytes));
  await new Promise<void>((resolve, reject) => {
    const s = Readable.fromWeb(d.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
    s.on("error", reject);
    res.on("close", () => { s.destroy(); resolve(); });
    s.pipe(res).on("finish", resolve);
  });
}

cloudRouter.get(
  "/:accountId/items/:itemId/download",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { account, driver } = await drive(req);
    const format = FORMATS.has(req.query.format as ExportFormat) ? (req.query.format as ExportFormat) : null;
    await streamDownload(res, await driver.download(account, safeItemId(req.params.itemId), format), req.query.inline === "1");
  }),
);

cloudRouter.get(
  "/:accountId/items/:itemId/preview",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { account, driver } = await drive(req);
    res.json({ url: await driver.previewUrl(account, safeItemId(req.params.itemId)) });
  }),
);

function diskSource(file: Express.Multer.File, name: string, mimeType: string): UploadSource {
  return {
    name, mimeType, sizeBytes: file.size,
    async read(offset, length) {
      const fh = await fs.promises.open(file.path, "r");
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      } finally { await fh.close(); }
    },
  };
}

cloudRouter.post(
  "/:accountId/upload",
  (req: Request, res: Response, next: NextFunction) => upload.single("file")(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, `Files up to ${Math.round(CLOUD_UPLOAD_MAX_BYTES / 1024 / 1024)} MB can be uploaded.`));
    next(err as Error | undefined);
  }),
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = req.file;
    try {
      if (!file) throw new HttpError(400, "Choose a file to upload.");
      const { account, driver } = await drive(req);
      const parentId = typeof req.body.parentId === "string" && req.body.parentId ? safeItemId(req.body.parentId) : null;
      const conflict = req.body.conflict === "rename" ? "rename" : "fail";
      const name = safeCloudName(file.originalname);
      const head = await diskSource(file, name, file.mimetype).read(0, 4096);
      const mime = checkUploadType(head, file.mimetype, name);
      const item = await driver.upload(account, parentId, diskSource(file, name, mime), conflict);
      await audit(req, "cloud.uploaded", `Uploaded "${item.name}" to ${account.provider === "onedrive" ? "OneDrive" : "Google Drive"}`, { accountId: account.id });
      res.status(201).json(item);
    } finally {
      if (file) await fs.promises.unlink(file.path).catch(() => {});
    }
  }),
);

/** Copy a stored CRM document to the member's drive (the original stays put). */
cloudRouter.post(
  "/:accountId/copy-document",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { account, driver } = await drive(req);
    const body = z.object({ attachmentId: z.string().min(1).max(200), parentId: z.string().max(300).nullable(), conflict: z.enum(["fail", "rename"]).default("fail") }).parse(req.body);
    const att = await prisma.fileAttachment.findFirst({
      where: {
        id: body.attachmentId,
        OR: [{ deal: { organizationId: orgId(req) } }, { buyer: { organizationId: orgId(req) } }, { opportunity: { organizationId: orgId(req) } }],
      },
    });
    if (!att) throw new HttpError(404, "Document not found.");
    const record: RecordRef = att.dealId ? { type: "deal", id: att.dealId } : att.opportunityId ? { type: "opportunity", id: att.opportunityId } : { type: "buyer", id: att.buyerId! };
    await loadRecord(req, record);
    if (!s3Configured()) throw new HttpError(503, "Object storage isn't configured on this server.");
    const bytes = await getObjectBytes(att.s3Key, CLOUD_UPLOAD_MAX_BYTES);
    const item = await driver.upload(account, body.parentId ? safeItemId(body.parentId) : null, {
      name: safeCloudName(att.filename), mimeType: att.mimeType, sizeBytes: bytes.length,
      read: async (o, l) => bytes.subarray(o, o + l),
    }, body.conflict);
    const link = await linkItem({ account, item, record, folder: att.folder, userId: req.user!.id, origin: "COPIED", sourceAttachmentId: att.id });
    await audit(req, "cloud.copied", `Copied "${att.filename}" to ${account.provider === "onedrive" ? "OneDrive" : "Google Drive"}`, { accountId: account.id, attachmentId: att.id });
    res.status(201).json({ item, link: serializeLink(link, req.user!.id) });
  }),
);

/** Import a COPY of a drive file into the CRM's own storage (deal / opportunity / buyer documents). */
cloudRouter.post(
  "/:accountId/import",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { account, driver } = await drive(req);
    const body = z.object({
      itemId: z.string().min(1).max(300),
      record: recordRefSchema.refine((r) => r.type !== "contact", "Contacts don't have a documents section — link the file instead."),
      folder: z.string().trim().min(1).max(80).default("Other"),
      format: z.enum(["pdf", "docx", "xlsx", "pptx", "csv", "txt"]).optional(),
    }).parse(req.body);
    await loadRecord(req, body.record);
    if (!s3Configured()) throw new HttpError(503, "Object storage isn't configured on this server.");
    const d = await driver.download(account, safeItemId(body.itemId), body.format ?? null);
    const limit = env.MAX_UPLOAD_BYTES;
    if (d.sizeBytes != null && d.sizeBytes > limit) throw new HttpError(413, `Files up to ${Math.round(limit / 1024 / 1024)} MB can be imported into the CRM.`);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of Readable.fromWeb(d.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>)) {
      total += (chunk as Buffer).length;
      if (total > limit) throw new HttpError(413, `Files up to ${Math.round(limit / 1024 / 1024)} MB can be imported into the CRM.`);
      chunks.push(chunk as Buffer);
    }
    const bytes = Buffer.concat(chunks);
    const filename = safeCloudName(d.filename);
    const detected = sniffMime(bytes, d.mimeType);
    if (!isAllowedMime(detected)) throw new HttpError(400, `"${filename}" isn't a type the CRM's documents accept.`);
    const scope = body.record.type as "deal" | "opportunity" | "buyer";
    const key = buildKey(scope, body.record.id, filename);
    await putObject(key, bytes, detected);
    const rec = await prisma.fileAttachment.create({
      data: { ...recordColumns(body.record), folder: body.folder, filename, mimeType: detected, sizeBytes: bytes.length, s3Key: key, uploadedByUserId: req.user!.id },
    });
    await audit(req, "cloud.imported", `Imported a copy of "${filename}" from ${account.provider === "onedrive" ? "OneDrive" : "Google Drive"}`, { accountId: account.id });
    res.status(201).json({ id: rec.id, filename: rec.filename, folder: rec.folder, sizeBytes: rec.sizeBytes });
  }),
);

// Provider failures become clear statuses (409 reconnect, 403, 404, 409 conflict, 429, 503).
cloudRouter.use((err: unknown, _req: Request, _res: Response, next: NextFunction) => {
  if (err instanceof ProviderError) return next(new HttpError(err.httpStatus, err.message));
  next(err);
});
