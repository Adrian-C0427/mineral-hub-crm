import { useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { Banner } from "./ui";
import { Select } from "./Select";
import { SortableTable, type Column } from "./SortableTable";
import { fmtDateLocal } from "../lib/format";

/**
 * The single, shared Documents section used everywhere documents are managed
 * (Deals, Mineral Assets, and any future module). The Deal page is the reference
 * implementation; every other location renders this exact component — same card
 * layout, folder chips, upload experience, drag-and-drop, sortable rows, and
 * per-row actions — while passing its OWN document folders/categories via
 * `folders`. Centralizing it means future improvements land everywhere at once.
 */

export interface DocFile {
  id: string;
  category?: string;
  folder: string;
  filename: string;
  mimeType?: string;
  sizeBytes: number;
  uploadedBy?: string | null;
  createdAt: string;
  updatedAt?: string;
  versionCount?: number;
}

/** Deal document folders — the reference set (kept here so Deals and the shared
 *  component never drift). Other modules pass their own via `folders`. */
export const DEAL_DOC_FOLDERS = ["Seller PSA", "Wholesale PSA", "Check Stubs", "Division Orders", "Deeds", "Title", "Other"];

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function fileType(f: DocFile): string {
  const ext = f.filename.includes(".") ? f.filename.split(".").pop()!.toUpperCase() : "";
  if (ext && ext.length <= 5) return ext;
  return ((f.mimeType ?? "").split("/")[1] || f.mimeType || "file").toUpperCase();
}
const isPreviewable = (f: DocFile) => f.mimeType === "application/pdf" || (f.mimeType ?? "").startsWith("image/");

export function DocumentsSection({
  ownerType = "deal",
  ownerId,
  files,
  folders: folderList = DEAL_DOC_FOLDERS,
  onChanged,
  canEdit,
  canDelete,
  title = "Documents",
}: {
  /** Which owner the uploaded file attaches to (matches the /files contract). */
  ownerType?: "deal" | "buyer";
  ownerId: string;
  files: DocFile[];
  /** Module-specific document folders/categories. */
  folders?: string[];
  onChanged: () => void;
  canEdit: boolean;
  canDelete: boolean;
  title?: string;
}) {
  const [folder, setFolder] = useState(folderList[0] ?? "Other");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceId = useRef<string | null>(null);

  // Folders = the module's defaults, plus any folder already present that isn't a default.
  const folders = useMemo(() => {
    const present = new Set(files.map((f) => f.folder || "Other"));
    return [...folderList, ...[...present].filter((p) => !folderList.includes(p)).sort()];
  }, [files, folderList]);
  const countByFolder = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of files) m.set(f.folder || "Other", (m.get(f.folder || "Other") ?? 0) + 1);
    return m;
  }, [files]);
  const inFolder = useMemo(() => files.filter((f) => (f.folder || "Other") === folder), [files, folder]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }
  const ownerField = ownerType === "buyer" ? "buyerId" : "dealId";
  const upload = (file: File) => run(async () => {
    const form = new FormData();
    form.append("file", file); form.append(ownerField, ownerId); form.append("folder", folder);
    await api.upload("/files", form);
  });
  async function uploadMany(fileList: FileList) {
    for (const file of Array.from(fileList)) await upload(file);
  }
  const replace = (file: File) => run(async () => {
    const form = new FormData(); form.append("file", file);
    await api.upload(`/files/${replaceId.current}/replace`, form);
  });
  const rename = (f: DocFile) => {
    const filename = window.prompt("Rename document", f.filename);
    if (filename && filename.trim() && filename !== f.filename) run(() => api.patch(`/files/${f.id}`, { filename: filename.trim() }));
  };
  const move = (f: DocFile, toFolder: string) => { if (toFolder !== f.folder) run(() => api.patch(`/files/${f.id}`, { folder: toFolder })); };
  const open = async (id: string, inline: boolean) => {
    const { url } = await api.get<{ url: string }>(`/files/${id}/download${inline ? "?inline=1" : ""}`);
    window.open(url, "_blank");
  };

  const columns: Column<DocFile>[] = [
    {
      key: "filename", header: "Document Name", value: (f) => f.filename.toLowerCase(),
      render: (f) => <span title={f.filename}>{f.filename}{(f.versionCount ?? 0) > 0 && <span className="chip-mini" style={{ marginLeft: 6 }} title={`${f.versionCount} previous version(s)`}>v{(f.versionCount ?? 0) + 1}</span>}</span>,
    },
    { key: "createdAt", header: "Date Uploaded", type: "date", value: (f) => f.createdAt, render: (f) => fmtDateLocal(f.createdAt) },
    { key: "updatedAt", header: "Date Modified", type: "date", value: (f) => f.updatedAt ?? f.createdAt, render: (f) => fmtDateLocal(f.updatedAt ?? f.createdAt) },
    { key: "uploadedBy", header: "Uploaded By", value: (f) => f.uploadedBy ?? "", render: (f) => f.uploadedBy ?? "—" },
    { key: "type", header: "File Type", value: (f) => fileType(f) },
    { key: "sizeBytes", header: "File Size", align: "right", value: (f) => f.sizeBytes, render: (f) => humanSize(f.sizeBytes) },
    {
      key: "actions", header: "", value: () => "", align: "right", width: "1%",
      render: (f) => (
        <div className="row" style={{ gap: 4, justifyContent: "flex-end", flexWrap: "nowrap" }}>
          {isPreviewable(f) && <button className="small" onClick={() => open(f.id, true)}>Preview</button>}
          <button className="small" onClick={() => open(f.id, false)}>Download</button>
          {canEdit && <button className="small" onClick={() => rename(f)}>Rename</button>}
          {canEdit && (
            <Select value={f.folder || "Other"} onChange={(v) => move(f, v)} width={150} ariaLabel="Move to folder"
              options={folders.map((fl) => ({ value: fl, label: fl }))} />
          )}
          {canEdit && <button className="small" onClick={() => { replaceId.current = f.id; replaceRef.current?.click(); }}>Replace</button>}
          {canDelete && <button className="small danger" onClick={() => run(() => api.del(`/files/${f.id}`))}>Delete</button>}
        </div>
      ),
    },
  ];

  return (
    <div
      className={`panel doc-section ${dragOver ? "drag-over" : ""}`}
      onDragOver={canEdit ? (e) => { e.preventDefault(); if (!dragOver) setDragOver(true); } : undefined}
      onDragLeave={canEdit ? (e) => { if (e.currentTarget === e.target) setDragOver(false); } : undefined}
      onDrop={canEdit ? (e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) void uploadMany(e.dataTransfer.files); } : undefined}
    >
      <div className="section-head"><h3>{title}</h3><span className="muted">Organized by folder · sortable{canEdit ? " · drag files in to upload" : ""}</span></div>

      <div className="doc-chips">
        {folders.map((fl) => (
          <span key={fl} className={`doc-chip ${folder === fl ? "active" : ""}`} onClick={() => setFolder(fl)}>
            {folder === fl && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>
            )}
            {fl} <span className="doc-count">{countByFolder.get(fl) ?? 0}</span>
          </span>
        ))}
      </div>

      <div className="row" style={{ margin: "12px 0", justifyContent: "space-between" }}>
        <strong>{folder}</strong>
        {canEdit && (
          <label className="chip" style={{ margin: 0 }}>
            {busy ? "Working…" : `Upload to ${folder}`}
            <input ref={uploadRef} type="file" multiple style={{ display: "none" }} disabled={busy}
              onChange={(e) => { if (e.target.files?.length) void uploadMany(e.target.files); e.target.value = ""; }} />
          </label>
        )}
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      {inFolder.length === 0 ? (
        <p className="muted">{dragOver ? `Drop to upload to ${folder}` : `No documents in ${folder}.`}</p>
      ) : (
        <SortableTable columns={columns} rows={inFolder} rowKey={(f) => f.id} defaultSort={{ key: "createdAt", dir: "desc" }} />
      )}

      {/* Hidden input used by per-row Replace buttons. */}
      <input ref={replaceRef} type="file" style={{ display: "none" }}
        onChange={(e) => { if (e.target.files?.[0]) replace(e.target.files[0]); e.target.value = ""; }} />
    </div>
  );
}
