/**
 * File-safety rules shared by every cloud operation: names, ids, types, sizes.
 *
 *  - Names: no path separators, control characters, or the characters
 *    OneDrive rejects; no leading/trailing dots or spaces; no reserved
 *    Windows device names; at most 200 characters. A name can never climb
 *    out of its folder ("../x" becomes "x").
 *  - Ids: provider item ids are opaque but only ever contain URL-safe
 *    characters; anything else is refused before it reaches a URL or query.
 *  - Uploads: the Documents module's type allow-list (magic-byte sniffed —
 *    never the browser's word) plus PowerPoint, which Drive and OneDrive are
 *    commonly used for. Content-Disposition names are header-safe.
 */
import { HttpError } from "../../middleware/errors.js";
import { isAllowedMime, sniffMime } from "../s3.js";

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A provider-safe file or folder name, or a 400 when nothing usable is left. */
export function safeCloudName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  let name = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["*:<>?|#%]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (name.length > 200) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, 200 - ext.length).trimEnd() + ext;
  }
  if (!name || RESERVED.test(name)) throw new HttpError(400, "That name isn't allowed. Use letters, numbers and ordinary punctuation.");
  return name;
}

/** Opaque provider ids: letters, digits and - _ . ! (OneDrive uses "!"). */
export function safeItemId(id: string): string {
  if (!/^[A-Za-z0-9_.!-]{1,300}$/.test(id)) throw new HttpError(400, "Invalid item id.");
  return id;
}

/** Escape a value for a Google Drive `q` string literal. */
export function driveQ(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PPT = "application/vnd.ms-powerpoint";

/**
 * The real type of an upload from its first bytes (the Documents allow-list,
 * plus PowerPoint by its container signature), or a 400.
 */
export function checkUploadType(head: Buffer, declared: string, filename: string): string {
  const hex = head.subarray(0, 4).toString("hex");
  if (declared === PPTX && hex === "504b0304") return PPTX;
  if (declared === PPT && hex === "d0cf11e0") return PPT;
  const detected = sniffMime(head, declared);
  if (!isAllowedMime(detected)) {
    throw new HttpError(400, `"${filename}" isn't an allowed type. Upload PDF, Word, Excel, PowerPoint, images (PNG, JPEG, TIFF, GIF), text or CSV.`);
  }
  return detected;
}

/** Content-Disposition for a download: ASCII fallback + RFC 5987 UTF-8 name. */
export function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Largest file the CRM passes through to a drive (env CLOUD_UPLOAD_MAX_MB, default 250 MB). */
export const CLOUD_UPLOAD_MAX_BYTES = Math.max(1, Number(process.env.CLOUD_UPLOAD_MAX_MB) || 250) * 1024 * 1024;
