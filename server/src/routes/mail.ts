/**
 * Outlook mail in the CRM (services/mail/).
 *
 * Access, enforced here on every request:
 *  - /:accountId/…      the caller's OWN connected Outlook mailbox (404 for
 *                       anyone else's) + the sendEmail permission. Nobody
 *                       reads another member's mailbox through the CRM.
 *  - /record, /stored   emails FILED on a record: visible to whoever can see
 *                       that record (services/connected/records.ts). Their
 *                       attachments stay in the owner's mailbox.
 *  - /signatures/…      the owner's signatures only.
 *
 * Sends are rate limited per member, attachments are size-capped and come
 * from the member's computer or from documents they can see.
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
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { hasPermission, orgId, requireAuth, requireOrg, requirePermission, type AuthedRequest } from "../middleware/auth.js";
import { demoReadOnly, forbidDemo } from "../middleware/demo.js";
import { logActivity } from "../services/activityLog.js";
import { loadUsableAccount, loadOwnAccount } from "../services/connected/accounts.js";
import { ProviderError } from "../services/connected/client.js";
import { loadRecord, recordColumns, recordNames, recordRefSchema, refOf, type RecordRef } from "../services/connected/records.js";
import { attachmentStream, getConversation, getMessage, listFolders, listMessages, moveMessage, setRead, type Address } from "../services/mail/graph.js";
import { sendEmailNow, MAX_ATTACHMENTS_BYTES, type OutAttachment } from "../services/mail/send.js";
import { linkEmail, recordTimeline } from "../services/mail/links.js";
import { prepareSignature, saveSignature, serializeSignature, MAX_ASSET_BYTES, type SignatureImage } from "../services/mail/signatures.js";
import { stripSignatureBlock } from "../services/mail/html.js";
import { contentDisposition } from "../services/cloud/safety.js";
import { getObjectBytes, s3Configured } from "../services/s3.js";
import "../services/mail/mailSync.js";

export const mailRouter = Router();
mailRouter.use(requireAuth, requireOrg, demoReadOnly());

const readLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 900, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).user?.id ?? req.ip ?? "unknown",
  message: { error: "Too many mailbox requests. Wait a moment and try again." },
});
// Sending spends the member's mailbox reputation and Exchange quota.
const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).user?.id ?? req.ip ?? "unknown",
  message: { error: "Too many emails sent in a short time. Wait a few minutes and try again." },
});
const writeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).user?.id ?? req.ip ?? "unknown",
  message: { error: "Too many mailbox changes. Wait a moment and try again." },
});
mailRouter.use((req, res, next) => (req.method === "GET" ? readLimiter(req, res, next) : next()));

const TMP = path.join(os.tmpdir(), "mineral-hub-mail");
fs.mkdirSync(TMP, { recursive: true });
const sendUpload = multer({ dest: TMP, limits: { fileSize: MAX_ATTACHMENTS_BYTES, files: 20, fields: 5, fieldSize: 2 * 1024 * 1024 } });
const sigUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ASSET_BYTES, files: 20, fields: 8, fieldSize: 3 * 1024 * 1024 } });

const multipart = (m: ReturnType<typeof multer>, field: string) => (req: Request, res: Response, next: NextFunction) =>
  m.array(field)(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) return next(new HttpError(413, err.code === "LIMIT_FILE_SIZE" ? "One of the files is too large." : "Too many files."));
    next(err as Error | undefined);
  });

async function mailbox(req: AuthedRequest) {
  return loadUsableAccount(orgId(req), req.user!.id, req.params.accountId, "outlook");
}

const addressSchema = z.object({ name: z.string().max(200).nullable().optional(), address: z.string().trim().toLowerCase().email().max(320) });
const addresses = z.array(addressSchema).max(100);

// ---------------------------------------------------------------------------
// Filed emails on records (shared with whoever can see the record)
// ---------------------------------------------------------------------------

const MAIL_LIST_SELECT = {
  id: true, direction: true, subject: true, fromAddress: true, fromName: true, toRecipients: true, ccRecipients: true, bodyPreview: true,
  hasAttachments: true, sentAt: true, receivedAt: true, createdAt: true, conversationId: true, sendStatus: true, sendError: true,
  account: { select: { id: true, email: true, userId: true, displayName: true } },
  links: { select: { id: true, contactId: true, dealId: true, opportunityId: true, buyerId: true, source: true } },
} as const;

mailRouter.get(
  "/record",
  asyncHandler(async (req: AuthedRequest, res) => {
    const ref = recordRefSchema.parse({ type: req.query.type, id: req.query.id });
    await loadRecord(req, ref);
    const rows = await prisma.emailMessage.findMany({
      where: { organizationId: orgId(req), links: { some: recordColumns(ref) }, OR: [{ sendStatus: null }, { sendStatus: { in: ["SENT", "QUEUED", "SENDING", "FAILED"] } }] },
      select: MAIL_LIST_SELECT, orderBy: { createdAt: "desc" }, take: 200,
    });
    res.json(rows.map((m) => ({ ...m, mine: m.account.userId === req.user!.id, links: m.links.map((l) => ({ id: l.id, record: refOf(l), source: l.source })) })));
  }),
);

/** A filed email's stored body: the mailbox owner, or anyone who can see a record it's filed on. */
mailRouter.get(
  "/stored/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const m = await prisma.emailMessage.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
      select: { ...MAIL_LIST_SELECT, bodyHtml: true, providerMessageId: true },
    });
    if (!m) throw new HttpError(404, "Email not found.");
    const mine = m.account.userId === req.user!.id;
    if (!mine) {
      let visible = false;
      for (const l of m.links) {
        const ref = refOf(l);
        if (ref && (await loadRecord(req, ref).then(() => true, () => false))) { visible = true; break; }
      }
      if (!visible) throw new HttpError(404, "Email not found.");
    }
    res.json({ ...m, mine, providerMessageId: mine ? m.providerMessageId : null, links: m.links.map((l) => ({ id: l.id, record: refOf(l), source: l.source })) });
  }),
);

/** Remove an email from a record (the mailbox owner, or someone who can see the record and send email). */
mailRouter.delete(
  "/links/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const l = await prisma.emailLink.findFirst({ where: { id: req.params.id, organizationId: orgId(req) }, include: { message: { select: { account: { select: { userId: true } } } } } });
    const ref = l ? refOf(l) : null;
    if (!l || !ref) throw new HttpError(404, "Link not found.");
    await loadRecord(req, ref);
    if (l.message.account.userId !== req.user!.id && !hasPermission(req, "manageApiIntegrations")) {
      throw new HttpError(403, "Only the mailbox owner or an administrator can remove an email from a record.");
    }
    await prisma.emailLink.delete({ where: { id: l.id } });
    res.json({ ok: true });
  }),
);

/** Bulk send progress (the sender's own batch). */
mailRouter.get(
  "/outbox",
  asyncHandler(async (req: AuthedRequest, res) => {
    const threadId = z.string().min(1).max(200).parse(req.query.threadId);
    const rows = await prisma.emailMessage.groupBy({
      by: ["sendStatus"], where: { organizationId: orgId(req), createdByUserId: req.user!.id, clientRequestId: { startsWith: `${threadId}:` } }, _count: true,
    });
    const count = (s: string) => rows.find((r) => r.sendStatus === s)?._count ?? 0;
    const failed = await prisma.emailMessage.findMany({
      where: { organizationId: orgId(req), createdByUserId: req.user!.id, clientRequestId: { startsWith: `${threadId}:` }, sendStatus: "FAILED" },
      select: { toRecipients: true, sendError: true }, take: 50,
    });
    res.json({ queued: count("QUEUED") + count("SENDING"), sent: count("SENT"), failed: count("FAILED"), failures: failed });
  }),
);

// ---------------------------------------------------------------------------
// Signatures (owner only)
// ---------------------------------------------------------------------------

async function ownSignature(req: AuthedRequest) {
  const s = await prisma.emailSignature.findFirst({ where: { id: req.params.id, organizationId: orgId(req), account: { userId: req.user!.id } }, include: { assets: true } });
  if (!s) throw new HttpError(404, "Signature not found.");
  return s;
}

mailRouter.get(
  "/signatures/:id/assets/:cid",
  asyncHandler(async (req: AuthedRequest, res) => {
    const s = await ownSignature(req);
    const a = s.assets.find((x) => x.contentId === req.params.cid);
    if (!a) throw new HttpError(404, "Image not found.");
    res.setHeader("Content-Type", a.mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(Buffer.from(a.data));
  }),
);

const sigMetaSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  html: z.string().max(3 * 1024 * 1024).optional(),
  defaultNew: z.boolean().optional(),
  defaultReply: z.boolean().optional(),
});
/** Multipart fields arrive as strings, JSON as booleans; absent stays absent. */
const flag = (v: unknown) => (v === undefined ? undefined : v === true || v === "true");

mailRouter.patch(
  "/signatures/:id",
  writeLimiter,
  multipart(sigUpload, "images"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const s = await ownSignature(req);
    const body = sigMetaSchema.parse({ name: req.body.name, html: req.body.html, defaultNew: flag(req.body.defaultNew), defaultReply: flag(req.body.defaultReply) });
    const images = ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ filename: f.originalname, mimeType: f.mimetype, data: f.buffer }));
    const prepared = body.html !== undefined ? prepareSignature(body.html, images) : { html: s.html, assets: [], missing: [] };
    const saved = await saveSignature({
      id: s.id, orgId: orgId(req), accountId: s.accountId, name: body.name ?? s.name, html: prepared.html, assets: prepared.assets,
      defaultNew: body.defaultNew ?? s.defaultNew, defaultReply: body.defaultReply ?? s.defaultReply,
    });
    res.json({ signature: serializeSignature(saved), missing: prepared.missing });
  }),
);

mailRouter.delete(
  "/signatures/:id",
  writeLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const s = await ownSignature(req);
    await prisma.emailSignature.delete({ where: { id: s.id } });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// The member's own mailbox
// ---------------------------------------------------------------------------

mailRouter.use("/:accountId", requirePermission("sendEmail"), forbidDemo());

mailRouter.get(
  "/:accountId/signatures",
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await loadOwnAccount(orgId(req), req.user!.id, req.params.accountId);
    const rows = await prisma.emailSignature.findMany({ where: { accountId: a.id }, include: { assets: true }, orderBy: { createdAt: "asc" } });
    res.json(rows.map(serializeSignature));
  }),
);

/** Import a signature: pasted HTML (images embedded) or an Outlook .htm with its image files. */
mailRouter.post(
  "/:accountId/signatures",
  writeLimiter,
  multipart(sigUpload, "images"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await loadOwnAccount(orgId(req), req.user!.id, req.params.accountId);
    if (a.provider !== "outlook") throw new HttpError(404, "Connected account not found.");
    const body = sigMetaSchema.extend({ name: z.string().trim().min(1).max(100), html: z.string().min(1).max(3 * 1024 * 1024) })
      .parse({ name: req.body.name, html: req.body.html, defaultNew: flag(req.body.defaultNew) ?? false, defaultReply: flag(req.body.defaultReply) ?? false });
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const images: SignatureImage[] = files.map((f) => ({ filename: f.originalname, mimeType: f.mimetype, data: f.buffer }));
    const prepared = prepareSignature(body.html, images);
    // ?preview=1: show what the import would keep (and which images it can't read) without saving.
    if (req.query.preview === "1") {
      return res.json({ preview: { html: prepared.html, images: prepared.assets.map((x) => ({ contentId: x.contentId, mimeType: x.mimeType, dataUrl: `data:${x.mimeType};base64,${x.data.toString("base64")}` })) }, missing: prepared.missing });
    }
    const first = (await prisma.emailSignature.count({ where: { accountId: a.id } })) === 0;
    const saved = await saveSignature({
      orgId: orgId(req), accountId: a.id, name: body.name, html: prepared.html, assets: prepared.assets,
      // The first signature becomes the default for both unless told otherwise.
      defaultNew: body.defaultNew || first, defaultReply: body.defaultReply || first,
    });
    res.status(201).json({ signature: serializeSignature(saved), missing: prepared.missing });
  }),
);

mailRouter.get(
  "/:accountId/folders",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await listFolders(await mailbox(req)));
  }),
);

mailRouter.get(
  "/:accountId/messages",
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await mailbox(req);
    const folder = typeof req.query.folder === "string" && req.query.folder ? req.query.folder.slice(0, 400) : "inbox";
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor.slice(0, 4000) : null;
    const page = await listMessages(a, { folder, q: q || undefined, unread: req.query.unread === "1", cursor });
    // Which of these are already filed on records (for a small marker in the list).
    const filed = await prisma.emailMessage.findMany({
      where: { accountId: a.id, providerMessageId: { in: page.items.map((i) => i.id) }, links: { some: {} } },
      select: { providerMessageId: true },
    });
    const filedIds = new Set(filed.map((f) => f.providerMessageId));
    res.json({ ...page, items: page.items.map((i) => ({ ...i, filed: filedIds.has(i.id) })) });
  }),
);

mailRouter.get(
  "/:accountId/messages/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await mailbox(req);
    const m = await getMessage(a, req.params.id);
    const stored = await prisma.emailMessage.findUnique({
      where: { accountId_providerMessageId: { accountId: a.id, providerMessageId: m.id } },
      select: { id: true, links: { select: { id: true, contactId: true, dealId: true, opportunityId: true, buyerId: true, source: true } } },
    });
    // An Outlook draft opened for editing: its text without our signature (it's re-added on send).
    const editableHtml = m.isDraft ? stripSignatureBlock(m.bodyHtml) : null;
    const refs = (stored?.links ?? []).map((l) => ({ id: l.id, record: refOf(l), source: l.source }));
    const names = await recordNames(req, refs.map((r) => r.record));
    res.json({ ...m, editableHtml, storedId: stored?.id ?? null, links: refs.map((r) => ({ ...r, name: r.record ? names.get(`${r.record.type}:${r.record.id}`) ?? null : null })) });
  }),
);

mailRouter.get(
  "/:accountId/conversations/:conversationId",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await getConversation(await mailbox(req), req.params.conversationId.slice(0, 400)));
  }),
);

mailRouter.patch(
  "/:accountId/messages/:id",
  writeLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await mailbox(req);
    const body = z.object({ isRead: z.boolean().optional(), folder: z.string().min(1).max(400).optional() }).parse(req.body);
    if (body.isRead !== undefined) await setRead(a, req.params.id, body.isRead);
    const moved = body.folder ? await moveMessage(a, req.params.id, body.folder) : null;
    res.json({ ok: true, message: moved });
  }),
);

/** Delete = move to Deleted Items (recoverable in Outlook), like Outlook's Delete. */
mailRouter.delete(
  "/:accountId/messages/:id",
  writeLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await mailbox(req);
    await moveMessage(a, req.params.id, "deleteditems");
    res.json({ ok: true });
  }),
);

mailRouter.get(
  "/:accountId/messages/:id/attachments/:attId",
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await mailbox(req);
    const att = await attachmentStream(a, req.params.id, req.params.attId);
    const inline = req.query.inline === "1" && /^image\/(png|jpeg|gif|bmp|webp)$/.test(att.contentType);
    res.setHeader("Content-Type", inline ? att.contentType : "application/octet-stream");
    res.setHeader("Content-Disposition", contentDisposition(att.name, inline));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    await new Promise<void>((resolve, reject) => {
      const s = Readable.fromWeb(att.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
      s.on("error", reject);
      res.on("close", () => { s.destroy(); resolve(); });
      s.pipe(res).on("finish", resolve);
    });
  }),
);

/** File an email on records (stores it from the mailbox if it isn't yet). */
mailRouter.post(
  "/:accountId/messages/:id/links",
  writeLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const a = await mailbox(req);
    const { records } = z.object({ records: z.array(recordRefSchema).min(1).max(20) }).parse(req.body);
    for (const r of records) await loadRecord(req, r);
    let msg = await prisma.emailMessage.findUnique({ where: { accountId_providerMessageId: { accountId: a.id, providerMessageId: req.params.id } } });
    if (!msg) {
      const full = await getMessage(a, req.params.id);
      const inbound = !!full.from && full.from.address !== a.email?.toLowerCase();
      msg = await prisma.emailMessage.create({
        data: {
          organizationId: a.organizationId, accountId: a.id, providerMessageId: full.id, internetMessageId: full.internetMessageId, conversationId: full.conversationId,
          direction: inbound ? "in" : "out", folder: null, subject: full.subject, fromAddress: full.from?.address ?? null, fromName: full.from?.name ?? null,
          toRecipients: full.to as never, ccRecipients: full.cc as never, bodyPreview: full.preview.slice(0, 500), bodyHtml: full.bodyHtml,
          hasAttachments: full.hasAttachments, sentAt: full.sentAt ? new Date(full.sentAt) : null, receivedAt: full.receivedAt ? new Date(full.receivedAt) : null,
        },
      });
    }
    await linkEmail(msg, records, "MANUAL", req.user!.id);
    await recordTimeline(msg, a, records.filter((r) => r.type !== "buyer"));
    await logActivity({ eventType: "mail.filed", summary: `Filed an email on ${records.length} record(s)`, organizationId: orgId(req), actorUserId: req.user!.id });
    const links = await prisma.emailLink.findMany({ where: { messageId: msg.id }, select: { id: true, contactId: true, dealId: true, opportunityId: true, buyerId: true, source: true } });
    const names = await recordNames(req, links.map(refOf));
    res.json({ storedId: msg.id, links: links.map((l) => { const r = refOf(l); return { id: l.id, record: r, source: l.source, name: r ? names.get(`${r.type}:${r.id}`) ?? null : null }; }) });
  }),
);

const sendSchema = z.object({
  mode: z.enum(["new", "reply", "replyAll", "forward", "draft"]),
  sourceMessageId: z.string().max(400).nullable().optional(),
  to: addresses, cc: addresses.default([]), bcc: addresses.default([]),
  subject: z.string().max(998).default(""),
  html: z.string().max(1_000_000).default(""),
  signatureId: z.string().max(200).nullable().optional(),
  documentIds: z.array(z.string().max(200)).max(20).default([]),
  links: z.array(recordRefSchema).max(20).default([]),
  clientRequestId: z.string().uuid(),
});

/** Documents the caller can see, read from CRM storage, as attachments. */
async function documentAttachments(req: AuthedRequest, ids: string[]): Promise<OutAttachment[]> {
  if (!ids.length) return [];
  if (!hasPermission(req, "viewDocuments")) throw new HttpError(403, "Your role can't attach documents.");
  if (!s3Configured()) throw new HttpError(503, "Document storage isn't configured on this server.");
  const files = await prisma.fileAttachment.findMany({
    where: { id: { in: ids }, OR: [{ deal: { organizationId: orgId(req) } }, { opportunity: { organizationId: orgId(req) } }, { buyer: { organizationId: orgId(req) } }] },
  });
  if (files.length !== new Set(ids).size) throw new HttpError(404, "A document to attach wasn't found.");
  // The per-email cap is checked on the stored sizes BEFORE anything is read:
  // 20 documents of 25 MB each were buffered in full (500 MB) before the send
  // path rejected the total. Each read then gets what is left of the budget.
  const planned = files.reduce((n, f) => n + f.sizeBytes, 0);
  if (planned > MAX_ATTACHMENTS_BYTES) throw new HttpError(413, `Attachments are limited to ${MAX_ATTACHMENTS_BYTES / 1024 / 1024} MB per email.`);
  let budget = MAX_ATTACHMENTS_BYTES;
  const out: OutAttachment[] = [];
  for (const f of files) {
    const ref: RecordRef = f.dealId ? { type: "deal", id: f.dealId } : f.opportunityId ? { type: "opportunity", id: f.opportunityId } : { type: "buyer", id: f.buyerId! };
    await loadRecord(req, ref);
    const bytes = await getObjectBytes(f.s3Key, budget);
    budget -= bytes.length;
    out.push({ name: f.filename, contentType: f.mimeType, size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) });
  }
  return out;
}

function diskAttachment(f: Express.Multer.File): OutAttachment {
  return {
    name: f.originalname.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) || "attachment",
    contentType: f.mimetype || "application/octet-stream",
    size: f.size,
    async read(offset, length) {
      const fh = await fs.promises.open(f.path, "r");
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      } finally { await fh.close(); }
    },
  };
}

/** Send (new, reply, reply all, forward, or an Outlook draft) from the member's mailbox. */
mailRouter.post(
  "/:accountId/send",
  sendLimiter,
  multipart(sendUpload, "files"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    try {
      const a = await mailbox(req);
      const raw = typeof req.body.payload === "string" ? JSON.parse(req.body.payload) : req.body;
      const p = sendSchema.parse(raw);
      for (const r of p.links) await loadRecord(req, r);
      const attachments = [...(await documentAttachments(req, p.documentIds)), ...files.map(diskAttachment)];
      const sent = await sendEmailNow({
        account: a, userId: req.user!.id, mode: p.mode, sourceMessageId: p.sourceMessageId ?? null,
        to: p.to as Address[], cc: p.cc as Address[], bcc: p.bcc as Address[], subject: p.subject, html: p.html,
        signatureId: p.signatureId, attachments, links: p.links, clientRequestId: p.clientRequestId,
      });
      await logActivity({
        eventType: "mail.sent", summary: `${req.user!.name} sent an email from ${a.email ?? "Outlook"} to ${p.to.length + p.cc.length + p.bcc.length} recipient(s)`,
        organizationId: orgId(req), actorUserId: req.user!.id, metadata: { emailMessageId: sent.id },
      });
      res.json({ ok: true, id: sent.id, sentAt: sent.sentAt });
    } finally {
      for (const f of files) await fs.promises.unlink(f.path).catch(() => {});
    }
  }),
);

/** Suggested recipients: contacts and buyers matching a name or address. */
mailRouter.get(
  "/:accountId/recipients",
  asyncHandler(async (req: AuthedRequest, res) => {
    await loadOwnAccount(orgId(req), req.user!.id, req.params.accountId);
    const q = String(req.query.q ?? "").trim().slice(0, 100);
    if (q.length < 2) return res.json([]);
    const has = { contains: q, mode: "insensitive" as const };
    const out: { name: string; address: string; kind: string }[] = [];
    if (hasPermission(req, "viewContacts")) {
      for (const c of await prisma.contact.findMany({ where: { organizationId: orgId(req), email: { not: null }, OR: [{ firstName: has }, { lastName: has }, { entityName: has }, { email: has }] }, select: { firstName: true, lastName: true, email: true }, take: 8 })) {
        out.push({ name: `${c.firstName} ${c.lastName}`.trim(), address: c.email!.toLowerCase(), kind: "Contact" });
      }
    }
    if (hasPermission(req, "viewBuyers")) {
      for (const b of await prisma.buyer.findMany({ where: { organizationId: orgId(req), email: { not: null }, OR: [{ name: has }, { companyName: has }, { email: has }] }, select: { name: true, email: true }, take: 8 })) {
        out.push({ name: b.name, address: b.email!.toLowerCase(), kind: "Buyer" });
      }
    }
    res.json(out);
  }),
);

// Provider failures become clear statuses (409 reconnect, 403, 404, 429, 503).
mailRouter.use((err: unknown, _req: Request, _res: Response, next: NextFunction) => {
  if (err instanceof ProviderError) return next(new HttpError(err.httpStatus, err.message));
  next(err);
});

