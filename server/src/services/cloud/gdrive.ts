/**
 * Google Drive through the Drive API v3 (the member's Drive, `drive` scope —
 * Workspace-internal app).
 *
 *  - Views: My Drive, Shared with me, and the Workspace's shared drives;
 *    supportsAllDrives everywhere so shared-drive files behave like any other.
 *  - Google Docs / Sheets / Slides have no bytes of their own: they download
 *    through Drive's export (PDF or the matching Office format, CSV/TXT where
 *    offered). Export is capped by Google at 10 MB.
 *  - Permissions and ownership are Google's: nothing here changes sharing.
 *    Each item carries Drive's own capabilities (canRename, canTrash, …) and
 *    the UI offers only what they allow.
 *  - Delete moves to the Drive trash (recoverable), never a permanent delete.
 *  - Drive allows duplicate names, so "fail on conflict" is enforced here by
 *    checking the target folder first; "rename" picks a free "name (n)".
 *  - Uploads use a resumable session in 8 MiB chunks (a multiple of 256 KiB).
 *  - Changes: the Drive changes feed from a start page token.
 *  - Ids and search terms are validated/escaped before going into a query.
 */
import type { ConnectedAccount } from "@prisma/client";
import { providerFetch, providerJson, ProviderError, backoffMs, sleep, accessToken } from "../connected/client.js";
import { driveQ, safeItemId } from "./safety.js";
import type { ChangesResult, CloudDriver, CloudItem, CloudKind, CloudPage, CloudView, ConflictPolicy, DownloadResult, ExportFormat, UploadSource } from "./types.js";

const D = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const ALL = "supportsAllDrives=true";
const FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink,parents,trashed,driveId,owners(displayName),lastModifyingUser(displayName),capabilities(canEdit,canRename,canTrash,canDownload,canMoveItemWithinDrive),shortcutDetails(targetId,targetMimeType)";
const FOLDER = "application/vnd.google-apps.folder";
const CHUNK = 8 * 1024 * 1024;

const NATIVE: Record<string, { kind: CloudKind; exports: ExportFormat[] }> = {
  "application/vnd.google-apps.document": { kind: "google-doc", exports: ["pdf", "docx", "txt"] },
  "application/vnd.google-apps.spreadsheet": { kind: "google-sheet", exports: ["pdf", "xlsx", "csv"] },
  "application/vnd.google-apps.presentation": { kind: "google-slides", exports: ["pdf", "pptx"] },
};

export const EXPORT_MIME: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
};

interface DriveFile {
  id: string; name?: string; mimeType?: string; size?: string; modifiedTime?: string; webViewLink?: string;
  parents?: string[]; trashed?: boolean; driveId?: string;
  owners?: { displayName?: string }[]; lastModifyingUser?: { displayName?: string };
  capabilities?: { canEdit?: boolean; canRename?: boolean; canTrash?: boolean; canDownload?: boolean; canMoveItemWithinDrive?: boolean };
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

export function driveItem(f: DriveFile): CloudItem {
  const mime = f.mimeType ?? "application/octet-stream";
  const isFolder = mime === FOLDER;
  const native = NATIVE[mime];
  const kind: CloudKind = isFolder ? "folder" : native ? native.kind : mime.startsWith("application/vnd.google-apps.") ? "google-other" : "file";
  const caps = f.capabilities ?? {};
  return {
    id: f.id,
    name: f.name ?? "(untitled)",
    kind,
    isFolder,
    mimeType: mime,
    sizeBytes: f.size != null ? Number(f.size) : null,
    modifiedAt: f.modifiedTime ?? null,
    modifiedBy: f.lastModifyingUser?.displayName ?? null,
    webUrl: f.webViewLink ?? null,
    parentId: f.parents?.[0] ?? null,
    driveId: f.driveId ?? null,
    etag: null,
    owner: f.owners?.[0]?.displayName ?? null,
    canEdit: !!caps.canEdit,
    canRename: !!caps.canRename,
    canDelete: !!caps.canTrash,
    canDownload: !isFolder && kind !== "google-other" && caps.canDownload !== false,
    exportFormats: native?.exports ?? [],
  };
}

function id(v: string): string {
  return v === "root" ? v : safeItemId(v);
}

async function filesPage(a: ConnectedAccount, params: Record<string, string>): Promise<CloudPage> {
  const qs = new URLSearchParams({ pageSize: "100", fields: `nextPageToken,files(${FIELDS})`, supportsAllDrives: "true", includeItemsFromAllDrives: "true", ...params });
  const j = await providerJson<{ files?: DriveFile[]; nextPageToken?: string }>(a, `${D}/files?${qs}`);
  // Shortcuts point elsewhere; the browser shows real files and folders.
  const items = (j.files ?? []).filter((f) => f.mimeType !== "application/vnd.google-apps.shortcut").map(driveItem);
  return { items, cursor: j.nextPageToken ?? null };
}

async function nameTaken(a: ConnectedAccount, parentId: string | null, name: string): Promise<boolean> {
  const p = await filesPage(a, {
    q: `name = '${driveQ(name)}' and '${id(parentId ?? "root")}' in parents and trashed = false`,
    corpora: "allDrives", pageSize: "1",
  });
  return p.items.length > 0;
}

async function freeName(a: ConnectedAccount, parentId: string | null, name: string, conflict: ConflictPolicy): Promise<string> {
  if (!(await nameTaken(a, parentId, name))) return name;
  if (conflict === "fail") throw new ProviderError("Google Drive already has an item with that name in this folder.", "conflict", 409);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; n < 50; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!(await nameTaken(a, parentId, candidate))) return candidate;
  }
  throw new ProviderError("Couldn't find a free name in that folder.", "conflict", 409);
}

export const googleDrive: CloudDriver = {
  async list(a, folderId, cursor, view: CloudView) {
    const pageToken: Record<string, string> = cursor ? { pageToken: cursor } : {};
    if (!folderId && view === "drives") {
      const qs = new URLSearchParams({ pageSize: "100", ...(cursor ? { pageToken: cursor } : {}) });
      const j = await providerJson<{ drives?: { id: string; name: string }[]; nextPageToken?: string }>(a, `${D}/drives?${qs}`);
      return {
        items: (j.drives ?? []).map((d) => ({ ...driveItem({ id: d.id, name: d.name, mimeType: FOLDER, capabilities: { canRename: false, canTrash: false } }), driveId: d.id })),
        cursor: j.nextPageToken ?? null,
      };
    }
    if (!folderId && view === "shared") {
      return filesPage(a, { q: "sharedWithMe = true and trashed = false", orderBy: "folder,name", ...pageToken });
    }
    return filesPage(a, { q: `'${id(folderId ?? "root")}' in parents and trashed = false`, orderBy: "folder,name", corpora: "allDrives", ...pageToken });
  },

  async search(a, q, cursor) {
    const t = driveQ(q);
    // fullText search can't be combined with orderBy.
    return filesPage(a, { q: `(name contains '${t}' or fullText contains '${t}') and trashed = false`, corpora: "allDrives", ...(cursor ? { pageToken: cursor } : {}) });
  },

  async get(a, fileId) {
    return driveItem(await providerJson<DriveFile>(a, `${D}/files/${encodeURIComponent(id(fileId))}?fields=${encodeURIComponent(FIELDS)}&${ALL}`));
  },

  async createFolder(a, parentId, name) {
    const finalName = await freeName(a, parentId, name, "fail");
    const f = await providerJson<DriveFile>(a, `${D}/files?fields=${encodeURIComponent(FIELDS)}&${ALL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: finalName, mimeType: FOLDER, parents: [id(parentId ?? "root")] }),
    });
    return driveItem(f);
  },

  async rename(a, fileId, name) {
    const cur = await googleDrive.get(a, fileId);
    if (!cur.canRename) throw new ProviderError("Google Drive doesn't let you rename this item.", "permission", 403);
    if (name !== cur.name) await freeName(a, cur.parentId, name, "fail");
    const f = await providerJson<DriveFile>(a, `${D}/files/${encodeURIComponent(id(fileId))}?fields=${encodeURIComponent(FIELDS)}&${ALL}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    return driveItem(f);
  },

  async move(a, fileId, parentId) {
    const cur = await providerJson<DriveFile>(a, `${D}/files/${encodeURIComponent(id(fileId))}?fields=parents,name,capabilities(canMoveItemWithinDrive)&${ALL}`);
    if (cur.capabilities?.canMoveItemWithinDrive === false) throw new ProviderError("Google Drive doesn't let you move this item.", "permission", 403);
    const target = id(parentId ?? "root");
    await freeName(a, target, cur.name ?? "", "fail");
    const qs = new URLSearchParams({ addParents: target, removeParents: (cur.parents ?? []).join(","), fields: FIELDS, supportsAllDrives: "true" });
    const f = await providerJson<DriveFile>(a, `${D}/files/${encodeURIComponent(id(fileId))}?${qs}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    return driveItem(f);
  },

  async trash(a, fileId) {
    await providerFetch(a, `${D}/files/${encodeURIComponent(id(fileId))}?${ALL}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }),
    });
  },

  async download(a, fileId, format): Promise<DownloadResult> {
    const meta = await googleDrive.get(a, fileId);
    if (meta.isFolder || meta.kind === "google-other") throw new ProviderError("This item can't be downloaded.", "invalid");
    if (!meta.canDownload) throw new ProviderError("The owner doesn't allow downloading this file.", "permission", 403);
    if (meta.exportFormats.length) {
      const fmt = format && meta.exportFormats.includes(format) ? format : "pdf";
      const res = await providerFetch(a, `${D}/files/${encodeURIComponent(id(fileId))}/export?mimeType=${encodeURIComponent(EXPORT_MIME[fmt])}`, { timeoutMs: 120_000 });
      if (!res.body) throw new ProviderError("Google Drive export returned nothing.", "unavailable");
      return { body: res.body, filename: `${meta.name}.${fmt}`, mimeType: EXPORT_MIME[fmt], sizeBytes: null };
    }
    const res = await providerFetch(a, `${D}/files/${encodeURIComponent(id(fileId))}?alt=media&${ALL}`, { timeoutMs: 120_000 });
    if (!res.body) throw new ProviderError("Google Drive download returned nothing.", "unavailable");
    return { body: res.body, filename: meta.name, mimeType: meta.mimeType ?? "application/octet-stream", sizeBytes: meta.sizeBytes };
  },

  async previewUrl(_a, fileId) {
    return `https://drive.google.com/file/d/${encodeURIComponent(id(fileId))}/preview`;
  },

  async upload(a, parentId, src, conflict) {
    const name = await freeName(a, parentId, src.name, conflict);
    const start = await providerFetch(a, `${UPLOAD}?uploadType=resumable&${ALL}&fields=${encodeURIComponent(FIELDS)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": src.mimeType, "X-Upload-Content-Length": String(src.sizeBytes) },
      body: JSON.stringify({ name, parents: [id(parentId ?? "root")] }),
    });
    const session = start.headers.get("location");
    await start.body?.cancel().catch(() => {});
    if (!session || !session.startsWith(`${UPLOAD}?`)) throw new ProviderError("Google Drive didn't start an upload session.", "unavailable");
    const token = await accessToken(a);
    for (let offset = 0; offset < src.sizeBytes || src.sizeBytes === 0;) {
      const len = Math.min(CHUNK, src.sizeBytes - offset);
      const bytes = len > 0 ? await src.read(offset, len) : Buffer.alloc(0);
      let res: Response | null = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          res = await fetch(session, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Length": String(len),
              ...(len > 0 ? { "Content-Range": `bytes ${offset}-${offset + len - 1}/${src.sizeBytes}` } : {}),
            },
            body: new Uint8Array(bytes),
            signal: AbortSignal.timeout(120_000),
          });
        } catch { res = null; }
        if (res && (res.ok || res.status === 308)) break;
        if (res && res.status < 500 && res.status !== 429) break;
        await sleep(backoffMs(attempt));
      }
      if (!res || !(res.ok || res.status === 308)) {
        throw new ProviderError("The upload to Google Drive failed partway. Nothing was saved; try again.", "unavailable", res?.status ?? 0);
      }
      if (res.ok) {
        const f = (await res.json().catch(() => null)) as DriveFile | null;
        if (!f?.id) throw new ProviderError("Google Drive didn't confirm the upload. Check the folder before trying again.", "unavailable");
        return driveItem(f);
      }
      // 308: Google says how much it has; continue from there.
      const range = res.headers.get("range")?.match(/bytes=0-(\d+)/);
      offset = range ? Number(range[1]) + 1 : offset + len;
      if (src.sizeBytes === 0) break;
    }
    throw new ProviderError("Google Drive didn't confirm the upload. Check the folder before trying again.", "unavailable");
  },

  async changes(a, cursor): Promise<ChangesResult> {
    if (!cursor) {
      const j = await providerJson<{ startPageToken?: string }>(a, `${D}/changes/startPageToken?${ALL}`);
      if (!j.startPageToken) throw new ProviderError("Google Drive didn't return a change cursor.", "unavailable");
      return { changes: [], cursor: j.startPageToken, reset: false };
    }
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return { changes: [], cursor: "", reset: true };
    const out: ChangesResult = { changes: [], cursor, reset: false };
    let token: string | null = cursor;
    for (let pages = 0; token && pages < 50; pages++) {
      const qs = new URLSearchParams({
        pageToken: token, pageSize: "1000", includeItemsFromAllDrives: "true", supportsAllDrives: "true",
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`,
      });
      let j: { changes?: { fileId: string; removed?: boolean; file?: DriveFile }[]; nextPageToken?: string; newStartPageToken?: string };
      try {
        j = await providerJson(a, `${D}/changes?${qs}`);
      } catch (e) {
        if (e instanceof ProviderError && (e.kind === "invalid" || e.kind === "notfound")) return { changes: [], cursor: "", reset: true };
        throw e;
      }
      for (const c of j.changes ?? []) {
        const gone = !!c.removed || !!c.file?.trashed;
        out.changes.push({ id: c.fileId, removed: gone, item: gone || !c.file ? null : driveItem(c.file) });
      }
      if (j.newStartPageToken) { out.cursor = j.newStartPageToken; token = null; }
      else { token = j.nextPageToken ?? null; if (token) out.cursor = token; }
    }
    return out;
  },
};
