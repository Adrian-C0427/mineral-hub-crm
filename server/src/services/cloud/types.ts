/**
 * Cloud files — one shape for OneDrive (Microsoft Graph) and Google Drive
 * (Drive API v3), so the file browser, the Documents module and the linking
 * flow treat both the same wherever the APIs allow it.
 */
import type { ConnectedAccount } from "@prisma/client";

export type CloudKind = "folder" | "file" | "google-doc" | "google-sheet" | "google-slides" | "google-other";

export interface CloudItem {
  id: string;
  name: string;
  kind: CloudKind;
  isFolder: boolean;
  mimeType: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  modifiedBy: string | null;
  /** Opens the item at the provider (its own permissions apply). */
  webUrl: string | null;
  parentId: string | null;
  /** OneDrive: the item's drive; Google: the shared drive it lives in, if any. */
  driveId: string | null;
  /** OneDrive concurrency tag (If-Match on rename/move/delete). */
  etag: string | null;
  owner: string | null;
  canEdit: boolean;
  canRename: boolean;
  canDelete: boolean;
  canDownload: boolean;
  /** Google Docs/Sheets/Slides: the formats it can be exported as. */
  exportFormats: ExportFormat[];
}

export type ExportFormat = "pdf" | "docx" | "xlsx" | "pptx" | "csv" | "txt";

export interface CloudPage { items: CloudItem[]; cursor: string | null }

/** Google Drive's browse roots; OneDrive has one ("mine"). */
export type CloudView = "mine" | "shared" | "drives";

export interface DownloadResult {
  body: ReadableStream<Uint8Array>;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
}

export interface CloudChange {
  id: string;
  removed: boolean;
  item: CloudItem | null;
}

export interface ChangesResult {
  changes: CloudChange[];
  /** Where to continue next sync. */
  cursor: string;
  /** The provider expired the cursor: start over (and re-check linked files directly). */
  reset: boolean;
}

export type ConflictPolicy = "fail" | "rename";

export interface UploadSource {
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Read `length` bytes starting at `offset` (files are uploaded in chunks). */
  read(offset: number, length: number): Promise<Buffer>;
}

export interface CloudDriver {
  list(a: ConnectedAccount, folderId: string | null, cursor: string | null, view: CloudView): Promise<CloudPage>;
  search(a: ConnectedAccount, q: string, cursor: string | null): Promise<CloudPage>;
  get(a: ConnectedAccount, id: string): Promise<CloudItem>;
  createFolder(a: ConnectedAccount, parentId: string | null, name: string): Promise<CloudItem>;
  rename(a: ConnectedAccount, id: string, name: string, etag: string | null): Promise<CloudItem>;
  move(a: ConnectedAccount, id: string, parentId: string | null, etag: string | null): Promise<CloudItem>;
  /** Recoverable: OneDrive's recycle bin / Google Drive's trash. */
  trash(a: ConnectedAccount, id: string, etag: string | null): Promise<void>;
  download(a: ConnectedAccount, id: string, format: ExportFormat | null): Promise<DownloadResult>;
  /** An embeddable preview URL (or null when the provider has none for this item). */
  previewUrl(a: ConnectedAccount, id: string): Promise<string | null>;
  upload(a: ConnectedAccount, parentId: string | null, src: UploadSource, conflict: ConflictPolicy): Promise<CloudItem>;
  changes(a: ConnectedAccount, cursor: string | null): Promise<ChangesResult>;
}
