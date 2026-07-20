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

/** Lightweight magic-byte sniff so we don't trust the client's mimetype. */
export function sniffMime(buf: Buffer, fallback: string): string {
  if (buf.length >= 4) {
    const hex = buf.subarray(0, 4).toString("hex");
    if (hex === "25504446") return "application/pdf"; // %PDF
    if (hex.startsWith("89504e47")) return "image/png";
    if (hex.startsWith("ffd8ff")) return "image/jpeg";
    if (hex === "49492a00" || hex === "4d4d002a") return "image/tiff";
    if (hex.startsWith("47494638")) return "image/gif";
    if (hex === "504b0304") {
      // zip-based (docx/xlsx) — trust the declared office type if it's one we allow
      return fallback;
    }
  }
  return fallback;
}
