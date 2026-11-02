/**
 * OneDrive through Microsoft Graph v1.0 (the member's own drive, Files.ReadWrite).
 *
 *  - Paging: Graph's @odata.nextLink, accepted back only for this drive's
 *    endpoints.
 *  - Conflicts: create / upload / rename / move send conflictBehavior=fail
 *    (never "replace"), so nothing is silently overwritten; the caller may
 *    choose "rename" (OneDrive keeps both). Rename/move/delete pass the
 *    item's eTag as If-Match when known, so a file changed meanwhile isn't
 *    clobbered (412 → conflict).
 *  - Delete goes to the OneDrive recycle bin (recoverable).
 *  - Downloads stream from the item's pre-authenticated download URL — no
 *    token is sent to it.
 *  - Large files: an upload session in 10 MiB chunks (a multiple of the
 *    required 320 KiB), each chunk retried; the session is cancelled on failure.
 *  - Changes: the drive delta feed, started from "now" (token=latest) so the
 *    first sync doesn't enumerate the whole drive.
 */
import type { ConnectedAccount } from "@prisma/client";
import { providerFetch, providerJson, ProviderError, backoffMs, sleep } from "../connected/client.js";
import { safeItemId } from "./safety.js";
import type { ChangesResult, CloudDriver, CloudItem, CloudPage, ConflictPolicy, DownloadResult, UploadSource } from "./types.js";

const G = "https://graph.microsoft.com/v1.0";
const SELECT = "id,name,size,folder,file,package,lastModifiedDateTime,lastModifiedBy,webUrl,parentReference,eTag,createdBy,deleted";
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;

interface GraphItem {
  id: string; name?: string; size?: number; eTag?: string; webUrl?: string; lastModifiedDateTime?: string;
  folder?: { childCount?: number }; file?: { mimeType?: string }; package?: { type?: string };
  parentReference?: { id?: string; driveId?: string; path?: string };
  lastModifiedBy?: { user?: { displayName?: string } }; createdBy?: { user?: { displayName?: string } };
  deleted?: unknown; "@microsoft.graph.downloadUrl"?: string;
}

export function oneDriveItem(r: GraphItem): CloudItem {
  const isFolder = !!r.folder;
  return {
    id: r.id,
    name: r.name ?? "(untitled)",
    kind: isFolder ? "folder" : "file",
    isFolder,
    mimeType: r.file?.mimeType ?? null,
    sizeBytes: typeof r.size === "number" ? r.size : null,
    modifiedAt: r.lastModifiedDateTime ?? null,
    modifiedBy: r.lastModifiedBy?.user?.displayName ?? null,
    webUrl: r.webUrl ?? null,
    parentId: r.parentReference?.id ?? null,
    driveId: r.parentReference?.driveId ?? null,
    etag: r.eTag ?? null,
    owner: r.createdBy?.user?.displayName ?? null,
    // The member's own drive: they can do everything Files.ReadWrite allows.
    canEdit: true, canRename: true, canDelete: true, canDownload: !isFolder && !r.package,
    exportFormats: [],
  };
}

const sortItems = (items: CloudItem[]) =>
  items.sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.isFolder ? -1 : 1));

/**
 * A nextLink / deltaLink handed back by a client must point at drive
 * endpoints (Graph may phrase them as /me/drive/… or /drives/<id>/…) — never
 * anywhere else the token could reach.
 */
function ownLink(link: string, kind: "page" | "delta"): string {
  const ok = /^https:\/\/graph\.microsoft\.com\/v1\.0\/(me\/drive|drives\/[A-Za-z0-9!_.-]+)\//.test(link)
    && (kind === "page" || /\/root\/delta\b/.test(new URL(link).pathname));
  if (!ok) throw new ProviderError("Invalid page cursor.", "invalid");
  return link;
}

const itemUrl = (id: string | null) => (id ? `${G}/me/drive/items/${encodeURIComponent(safeItemId(id))}` : `${G}/me/drive/root`);

async function page(a: ConnectedAccount, url: string): Promise<CloudPage> {
  const j = await providerJson<{ value?: GraphItem[]; "@odata.nextLink"?: string }>(a, url);
  return { items: sortItems((j.value ?? []).filter((r) => !r.deleted).map(oneDriveItem)), cursor: j["@odata.nextLink"] ?? null };
}

const conflictQ = (c: ConflictPolicy) => `@microsoft.graph.conflictBehavior=${c === "rename" ? "rename" : "fail"}`;

async function uploadChunked(uploadUrl: string, src: UploadSource): Promise<GraphItem> {
  // The session URL is pre-authenticated (SharePoint/OneDrive host): no token.
  if (!/^https:\/\//.test(uploadUrl)) throw new ProviderError("OneDrive returned an invalid upload address.", "invalid");
  for (let offset = 0; offset < src.sizeBytes;) {
    const len = Math.min(CHUNK, src.sizeBytes - offset);
    const bytes = await src.read(offset, len);
    let res: Response | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        res = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Length": String(len), "Content-Range": `bytes ${offset}-${offset + len - 1}/${src.sizeBytes}` },
          body: new Uint8Array(bytes),
          signal: AbortSignal.timeout(120_000),
        });
      } catch { res = null; }
      if (res && (res.ok || res.status === 202)) break;
      if (res && res.status < 500 && res.status !== 429) break;
      await sleep(backoffMs(attempt));
    }
    if (!res || !(res.ok || res.status === 202)) {
      await fetch(uploadUrl, { method: "DELETE" }).catch(() => {});
      const conflict = res?.status === 409;
      throw new ProviderError(conflict ? "OneDrive reported a conflict: a file with that name already exists there." : "The upload to OneDrive failed partway. Nothing was saved; try again.", conflict ? "conflict" : "unavailable", res?.status ?? 0);
    }
    offset += len;
    if (res.status === 200 || res.status === 201) return (await res.json()) as GraphItem;
  }
  throw new ProviderError("OneDrive didn't confirm the upload. Check the folder before trying again.", "unavailable");
}

export const oneDrive: CloudDriver = {
  async list(a, folderId, cursor) {
    if (cursor) return page(a, ownLink(cursor, "page"));
    return page(a, `${itemUrl(folderId)}/children?$top=100&$select=${SELECT}`);
  },

  async search(a, q, cursor) {
    if (cursor) return page(a, ownLink(cursor, "page"));
    const term = encodeURIComponent(q.replace(/'/g, "''"));
    return page(a, `${G}/me/drive/root/search(q='${term}')?$top=100&$select=${SELECT}`);
  },

  async get(a, id) {
    return oneDriveItem(await providerJson<GraphItem>(a, `${itemUrl(id)}?$select=${SELECT}`));
  },

  async createFolder(a, parentId, name) {
    const r = await providerJson<GraphItem>(a, `${itemUrl(parentId)}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    return oneDriveItem(r);
  },

  async rename(a, id, name, etag) {
    const r = await providerJson<GraphItem>(a, `${itemUrl(id)}?${conflictQ("fail")}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
      body: JSON.stringify({ name }),
    });
    return oneDriveItem(r);
  },

  async move(a, id, parentId, etag) {
    const target = parentId ? safeItemId(parentId) : (await providerJson<GraphItem>(a, `${G}/me/drive/root?$select=id`)).id;
    const r = await providerJson<GraphItem>(a, `${itemUrl(id)}?${conflictQ("fail")}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
      body: JSON.stringify({ parentReference: { id: target } }),
    });
    return oneDriveItem(r);
  },

  async trash(a, id, etag) {
    await providerFetch(a, itemUrl(id), { method: "DELETE", headers: etag ? { "If-Match": etag } : {} });
  },

  async download(a, id): Promise<DownloadResult> {
    const meta = await providerJson<GraphItem>(a, `${itemUrl(id)}?$select=id,name,size,file,folder,package,@microsoft.graph.downloadUrl`);
    const url = meta["@microsoft.graph.downloadUrl"];
    if (meta.folder || meta.package || !url) throw new ProviderError("Only files can be downloaded.", "invalid");
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) throw new ProviderError("OneDrive download failed. Try again.", "unavailable", res.status);
    return { body: res.body, filename: meta.name ?? "download", mimeType: meta.file?.mimeType ?? "application/octet-stream", sizeBytes: meta.size ?? null };
  },

  async previewUrl(a, id) {
    const r = await providerJson<{ getUrl?: string }>(a, `${itemUrl(id)}/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", retry: true });
    return r.getUrl && /^https:\/\//.test(r.getUrl) ? r.getUrl : null;
  },

  async upload(a, parentId, src, conflict) {
    const name = encodeURIComponent(src.name);
    const base = parentId ? `${itemUrl(parentId)}:/${name}:` : `${G}/me/drive/root:/${name}:`;
    if (src.sizeBytes <= SIMPLE_UPLOAD_MAX) {
      const bytes = await src.read(0, src.sizeBytes);
      const r = await providerJson<GraphItem>(a, `${base}/content?${conflictQ(conflict)}`, {
        method: "PUT", headers: { "Content-Type": src.mimeType }, body: new Uint8Array(bytes),
      });
      return oneDriveItem(r);
    }
    const session = await providerJson<{ uploadUrl?: string }>(a, `${base}/createUploadSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": conflict === "rename" ? "rename" : "fail", name: src.name } }),
    });
    if (!session.uploadUrl) throw new ProviderError("OneDrive didn't start an upload session.", "unavailable");
    return oneDriveItem(await uploadChunked(session.uploadUrl, src));
  },

  async changes(a, cursor): Promise<ChangesResult> {
    if (!cursor) {
      const j = await providerJson<{ "@odata.deltaLink"?: string }>(a, `${G}/me/drive/root/delta?token=latest`);
      if (!j["@odata.deltaLink"]) throw new ProviderError("OneDrive didn't return a change cursor.", "unavailable");
      return { changes: [], cursor: j["@odata.deltaLink"], reset: false };
    }
    const out: ChangesResult = { changes: [], cursor, reset: false };
    let url: string | null = ownLink(cursor, "delta");
    for (let pages = 0; url && pages < 50; pages++) {
      let j: { value?: GraphItem[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
      try {
        j = await providerJson(a, url);
      } catch (e) {
        // 410 Gone: the delta token expired (resyncRequired).
        if (e instanceof ProviderError && e.status === 410) return { changes: [], cursor: "", reset: true };
        throw e;
      }
      for (const r of j.value ?? []) out.changes.push({ id: r.id, removed: !!r.deleted, item: r.deleted ? null : oneDriveItem(r) });
      if (j["@odata.deltaLink"]) { out.cursor = j["@odata.deltaLink"]; url = null; }
      else { url = j["@odata.nextLink"] ?? null; if (url) out.cursor = url; }
    }
    return out;
  },
};
