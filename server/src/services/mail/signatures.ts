/**
 * Outlook signatures in the CRM.
 *
 * Microsoft Graph has no API that returns a user's Outlook signature (roaming
 * signatures live in a store Graph doesn't expose, and classic Outlook keeps
 * them as local files), so signatures are IMPORTED ONCE and then managed here
 * — never claimed to sync. Two import routes keep the original exactly:
 *
 *  1. Paste: copy the signature in Outlook (Settings → Signatures, or the
 *     signature in a sent email) and paste it in the CRM. The clipboard HTML
 *     keeps fonts, colors, spacing, links and tables; images arrive as
 *     embedded data, which becomes inline attachments here.
 *  2. Upload: classic Outlook's signature files — the .htm and its
 *     "<name>_files" images (%APPDATA%\Microsoft\Signatures on Windows,
 *     ~/Library/Group Containers/UBF8T346G9.Office/Outlook/… on Mac).
 *
 * Images are stored with the signature and sent as INLINE attachments
 * (cid:), the way Outlook embeds them, so recipients see the logo without
 * "download pictures"; https images stay linked as Outlook would leave them.
 * Each connected mailbox has its own signatures with one default for new
 * messages and one for replies/forwards.
 */
import crypto from "node:crypto";
import type { EmailSignature, EmailSignatureAsset } from "@prisma/client";
import { prisma } from "../../db.js";
import { HttpError } from "../../middleware/errors.js";
import { sanitizeSignature } from "./html.js";

export const MAX_ASSET_BYTES = 1024 * 1024;
export const MAX_SIGNATURE_BYTES = 3 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp"]);

export interface SignatureImage { filename: string; mimeType: string; data: Buffer }

interface PreparedAsset { contentId: string; filename: string; mimeType: string; data: Buffer }

function sniffImage(buf: Buffer): string | null {
  const h = buf.subarray(0, 12).toString("hex");
  if (h.startsWith("89504e47")) return "image/png";
  if (h.startsWith("ffd8ff")) return "image/jpeg";
  if (h.startsWith("47494638")) return "image/gif";
  if (h.startsWith("424d")) return "image/bmp";
  if (h.startsWith("52494646") && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

const cid = () => `sig-${crypto.randomUUID()}@mineralhub`;

/**
 * Turn imported HTML + images into stored form: embedded (data:) images and
 * images referenced by file name (an uploaded .htm's "_files" folder) become
 * cid: assets. Local file paths that weren't uploaded are reported so the
 * member can add them.
 */
export function prepareSignature(rawHtml: string, uploads: readonly SignatureImage[]): { html: string; assets: PreparedAsset[]; missing: string[] } {
  const assets: PreparedAsset[] = [];
  const missing: string[] = [];
  const byName = new Map(uploads.map((u) => [u.filename.toLowerCase(), u]));
  const html = rawHtml.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (whole, pre: string, q: string, src: string) => {
    const data = src.match(/^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (data) {
      const buf = Buffer.from(data[2].replace(/\s+/g, ""), "base64");
      const type = sniffImage(buf);
      if (!type || buf.length > MAX_ASSET_BYTES) { missing.push("an embedded image (too large or not an image)"); return `${pre}${q}${q}`; }
      const id = cid();
      assets.push({ contentId: id, filename: `image${assets.length + 1}.${type.split("/")[1]}`, mimeType: type, data: buf });
      return `${pre}${q}cid:${id}${q}`;
    }
    if (/^https:\/\//i.test(src)) return whole;
    if (/^cid:/i.test(src)) return whole;
    // file:///…, "Name_files/image001.png", a bare file name: match an upload by name.
    const name = decodeURIComponent(src.split(/[\\/]/).pop() ?? "").toLowerCase();
    const up = byName.get(name);
    if (up) {
      const type = sniffImage(up.data);
      if (!type || !IMAGE_TYPES.has(type) || up.data.length > MAX_ASSET_BYTES) { missing.push(up.filename); return `${pre}${q}${q}`; }
      const id = cid();
      assets.push({ contentId: id, filename: up.filename, mimeType: type, data: up.data });
      return `${pre}${q}cid:${id}${q}`;
    }
    missing.push(name || src.slice(0, 80));
    return `${pre}${q}${q}`;
  });
  const clean = sanitizeSignature(html);
  const total = Buffer.byteLength(clean) + assets.reduce((n, a) => n + a.data.length, 0);
  if (total > MAX_SIGNATURE_BYTES) throw new HttpError(413, "That signature is larger than 3 MB with its images. Use smaller images.");
  if (!clean.replace(/<[^>]+>/g, "").trim() && !assets.length && !/<img/i.test(clean)) throw new HttpError(400, "That signature is empty after import.");
  // Only keep assets the sanitized HTML still references.
  return { html: clean, assets: assets.filter((a) => clean.includes(`cid:${a.contentId}`)), missing };
}

export type SignatureWithAssets = EmailSignature & { assets: EmailSignatureAsset[] };

/** Save (create or replace) a signature and its images; keep one default per kind per mailbox. */
export async function saveSignature(p: {
  id?: string; orgId: string; accountId: string; name: string; html: string; assets: PreparedAsset[]; defaultNew: boolean; defaultReply: boolean;
}): Promise<SignatureWithAssets> {
  return prisma.$transaction(async (tx) => {
    if (p.defaultNew) await tx.emailSignature.updateMany({ where: { accountId: p.accountId, defaultNew: true, ...(p.id ? { id: { not: p.id } } : {}) }, data: { defaultNew: false } });
    if (p.defaultReply) await tx.emailSignature.updateMany({ where: { accountId: p.accountId, defaultReply: true, ...(p.id ? { id: { not: p.id } } : {}) }, data: { defaultReply: false } });
    const data = { name: p.name, html: p.html, defaultNew: p.defaultNew, defaultReply: p.defaultReply };
    const sig = p.id
      ? await tx.emailSignature.update({ where: { id: p.id }, data })
      : await tx.emailSignature.create({ data: { ...data, organizationId: p.orgId, accountId: p.accountId } });
    // Images the HTML no longer references go; ones it still references
    // (an edit that kept them) and newly imported ones stay.
    const keep = new Set([...referencedCids(p.html), ...p.assets.map((a) => a.contentId)]);
    if (p.id) await tx.emailSignatureAsset.deleteMany({ where: { signatureId: sig.id, contentId: { notIn: [...keep] } } });
    {
      for (const a of p.assets) {
        await tx.emailSignatureAsset.upsert({
          where: { signatureId_contentId: { signatureId: sig.id, contentId: a.contentId } },
          create: { signatureId: sig.id, contentId: a.contentId, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.data.length, data: a.data },
          update: {},
        });
      }
    }
    return tx.emailSignature.findUniqueOrThrow({ where: { id: sig.id }, include: { assets: true } });
  });
}

/** Ids of the assets a signature's HTML still references (an edit that keeps images). */
export function referencedCids(html: string): string[] {
  return [...html.matchAll(/cid:([^"'\s)>]+)/gi)].map((m) => m[1]);
}

export function serializeSignature(s: SignatureWithAssets) {
  return {
    id: s.id, accountId: s.accountId, name: s.name, html: s.html, defaultNew: s.defaultNew, defaultReply: s.defaultReply,
    images: s.assets.map((a) => ({ contentId: a.contentId, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
    updatedAt: s.updatedAt,
  };
}

/** The signature a message should use: the explicit choice, else the mailbox default for its kind. */
export async function pickSignature(accountId: string, chosen: string | null | undefined, kind: "new" | "reply"): Promise<SignatureWithAssets | null> {
  if (chosen === null) return null; // explicitly "no signature"
  if (chosen) {
    const s = await prisma.emailSignature.findFirst({ where: { id: chosen, accountId }, include: { assets: true } });
    if (!s) throw new HttpError(400, "That signature doesn't belong to the sending mailbox.");
    return s;
  }
  return prisma.emailSignature.findFirst({ where: { accountId, ...(kind === "new" ? { defaultNew: true } : { defaultReply: true }) }, include: { assets: true } });
}
