import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";
import { env } from "../config.js";

const configured = Boolean(env.S3.BUCKET && env.S3.ACCESS_KEY_ID && env.S3.SECRET_ACCESS_KEY);

const client = configured
  ? new S3Client({
      region: env.S3.REGION,
      endpoint: env.S3.ENDPOINT,
      forcePathStyle: env.S3.FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3.ACCESS_KEY_ID,
        secretAccessKey: env.S3.SECRET_ACCESS_KEY,
      },
    })
  : null;

export function s3Configured(): boolean {
  return configured;
}

export function buildKey(scope: "deal" | "buyer", id: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${scope}/${id}/${crypto.randomUUID()}-${safe}`;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (!client) throw new Error("S3 is not configured");
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3.BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Signed, expiring download URL — never expose public links. `inline` serves
 *  the object for in-browser preview (PDF/image) instead of forcing a download. */
export async function getDownloadUrl(key: string, filename?: string, inline = false): Promise<string> {
  if (!client) throw new Error("S3 is not configured");
  // Strip quotes/backslashes/control chars from the filename before it goes in
  // the quoted Content-Disposition value, so a crafted stored filename can't
  // break out of the quotes and inject header directives.
  const safeName = filename?.replace(/[\r\n"\\]/g, "_");
  const disposition = safeName ? `${inline ? "inline" : "attachment"}; filename="${safeName}"` : undefined;
  const cmd = new GetObjectCommand({
    Bucket: env.S3.BUCKET,
    Key: key,
    ResponseContentDisposition: disposition,
  });
  return getSignedUrl(client, cmd, { expiresIn: env.S3.SIGNED_URL_TTL_SECONDS });
}

export async function deleteObject(key: string): Promise<void> {
  if (!client) return;
  await client.send(new DeleteObjectCommand({ Bucket: env.S3.BUCKET, Key: key }));
}

/** Server-side mime allow-list — never trust the client-reported type. */
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/gif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
]);

export function isAllowedMime(detected: string): boolean {
  return ALLOWED_MIME.has(detected);
}

// Types with no magic bytes to check, where the declared type is all we have.
// Both are inert: they're stored and served with a concrete text/* Content-Type,
// so a browser won't parse them as HTML even if the bytes happen to look like it.
const SNIFFLESS_MIME = new Set(["text/plain", "text/csv"]);

/**
 * Heuristic "is this plain text?": no NUL bytes and no C0 control characters
 * beyond the usual whitespace. Every binary format we accept is identified by a
 * signature well before this runs, so it only ever adjudicates signature-less
 * payloads.
 */
function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return false;
  }
  return true;
}

// Declared types we accept behind a zip (PK\x03\x04) header — the OOXML office
// formats. Anything else claiming to be a zip is rejected rather than waved
// through on the client's word.
const ZIP_BACKED_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/**
 * Lightweight magic-byte sniff so we don't trust the client's mimetype.
 *
 * Returns the DETECTED type when the bytes identify one, and otherwise falls
 * back to the declared type only in the two cases where that's defensible:
 * a zip header with an OOXML declaration, or a format that has no signature to
 * check. Every other unrecognized payload returns "application/octet-stream",
 * which isAllowedMime rejects — so a file can no longer smuggle arbitrary
 * content through by simply declaring a permitted type.
 */
export function sniffMime(buf: Buffer, fallback: string): string {
  if (buf.length >= 4) {
    const hex = buf.subarray(0, 4).toString("hex");
    if (hex === "25504446") return "application/pdf"; // %PDF
    if (hex.startsWith("89504e47")) return "image/png";
    if (hex.startsWith("ffd8ff")) return "image/jpeg";
    if (hex === "49492a00" || hex === "4d4d002a") return "image/tiff";
    if (hex.startsWith("47494638")) return "image/gif";
    if (hex === "504b0304") {
      // zip-based container: only the office formats we allow may claim it.
      return ZIP_BACKED_MIME.has(fallback) ? fallback : "application/octet-stream";
    }
    // Legacy .doc/.xls (OLE2 compound file) share one signature, so the
    // declared type picks between them.
    if (hex === "d0cf11e0") {
      return fallback === "application/msword" || fallback === "application/vnd.ms-excel"
        ? fallback
        : "application/octet-stream";
    }
  }
  if (SNIFFLESS_MIME.has(fallback)) return fallback;
  // Windows browsers routinely report a .csv as application/vnd.ms-excel. A real
  // .xls is OLE2 and was matched above, so anything still claiming Excel here is
  // signature-less — if it reads as text, treat it as the CSV it almost certainly
  // is. This is a downgrade to an inert type, never an escalation.
  if (fallback === "application/vnd.ms-excel" && looksLikeText(buf)) return "text/csv";
  return "application/octet-stream";
}
