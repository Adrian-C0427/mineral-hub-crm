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
        filename: file.originalname,
        mimeType: detected,
        sizeBytes: file.size,
        s3Key: key,
        uploadedByUserId: req.user!.id,
      },
    });
    res.status(201).json({ id: record.id, filename: record.filename, category: record.category, sizeBytes: record.sizeBytes });
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
    const url = await getDownloadUrl(file.s3Key, file.filename);
    res.json({ url, expiresInSeconds: env.S3.SIGNED_URL_TTL_SECONDS });
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
