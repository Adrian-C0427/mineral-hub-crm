import { useEffect, useMemo, useRef, useState } from "react";
import { Cloud } from "lucide-react";
import { api } from "../api/client";
import { Banner, EmptyState, Modal, OverflowMenu, Spinner, showToast } from "./ui";
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
/** How the in-app viewer renders a file; "other" falls back to download. */
function viewKind(f: DocFile): "pdf" | "image" | "video" | "audio" | "text" | "other" {
  const m = f.mimeType ?? "";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("text/") || m === "application/json") return "text";
  return "other";
}

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
  const [cloudProviders, setCloudProviders] = useState<CloudProvider[]>([]);
  const [importing, setImporting] = useState<CloudProvider | null>(null);
  const [viewing, setViewing] = useState<DocFile | null>(null);
  const [moving, setMoving] = useState<DocFile | null>(null);
  const [renaming, setRenaming] = useState<DocFile | null>(null);
  // Folder management (rename / delete / drag-reorder) — deals only (assets
  // are Deal rows too); the customized list is persisted on the deal.
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
  const dragFolder = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Collapsed by default everywhere; the choice is remembered for the session
  // per record, using the same collapse pattern as the other page sections.
  const openKey = `mh-docs-open:${ownerType}:${ownerId}`;
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return sessionStorage.getItem(openKey) === "1"; } catch { return false; }
  });
  const toggleOpen = () => setExpanded((o) => {
    try { sessionStorage.setItem(openKey, o ? "0" : "1"); } catch { /* storage off */ }
    return !o;
  });
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceId = useRef<string | null>(null);

  // Cloud import is offered only when an admin has connected Drive/OneDrive.
  useEffect(() => {
    if (!canEdit) return;
    api.get<CloudProvider[]>("/files/cloud/providers")
      .then((list) => setCloudProviders(list.filter((p) => p.connected)))
      .catch(() => setCloudProviders([]));
  }, [canEdit]);

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
  const rename = (f: DocFile, filename: string) => {
    if (filename.trim() && filename.trim() !== f.filename) run(() => api.patch(`/files/${f.id}`, { filename: filename.trim() }));
  };
  const move = (f: DocFile, toFolder: string) => { if (toFolder !== f.folder) run(() => api.patch(`/files/${f.id}`, { folder: toFolder })); };

  // --- folder management --------------------------------------------------
  const canManageFolders = canEdit && ownerType === "deal";
  const folderOp = (body: Record<string, unknown>) => run(() => api.post(`/deals/${ownerId}/doc-folders`, body));
  const reorderFolders = (from: string, to: string) => {
    if (from === to) return;
    const next = folders.filter((f) => f !== from);
    next.splice(next.indexOf(to), 0, from);
    void folderOp({ op: "reorder", folders: next });
  };
  const renameFolder = (from: string, to: string) => {
    const clean = to.trim();
    if (!clean || clean === from) return;
    if (folders.some((f) => f.toLowerCase() === clean.toLowerCase())) { setErr(`A “${clean}” folder already exists.`); return; }
    if (folder === from) setFolder(clean); // keep the renamed folder active
    void folderOp({ op: "rename", from, to: clean, folders: folders.map((f) => (f === from ? clean : f)) });
  };
  const removeFolder = (name: string) => {
    if (folder === name) setFolder("Other");
    void folderOp({ op: "remove", name, folders: folders.filter((f) => f !== name) });
  };
  const open = async (id: string, inline: boolean) => {
    const { url } = await api.get<{ url: string }>(`/files/${id}/download${inline ? "?inline=1" : ""}`);
    window.open(url, "_blank");
  };

  const columns: Column<DocFile>[] = [
    {
      key: "filename", header: "Document Name", value: (f) => f.filename.toLowerCase(),
      // The name itself opens the in-app viewer — the natural "click the
      // document to see it" affordance.
      render: (f) => (
        <span title={f.filename}>
          <button type="button" className="link-btn doc-name" onClick={() => setViewing(f)}>{f.filename}</button>
          {(f.versionCount ?? 0) > 0 && <span className="chip-mini" style={{ marginLeft: 6 }} title={`${f.versionCount} previous version(s)`}>v{(f.versionCount ?? 0) + 1}</span>}
        </span>
      ),
    },
    { key: "createdAt", header: "Date Uploaded", type: "date", value: (f) => f.createdAt, render: (f) => fmtDateLocal(f.createdAt) },
    { key: "updatedAt", header: "Date Modified", type: "date", value: (f) => f.updatedAt ?? f.createdAt, render: (f) => fmtDateLocal(f.updatedAt ?? f.createdAt) },
    { key: "uploadedBy", header: "Uploaded By", value: (f) => f.uploadedBy ?? "", render: (f) => f.uploadedBy ?? "—" },
    { key: "type", header: "File Type", value: (f) => fileType(f) },
    { key: "sizeBytes", header: "File Size", align: "right", value: (f) => f.sizeBytes, render: (f) => humanSize(f.sizeBytes) },
    {
      key: "actions", header: "", value: () => "", align: "right", width: "1%",
      // Two primary actions stay visible; everything else lives in a ⋯ menu
      // (body-portaled, so it always opens fully on-screen) — the row never
      // crowds or overlaps, at any width.
      render: (f) => (
        <div className="doc-actions">
          <button className="small" onClick={() => setViewing(f)}>View</button>
          <button className="small" onClick={() => open(f.id, false)}>Download</button>
          {(canEdit || canDelete) && (
            <OverflowMenu
              ariaLabel={`More actions for ${f.filename}`}
              items={[
                ...(canEdit ? [
                  { label: "Rename", onClick: () => setRenaming(f) },
                  { label: "Move to folder…", onClick: () => setMoving(f) },
                  { label: "Replace file…", onClick: () => { replaceId.current = f.id; replaceRef.current?.click(); } },
                ] : []),
                ...(canDelete ? [{ label: "Delete", danger: true, onClick: () => run(() => api.del(`/files/${f.id}`)) }] : []),
              ]}
            />
          )}
        </div>
      ),
    },
  ];

  return (
    <div
      className={`panel dpp-panel doc-section ${expanded ? "open" : ""} ${dragOver ? "drag-over" : ""}`}
      onDragOver={canEdit && expanded ? (e) => { e.preventDefault(); if (!dragOver) setDragOver(true); } : undefined}
      onDragLeave={canEdit && expanded ? (e) => { if (e.currentTarget === e.target) setDragOver(false); } : undefined}
      onDrop={canEdit && expanded ? (e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) void uploadMany(e.dataTransfer.files); } : undefined}
    >
      {/* Same collapse anatomy as CollapsibleSection (Buyer Activity etc.) —
          collapsed by default, remembered per record for the session. */}
      <div className="dpp-head" role="button" tabIndex={0} aria-expanded={expanded}
        onClick={toggleOpen}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleOpen(); } }}>
        <div className="dpp-title"><div>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <div className="dpp-sub">{files.length} file{files.length === 1 ? "" : "s"} · organized by folder{canEdit ? " · drag files in to upload" : ""}</div>
        </div></div>
        <span className="dpp-right">
          <span className="muted" style={{ fontSize: 12.5 }}>{expanded ? "Collapse" : "Expand"}</span>
          <span className={`va-chev ${expanded ? "" : "down"}`}>⌃</span>
        </span>
      </div>
      {expanded && <div className="cs-body">

      <div className="doc-chips">
        {folders.map((fl) => (
          // Same anatomy for every chip — the active one differs by color,
          // not by sprouting an icon (which shifted the row's widths).
          // Chips are draggable to reorder the folder list (persisted).
          <span
            key={fl}
            className={`doc-chip ${folder === fl ? "active" : ""} ${dropTarget === fl ? "drop-target" : ""}`}
            onClick={() => setFolder(fl)}
            draggable={canManageFolders}
            onDragStart={canManageFolders ? (e) => { dragFolder.current = fl; e.dataTransfer.effectAllowed = "move"; } : undefined}
            onDragOver={canManageFolders ? (e) => { if (dragFolder.current && dragFolder.current !== fl) { e.preventDefault(); setDropTarget(fl); } } : undefined}
            onDragLeave={canManageFolders ? () => setDropTarget((t) => (t === fl ? null : t)) : undefined}
            onDrop={canManageFolders ? (e) => { e.preventDefault(); setDropTarget(null); if (dragFolder.current) reorderFolders(dragFolder.current, fl); dragFolder.current = null; } : undefined}
            onDragEnd={canManageFolders ? () => { dragFolder.current = null; setDropTarget(null); } : undefined}
            title={canManageFolders ? "Drag to reorder folders" : undefined}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>
            {fl} <span className="doc-count">{countByFolder.get(fl) ?? 0}</span>
          </span>
        ))}
      </div>

      <div className="row" style={{ margin: "12px 0", justifyContent: "space-between" }}>
        <span className="row" style={{ gap: 4, alignItems: "center" }}>
          <strong>{folder}</strong>
          {/* "Other" is the system fallback (unfiled documents) — not editable. */}
          {canManageFolders && folder !== "Other" && (
            <OverflowMenu
              ariaLabel={`Manage the ${folder} folder`}
              items={[
                { label: "Rename folder…", onClick: () => setRenamingFolder(folder) },
                { label: "Delete folder…", danger: true, onClick: () => setDeletingFolder(folder) },
              ]}
            />
          )}
        </span>
        {canEdit && (
          <div className="row" style={{ gap: 8 }}>
            {cloudProviders.map((p) => (
              <button key={p.key} className="small" disabled={busy} onClick={() => setImporting(p)} title={`Import files from ${p.name} into ${folder}`}>
                <Cloud size={13} style={{ marginRight: 4, verticalAlign: -2 }} />{p.name}
              </button>
            ))}
            <label className="chip" style={{ margin: 0 }}>
              {busy ? "Working…" : `Upload to ${folder}`}
              <input ref={uploadRef} type="file" multiple style={{ display: "none" }} disabled={busy}
                onChange={(e) => { if (e.target.files?.length) void uploadMany(e.target.files); e.target.value = ""; }} />
            </label>
          </div>
        )}
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      {inFolder.length === 0 ? (
        <EmptyState title={dragOver ? `Drop to upload to ${folder}` : `No documents in ${folder}`}>{dragOver ? "" : "Drag files anywhere onto this panel, or use Upload."}</EmptyState>
      ) : (
        <SortableTable columns={columns} rows={inFolder} rowKey={(f) => f.id} defaultSort={{ key: "createdAt", dir: "desc" }} />
      )}

      {/* Hidden input used by per-row Replace buttons. */}
      <input ref={replaceRef} type="file" style={{ display: "none" }}
        onChange={(e) => { if (e.target.files?.[0]) replace(e.target.files[0]); e.target.value = ""; }} />

      {importing && (
        <CloudImportModal
          provider={importing}
          folder={folder}
          ownerField={ownerField}
          ownerId={ownerId}
          onClose={() => setImporting(null)}
          onImported={(n) => { setImporting(null); showToast(`${n} file${n === 1 ? "" : "s"} imported from ${importing.name} into ${folder}.`); onChanged(); }}
        />
      )}

      {viewing && <DocViewerModal file={viewing} onClose={() => setViewing(null)} onDownload={() => open(viewing.id, false)} />}

      {moving && (
        <MoveFolderModal
          file={moving}
          folders={folders}
          onClose={() => setMoving(null)}
          onMove={(toFolder) => { setMoving(null); move(moving, toFolder); }}
        />
      )}

      {renaming && (
        <RenameFileModal
          file={renaming}
          onClose={() => setRenaming(null)}
          onRename={(filename) => { setRenaming(null); rename(renaming, filename); }}
        />
      )}

      {renamingFolder && (
        <RenameFolderModal
          current={renamingFolder}
          onClose={() => setRenamingFolder(null)}
          onRename={(to) => { const from = renamingFolder; setRenamingFolder(null); renameFolder(from, to); }}
        />
      )}
      {deletingFolder && (
        <Modal title={`Delete “${deletingFolder}”?`} onClose={() => setDeletingFolder(null)}
          footer={<>
            <button onClick={() => setDeletingFolder(null)}>Cancel</button>
            <button className="danger" onClick={() => { const name = deletingFolder; setDeletingFolder(null); removeFolder(name); }}>Delete folder</button>
          </>}>
          <p style={{ marginTop: 0 }}>
            The folder is removed from this record's Documents section.
            {(countByFolder.get(deletingFolder) ?? 0) > 0
              ? <> Its <strong>{countByFolder.get(deletingFolder)}</strong> document{(countByFolder.get(deletingFolder) ?? 0) === 1 ? "" : "s"} move to <strong>Other</strong> — nothing is deleted.</>
              : <> It has no documents.</>}
          </p>
        </Modal>
      )}
      </div>}
    </div>
  );
}

/** Rename a document folder (persisted per deal; the folder's files move with it). */
function RenameFolderModal({ current, onClose, onRename }: {
  current: string; onClose: () => void; onRename: (to: string) => void;
}) {
  const [name, setName] = useState(current);
  const changed = name.trim() !== "" && name.trim() !== current;
  return (
    <Modal title={`Rename “${current}”`} onClose={onClose} dirty={changed}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!changed} onClick={() => onRename(name)}>Rename</button>
      </>}>
      <div className="field">
        <label>Folder name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => { if (e.key === "Enter" && changed) { e.preventDefault(); onRename(name); } }} />
      </div>
      <p className="muted" style={{ marginBottom: 0, fontSize: 12.5 }}>Documents in this folder move with it.</p>
    </Modal>
  );
}

/** Rename dialog — a standard Modal (typography, spacing, buttons, dirty
 * pulse), replacing the old bare window.prompt(). */
function RenameFileModal({ file, onClose, onRename }: {
  file: DocFile; onClose: () => void; onRename: (filename: string) => void;
}) {
  const [name, setName] = useState(file.filename);
  const changed = name.trim() !== "" && name.trim() !== file.filename;
  return (
    <Modal title="Rename document" onClose={onClose} dirty={changed}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!changed} onClick={() => onRename(name)}>Rename</button>
      </>}>
      <div className="field">
        <label>Document name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
          onFocus={(e) => {
            // Preselect the base name so typing replaces it but keeps the extension.
            const dot = e.currentTarget.value.lastIndexOf(".");
            e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && changed) { e.preventDefault(); onRename(name); } }} />
      </div>
    </Modal>
  );
}

// --- In-app document viewer ---------------------------------------------------

/**
 * Views a document inside the app: PDFs, images, video, audio, and plain text
 * render inline (the download endpoint serves them with an inline disposition);
 * anything else gets a friendly fallback with a Download button.
 */
function DocViewerModal({ file, onClose, onDownload }: { file: DocFile; onClose: () => void; onDownload: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kind = viewKind(file);
  useEffect(() => {
    if (kind === "other") return; // nothing to fetch — fallback panel only
    api.get<{ url: string }>(`/files/${file.id}/download?inline=1`)
      .then((r) => setUrl(r.url))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the document"));
  }, [file.id, kind]);

  return (
    <Modal title={file.filename} onClose={onClose} wide
      footer={<>
        <button onClick={onClose}>Close</button>
        <button className="primary" onClick={onDownload}>Download</button>
      </>}>
      {error && <Banner kind="error">{error}</Banner>}
      {kind === "other" ? (
        <EmptyState title="No inline preview for this file type">
          {fileType(file)} files can't be shown in the browser — use Download to open it locally.
        </EmptyState>
      ) : !url && !error ? (
        <Spinner label="Loading document…" />
      ) : url && (
        <div className="doc-viewer">
          {kind === "image" && <img src={url} alt={file.filename} />}
          {(kind === "pdf" || kind === "text") && <iframe src={url} title={file.filename} />}
          {kind === "video" && <video src={url} controls autoPlay={false} />}
          {kind === "audio" && <audio src={url} controls style={{ width: "100%" }} />}
        </div>
      )}
    </Modal>
  );
}

/** Small picker used by the actions menu's "Move to folder…". */
function MoveFolderModal({ file, folders, onClose, onMove }: {
  file: DocFile; folders: string[]; onClose: () => void; onMove: (folder: string) => void;
}) {
  const [dest, setDest] = useState(file.folder || "Other");
  return (
    <Modal title="Move to folder" onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={dest === (file.folder || "Other")} onClick={() => onMove(dest)}>Move</button>
      </>}>
      <p className="muted" style={{ marginTop: 0 }}>Move <strong>{file.filename}</strong> from “{file.folder || "Other"}” to:</p>
      <Select value={dest} onChange={setDest} ariaLabel="Destination folder"
        options={folders.map((fl) => ({ value: fl, label: fl }))} />
    </Modal>
  );
}

// --- Cloud import (Google Drive / OneDrive) ----------------------------------

interface CloudProvider { key: string; name: string; connected: boolean }
interface CloudFile { id: string; name: string; mimeType: string; sizeBytes: number | null; modifiedAt: string | null }

function CloudImportModal({ provider, folder, ownerField, ownerId, onClose, onImported }: {
  provider: CloudProvider; folder: string; ownerField: "dealId" | "buyerId"; ownerId: string;
  onClose: () => void; onImported: (count: number) => void;
}) {
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<CloudFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Load recents on open; re-query as the search debounces.
  useEffect(() => {
    const t = setTimeout(() => {
      setFiles(null); setError(null);
      api.get<CloudFile[]>(`/files/cloud/${provider.key}/list${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`)
        .then(setFiles)
        .catch((e) => { setFiles([]); setError(e instanceof Error ? e.message : "Could not load files"); });
    }, q ? 350 : 0);
    return () => clearTimeout(t);
  }, [provider.key, q]);

  const toggle = (id: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function importSelected() {
    setBusy(true); setError(null);
    let done = 0;
    try {
      for (const id of selected) {
        await api.post(`/files/cloud/${provider.key}/import`, { fileId: id, [ownerField]: ownerId, folder });
        done++;
      }
      onImported(done);
    } catch (e) {
      setError(`${e instanceof Error ? e.message : "Import failed"}${done ? ` (${done} imported before the error)` : ""}`);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Import from ${provider.name}`} onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || selected.size === 0} onClick={importSelected}>
          {busy ? "Importing…" : `Import ${selected.size || ""} into ${folder}`.replace("  ", " ")}
        </button>
      </>}>
      <div className="field" style={{ marginTop: 0 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${provider.name}…`} autoFocus />
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {files === null ? <Spinner label="Loading files…" /> : files.length === 0 ? (
        <EmptyState title={q ? "No matches" : "No files found"}>{q ? "Try a different search." : "Recent files appear here once the account has some."}</EmptyState>
      ) : (
        <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
          {files.map((f) => (
            <label key={f.id} className="row" style={{ gap: 10, padding: "8px 10px", borderBottom: "1px solid var(--border)", cursor: "pointer", alignItems: "center" }}>
              <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.name}>{f.name}</span>
              <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>
                {f.sizeBytes != null ? humanSize(f.sizeBytes) : "—"}{f.modifiedAt ? ` · ${fmtDateLocal(f.modifiedAt)}` : ""}
              </span>
            </label>
          ))}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Files are copied into the app's document storage — the {provider.name} originals are untouched. Google Docs, Sheets, and Slides import as PDF.
      </p>
    </Modal>
  );
}
