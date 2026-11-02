import { API_BASE, ApiError, getAuthToken } from "../api/client";

/**
 * OneDrive / Google Drive files (server: routes/cloud.ts). One shape for both
 * providers; capabilities (canRename, canDelete, …) come from the provider.
 */
export type CloudKind = "folder" | "file" | "google-doc" | "google-sheet" | "google-slides" | "google-other";
export type ExportFormat = "pdf" | "docx" | "xlsx" | "pptx" | "csv" | "txt";
export type CloudView = "mine" | "shared" | "drives";

export interface CloudItem {
  id: string;
  name: string;
  kind: CloudKind;
  isFolder: boolean;
  mimeType: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  modifiedBy: string | null;
  webUrl: string | null;
  parentId: string | null;
  driveId: string | null;
  etag: string | null;
  owner: string | null;
  canEdit: boolean;
  canRename: boolean;
  canDelete: boolean;
  canDownload: boolean;
  exportFormats: ExportFormat[];
}

export interface CloudPage { items: CloudItem[]; cursor: string | null }

export type RecordType = "deal" | "opportunity" | "contact" | "buyer";
export interface RecordRef { type: RecordType; id: string }

/** A drive file linked to a CRM record (the file stays in the drive). */
export interface CloudLink {
  id: string;
  provider: "onedrive" | "googledrive";
  accountId: string;
  ownerName: string | null;
  /** The viewer connected the drive it's in (only they download through the CRM). */
  mine: boolean;
  itemId: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  webUrl: string | null;
  modifiedAt: string | null;
  origin: "LINKED" | "COPIED";
  status: "OK" | "MISSING" | "NO_ACCESS";
  folder: string;
  record: RecordRef | null;
  linkedBy: string | null;
  createdAt: string;
}

export const PROVIDER_LABEL: Record<"onedrive" | "googledrive", string> = { onedrive: "OneDrive", googledrive: "Google Drive" };

export const EXPORT_LABEL: Record<ExportFormat, string> = {
  pdf: "PDF", docx: "Word (.docx)", xlsx: "Excel (.xlsx)", pptx: "PowerPoint (.pptx)", csv: "CSV", txt: "Plain text",
};

export function humanBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function kindLabel(i: Pick<CloudItem, "kind" | "name" | "mimeType">): string {
  switch (i.kind) {
    case "folder": return "Folder";
    case "google-doc": return "Google Doc";
    case "google-sheet": return "Google Sheet";
    case "google-slides": return "Google Slides";
    case "google-other": return "Google file";
    default: {
      const ext = i.name.includes(".") ? i.name.split(".").pop()!.toUpperCase() : "";
      return ext && ext.length <= 5 ? ext : (i.mimeType?.split("/")[1] ?? "File").toUpperCase();
    }
  }
}

function authHeader(): Record<string, string> {
  const t = getAuthToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Open a CRM download URL (streamed by the API) in a new tab or as a file. */
export async function downloadThroughApi(path: string, filenameHint: string, inline = false): Promise<void> {
  const res = await fetch(`${API_BASE}/api${path}${inline ? `${path.includes("?") ? "&" : "?"}inline=1` : ""}`, { headers: authHeader(), credentials: "include" });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, j.error ?? `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (inline) {
    window.open(url, "_blank", "noopener");
  } else {
    const a = document.createElement("a");
    a.href = url;
    a.download = filenameHint;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Upload with progress (fetch can't report upload progress; XHR can). */
export function uploadWithProgress<T>(path: string, form: FormData, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/api${path}`);
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(authHeader())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new ApiError(xhr.status, (body as { error?: string } | null)?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, "Upload failed — check your connection and try again."));
    xhr.send(form);
  });
}
