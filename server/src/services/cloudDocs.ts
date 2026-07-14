/**
 * Cloud document import — Google Drive + OneDrive.
 *
 * The integrations page connects the account; this service does the real work:
 * browse/search the user's files and IMPORT a chosen file into the app's own
 * document manager (download from the provider → same mime-sniff/size checks
 * as a direct upload → S3 → FileAttachment row). Importing rather than
 * linking keeps every deal document inside the app's permission and
 * buyer-portal-visibility model, and files survive the cloud original moving.
 *
 * Google-native files (Docs/Sheets/Slides) have no raw bytes; they are
 * exported as PDF, which is what a deal room wants anyway.
 */
import type { Integration } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../config.js";
import { HttpError } from "../middleware/errors.js";
import { getFreshAccessToken } from "./integrationOAuth.js";
import { buildKey, putObject, isAllowedMime, sniffMime, s3Configured } from "./s3.js";

export interface CloudFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null; // null for Google-native files (size known after export)
  modifiedAt: string | null;
}

const PAGE_SIZE = 25;

export function isImportProvider(key: string): boolean {
  return key === "googledrive" || key === "onedrive";
}

const GOOGLE_EXPORTABLE = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
]);

async function providerJson(url: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as { message?: string };
    throw new HttpError(502, `Provider API returned ${res.status}${err.message ? `: ${err.message}` : ""}`);
  }
  return json;
}

// --- Listing -------------------------------------------------------------------

async function listDrive(token: string, q: string): Promise<CloudFile[]> {
  // Folders excluded; shortcuts excluded (their targets appear separately).
  const filters = ["mimeType != 'application/vnd.google-apps.folder'", "trashed = false"];
  if (q) filters.push(`name contains '${q.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);
  const params = new URLSearchParams({
    q: filters.join(" and "),
    orderBy: "modifiedTime desc",
    pageSize: String(PAGE_SIZE),
    fields: "files(id,name,mimeType,size,modifiedTime)",
  });
  const json = await providerJson(`https://www.googleapis.com/drive/v3/files?${params}`, token);
  const files = (json.files ?? []) as { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }[];
  return files
    .filter((f) => !f.mimeType.startsWith("application/vnd.google-apps.") || GOOGLE_EXPORTABLE.has(f.mimeType))
    .map((f) => ({
      id: f.id,
      name: GOOGLE_EXPORTABLE.has(f.mimeType) ? `${f.name}.pdf` : f.name,
      mimeType: GOOGLE_EXPORTABLE.has(f.mimeType) ? "application/pdf" : f.mimeType,
      sizeBytes: f.size != null ? Number(f.size) : null,
      modifiedAt: f.modifiedTime ?? null,
    }));
}

async function listOneDrive(token: string, q: string): Promise<CloudFile[]> {
  const select = "$select=id,name,size,file,lastModifiedDateTime";
  const url = q
    ? `https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(q.replace(/'/g, "''"))}')?$top=${PAGE_SIZE}&${select}`
    : `https://graph.microsoft.com/v1.0/me/drive/root/children?$top=${PAGE_SIZE}&$orderby=lastModifiedDateTime desc&${select}`;
  const json = await providerJson(url, token);
  const rows = (json.value ?? []) as { id: string; name: string; size?: number; lastModifiedDateTime?: string; file?: { mimeType?: string } }[];
  return rows
    .filter((r) => r.file) // folders have no `file` facet
    .map((r) => ({
      id: r.id,
      name: r.name,
      mimeType: r.file?.mimeType ?? "application/octet-stream",
      sizeBytes: r.size ?? null,
      modifiedAt: r.lastModifiedDateTime ?? null,
    }));
}

export async function listProviderFiles(row: Integration, q: string): Promise<CloudFile[]> {
  const token = await getFreshAccessToken(row);
  return row.provider === "googledrive" ? listDrive(token, q) : listOneDrive(token, q);
}

// --- Import ----------------------------------------------------------------------

async function downloadBytes(url: string, token: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new HttpError(502, `Provider download failed (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > env.MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `File exceeds the ${Math.round(env.MAX_UPLOAD_BYTES / (1024 * 1024))} MB import limit.`);
  }
  return buf;
}

interface DriveMeta { name: string; mimeType: string; size: number | null }

async function driveMeta(token: string, fileId: string): Promise<DriveMeta> {
  const json = await providerJson(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType,size`,
    token,
  );
  return { name: String(json.name ?? "file"), mimeType: String(json.mimeType ?? "application/octet-stream"), size: json.size != null ? Number(json.size) : null };
}

export interface ImportParams {
  fileId: string;
  dealId: string | null;
  buyerId: string | null;
  folder: string;
  uploadedByUserId: string | null;
}

export interface ImportedRecord { id: string; filename: string; folder: string; sizeBytes: number }

export async function importProviderFile(row: Integration, p: ImportParams): Promise<ImportedRecord> {
  if (!s3Configured()) {
    throw new HttpError(503, "Object storage is not configured — imports need S3_* variables on the API service (see the Object storage integration).");
  }
  const token = await getFreshAccessToken(row);

  let filename: string;
  let declaredMime: string;
  let bytes: Buffer;

  if (row.provider === "googledrive") {
    const meta = await driveMeta(token, p.fileId);
    if (GOOGLE_EXPORTABLE.has(meta.mimeType)) {
      filename = `${meta.name}.pdf`;
      declaredMime = "application/pdf";
      bytes = await downloadBytes(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(p.fileId)}/export?mimeType=application%2Fpdf`,
        token,
      );
    } else {
      if (meta.size != null && meta.size > env.MAX_UPLOAD_BYTES) {
        throw new HttpError(413, `File exceeds the ${Math.round(env.MAX_UPLOAD_BYTES / (1024 * 1024))} MB import limit.`);
      }
      filename = meta.name;
      declaredMime = meta.mimeType;
      bytes = await downloadBytes(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(p.fileId)}?alt=media`, token);
    }
  } else {
    const meta = await providerJson(
      `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(p.fileId)}?$select=name,size,file`,
      token,
    );
    const size = typeof meta.size === "number" ? meta.size : null;
    if (size != null && size > env.MAX_UPLOAD_BYTES) {
      throw new HttpError(413, `File exceeds the ${Math.round(env.MAX_UPLOAD_BYTES / (1024 * 1024))} MB import limit.`);
    }
    filename = String(meta.name ?? "file");
    declaredMime = String((meta.file as { mimeType?: string } | undefined)?.mimeType ?? "application/octet-stream");
    bytes = await downloadBytes(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(p.fileId)}/content`, token);
  }

  // Same gate as a direct upload: sniff the real type, allow-list it.
  const detected = sniffMime(bytes, declaredMime);
  if (!isAllowedMime(detected)) {
    throw new HttpError(400, `"${filename}" (${detected}) is not an allowed document type.`);
  }

  const key = buildKey(p.dealId ? "deal" : "buyer", (p.dealId ?? p.buyerId)!, filename);
  await putObject(key, bytes, detected);
  const record = await prisma.fileAttachment.create({
    data: {
      dealId: p.dealId, buyerId: p.buyerId, folder: p.folder,
      filename, mimeType: detected, sizeBytes: bytes.length, s3Key: key,
      uploadedByUserId: p.uploadedByUserId,
    },
  });
  return { id: record.id, filename: record.filename, folder: record.folder, sizeBytes: record.sizeBytes };
}
