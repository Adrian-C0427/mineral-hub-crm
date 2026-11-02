import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, ExternalLink, FileText, FileSpreadsheet, Folder, FolderPlus, Image as ImageIcon, Presentation, Search, Upload } from "lucide-react";
import { api, ApiError } from "../api/client";
import { Banner, ConfirmDialog, Modal, OverflowMenu, Spinner, showToast } from "./ui";
import { fmtDateLocal } from "../lib/format";
import {
  downloadThroughApi, EXPORT_LABEL, humanBytes, kindLabel, PROVIDER_LABEL, uploadWithProgress,
  type CloudItem, type CloudPage, type CloudView,
} from "../lib/cloud";
import type { ConnectedAccount } from "../lib/connectedAccounts";

/**
 * Browse one connected OneDrive / Google Drive. Three modes:
 *   manage       the Files page: folders, upload, rename, move, delete
 *                (to the provider's recycle bin / trash), download/export,
 *                preview, open at the provider, link to a record
 *   pick-files   choose files (e.g. to link or import into a record)
 *   pick-folder  choose a destination folder (move, copy-to-drive)
 * Every action is the provider's own and is offered only when the item's
 * capabilities allow it. Nothing is overwritten: name conflicts ask first.
 */

type Crumb = { id: string | null; name: string };

function ItemIcon({ i }: { i: CloudItem }) {
  if (i.isFolder) return <Folder size={16} className="cb-ico folder" aria-hidden="true" />;
  if (i.kind === "google-sheet" || /sheet|excel|csv/.test(i.mimeType ?? "")) return <FileSpreadsheet size={16} className="cb-ico sheet" aria-hidden="true" />;
  if (i.kind === "google-slides" || /presentation|powerpoint/.test(i.mimeType ?? "")) return <Presentation size={16} className="cb-ico slides" aria-hidden="true" />;
  if ((i.mimeType ?? "").startsWith("image/")) return <ImageIcon size={16} className="cb-ico image" aria-hidden="true" />;
  return <FileText size={16} className={`cb-ico ${i.mimeType === "application/pdf" ? "pdf" : "doc"}`} aria-hidden="true" />;
}

export function CloudBrowser({ account, mode, selected, onToggle, onPickFolder, onLinkItem, pickLabel = "Choose this folder" }: {
  account: ConnectedAccount;
  mode: "manage" | "pick-files" | "pick-folder";
  selected?: ReadonlySet<string>;
  onToggle?: (item: CloudItem) => void;
  onPickFolder?: (folder: Crumb) => void;
  onLinkItem?: (item: CloudItem) => void;
  pickLabel?: string;
}) {
  const isGoogle = account.provider === "googledrive";
  const rootName = isGoogle ? "My Drive" : "My files";
  const [view, setView] = useState<CloudView>("mine");
  const [stack, setStack] = useState<Crumb[]>([{ id: null, name: rootName }]);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CloudItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const [conflictFile, setConflictFile] = useState<File | null>(null);
  const [renaming, setRenaming] = useState<CloudItem | null>(null);
  const [moving, setMoving] = useState<CloudItem | null>(null);
  const [deleting, setDeleting] = useState<CloudItem | null>(null);
  const [preview, setPreview] = useState<{ item: CloudItem; url: string | null } | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const here = stack[stack.length - 1];
  const base = `/cloud/${account.id}`;

  const load = useCallback(async (more = false) => {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      else { if (here.id) params.set("folder", here.id); params.set("view", view); }
      if (more && cursor) params.set("cursor", cursor);
      const page = await api.get<CloudPage>(`${base}/items?${params}`);
      setItems((prev) => (more ? [...prev, ...page.items] : page.items));
      setCursor(page.cursor);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't load this folder.");
    } finally { setLoading(false); }
  }, [base, here.id, view, query, cursor]);
  // Reload when the location or search changes (not when the cursor does).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(false); }, [base, here.id, view, query]);

  const open = (i: CloudItem) => {
    if (i.isFolder) { setQuery(""); setQ(""); setStack((s) => [...s, { id: i.id, name: i.name }]); return; }
    if (mode === "pick-files") { onToggle?.(i); return; }
    if (mode === "manage") void showPreview(i);
  };
  const crumbTo = (idx: number) => { setQuery(""); setQ(""); setStack((s) => s.slice(0, idx + 1)); };
  const switchView = (v: CloudView) => {
    setView(v); setQuery(""); setQ("");
    setStack([{ id: null, name: v === "shared" ? "Shared with me" : v === "drives" ? "Shared drives" : rootName }]);
  };

  async function showPreview(i: CloudItem) {
    try {
      const { url } = await api.get<{ url: string | null }>(`${base}/items/${encodeURIComponent(i.id)}/preview`);
      setPreview({ item: i, url });
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Couldn't open a preview."); }
  }
  async function download(i: CloudItem, format?: string) {
    const name = format ? `${i.name}.${format}` : i.name;
    try { await downloadThroughApi(`${base}/items/${encodeURIComponent(i.id)}/download${format ? `?format=${format}` : ""}`, name); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Download failed."); }
  }
  async function doUpload(file: File, conflict: "fail" | "rename" = "fail") {
    setUpload({ name: file.name, pct: 0 }); setErr(null);
    const form = new FormData();
    form.append("file", file);
    if (here.id) form.append("parentId", here.id);
    form.append("conflict", conflict);
    try {
      await uploadWithProgress<CloudItem>(`${base}/upload`, form, (f) => setUpload({ name: file.name, pct: Math.round(f * 100) }));
      showToast(`Uploaded “${file.name}” to ${PROVIDER_LABEL[account.provider as "onedrive" | "googledrive"]}.`);
      void load(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && conflict === "fail") setConflictFile(file);
      else setErr(e instanceof ApiError ? e.message : "Upload failed.");
    } finally { setUpload(null); }
  }
  async function act(fn: () => Promise<unknown>, done: string) {
    setErr(null);
    try { await fn(); showToast(done); void load(false); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "That didn't work."); }
  }

  const visible = mode === "pick-folder" ? items.filter((i) => i.isFolder) : items;
  const atRootList = !here.id && !query && view !== "mine";
  const canWriteHere = mode === "manage" && !query && !(isGoogle && !here.id && view !== "mine");

  return (
    <div className="cb">
      <div className="cb-bar">
        {isGoogle && (
          <div className="cb-views" role="tablist" aria-label="Drive section">
            {(["mine", "shared", "drives"] as CloudView[]).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={`cb-view ${view === v ? "active" : ""}`} onClick={() => switchView(v)}>
                {v === "mine" ? "My Drive" : v === "shared" ? "Shared with me" : "Shared drives"}
              </button>
            ))}
          </div>
        )}
        <form className="cb-search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
          <Search size={14} aria-hidden="true" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${PROVIDER_LABEL[account.provider as "onedrive" | "googledrive"]}`} aria-label="Search files" />
          {query && <button type="button" className="cb-clear" onClick={() => { setQ(""); setQuery(""); }}>Clear</button>}
        </form>
        {canWriteHere && (
          <div className="cb-tools">
            <button className="small" onClick={() => setNewFolder(true)}><FolderPlus size={14} aria-hidden="true" /> New folder</button>
            <button className="small primary" disabled={!!upload} onClick={() => fileRef.current?.click()}><Upload size={14} aria-hidden="true" /> Upload</button>
            <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void doUpload(f); }} />
          </div>
        )}
      </div>

      <nav className="cb-crumbs" aria-label="Folder path">
        {query ? <span className="cb-crumb current">Search results for “{query}”</span> : stack.map((c, idx) => (
          <span key={`${c.id}-${idx}`} className="cb-crumb-wrap">
            {idx > 0 && <ChevronRight size={13} className="cb-sep" aria-hidden="true" />}
            {idx === stack.length - 1 ? <span className="cb-crumb current">{c.name}</span>
              : <button type="button" className="cb-crumb" onClick={() => crumbTo(idx)}>{c.name}</button>}
          </span>
        ))}
      </nav>

      {upload && (
        <div className="cb-progress" role="status">
          Uploading “{upload.name}”… {upload.pct < 100 ? `${upload.pct}%` : "finishing at the provider"}
          <span className="cb-progress-bar"><i style={{ width: `${upload.pct}%` }} /></span>
        </div>
      )}
      {err && <Banner kind="error">{err}</Banner>}

      <div className="cb-list" role="list">
        {visible.map((i) => {
          const picked = selected?.has(i.id);
          return (
            <div key={i.id} role="listitem" className={`cb-row ${picked ? "picked" : ""}`}>
              {mode === "pick-files" && (
                <input type="checkbox" className="cb-check" disabled={i.isFolder || !i.canDownload && i.kind === "google-other"} checked={!!picked}
                  aria-label={`Select ${i.name}`} onChange={() => onToggle?.(i)} style={{ visibility: i.isFolder ? "hidden" : undefined }} />
              )}
              <button type="button" className="cb-name" onClick={() => open(i)} title={i.name}>
                <ItemIcon i={i} /><span>{i.name}</span>
              </button>
              <span className="cb-kind">{kindLabel(i)}</span>
              <span className="cb-date">{i.modifiedAt ? fmtDateLocal(i.modifiedAt) : "—"}</span>
              <span className="cb-size">{i.isFolder ? "" : humanBytes(i.sizeBytes)}</span>
              {mode === "manage" && (
                <span className="cb-actions">
                  {i.webUrl && <a className="cb-open" href={i.webUrl} target="_blank" rel="noreferrer noopener" title="Open at the provider"><ExternalLink size={14} /></a>}
                  <OverflowMenu ariaLabel={`Actions for ${i.name}`} items={[
                    ...(!i.isFolder ? [{ label: "Preview", onClick: () => void showPreview(i) }] : []),
                    ...(!i.isFolder && i.canDownload && i.exportFormats.length === 0 ? [{ label: "Download", onClick: () => void download(i) }] : []),
                    ...i.exportFormats.map((f) => ({ label: `Download as ${EXPORT_LABEL[f]}`, onClick: () => void download(i, f) })),
                    ...(!i.isFolder && onLinkItem ? [{ label: "Link to a record…", onClick: () => onLinkItem(i) }] : []),
                    ...(i.canRename ? [{ label: "Rename…", onClick: () => setRenaming(i) }] : []),
                    ...(i.canEdit && !atRootList ? [{ label: "Move to…", onClick: () => setMoving(i) }] : []),
                    ...(i.canDelete ? [{ label: isGoogle ? "Move to trash" : "Delete (to recycle bin)", danger: true, onClick: () => setDeleting(i) }] : []),
                  ]} />
                </span>
              )}
            </div>
          );
        })}
        {loading && <Spinner label="Loading…" />}
        {!loading && visible.length === 0 && <div className="cb-empty">{query ? "No matches." : mode === "pick-folder" ? "No folders here." : "This folder is empty."}</div>}
      </div>
      {cursor && !loading && <button className="small cb-more" onClick={() => void load(true)}>Load more</button>}

      {mode === "pick-folder" && (
        <div className="cb-pickbar">
          <span>Destination: <strong>{query ? "—" : here.name}</strong></span>
          <button className="small primary" disabled={!!query || (isGoogle && !here.id && view !== "mine")} onClick={() => onPickFolder?.(here)}>{pickLabel}</button>
        </div>
      )}

      {newFolder && <NameModal title="New folder" label="Folder name" initial="" confirm="Create folder" onClose={() => setNewFolder(false)}
        onSave={(name) => { setNewFolder(false); void act(() => api.post(`${base}/folders`, { parentId: here.id, name }), `Folder “${name}” created.`); }} />}
      {renaming && <NameModal title="Rename" label="Name" initial={renaming.name} confirm="Rename" onClose={() => setRenaming(null)}
        onSave={(name) => { const it = renaming; setRenaming(null); void act(() => api.patch(`${base}/items/${encodeURIComponent(it.id)}`, { name, etag: it.etag }), `Renamed to “${name}”.`); }} />}
      {moving && (
        <Modal title={`Move “${moving.name}”`} onClose={() => setMoving(null)} wide>
          <CloudBrowser account={account} mode="pick-folder" pickLabel="Move here"
            onPickFolder={(dest) => { const it = moving; setMoving(null); void act(() => api.patch(`${base}/items/${encodeURIComponent(it.id)}`, { parentId: dest.id, etag: it.etag }), `Moved “${it.name}” to ${dest.name}.`); }} />
        </Modal>
      )}
      {deleting && (
        <ConfirmDialog
          title={isGoogle ? `Move “${deleting.name}” to the trash?` : `Delete “${deleting.name}”?`}
          message={<p style={{ margin: 0 }}>
            It goes to the {isGoogle ? "Google Drive trash" : "OneDrive recycle bin"}, where you can restore it.
            {deleting.isFolder ? " Everything inside the folder goes with it." : ""} Records it's linked to will show it as missing.
          </p>}
          confirmLabel={isGoogle ? "Move to trash" : "Delete"}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => { const it = deleting; setDeleting(null); void act(() => api.del(`${base}/items/${encodeURIComponent(it.id)}${it.etag ? `?etag=${encodeURIComponent(it.etag)}` : ""}`), `“${it.name}” moved to the ${isGoogle ? "trash" : "recycle bin"}.`); }}
        />
      )}
      {conflictFile && (
        <ConfirmDialog
          title="A file with that name is already here"
          message={<p style={{ margin: 0 }}>“{conflictFile.name}” already exists in {here.name}. Nothing was overwritten. Keep both (the new one gets a numbered name)?</p>}
          confirmLabel="Keep both"
          onCancel={() => setConflictFile(null)}
          onConfirm={() => { const f = conflictFile; setConflictFile(null); void doUpload(f, "rename"); }}
        />
      )}
      {preview && (
        <Modal title={preview.item.name} onClose={() => setPreview(null)} wide
          footer={<>
            {preview.item.webUrl && <a className="integration-link-btn" href={preview.item.webUrl} target="_blank" rel="noreferrer noopener">Open in {PROVIDER_LABEL[account.provider as "onedrive" | "googledrive"]} ↗</a>}
            <button onClick={() => setPreview(null)}>Close</button>
          </>}>
          {preview.url
            ? <iframe className="cb-preview" src={preview.url} title={`Preview of ${preview.item.name}`} sandbox="allow-scripts allow-same-origin allow-popups allow-forms" referrerPolicy="no-referrer" />
            : <p className="muted" style={{ margin: 0 }}>No preview is available for this file type. Download it or open it at the provider.</p>}
        </Modal>
      )}
    </div>
  );
}

function NameModal({ title, label, initial, confirm, onClose, onSave }: {
  title: string; label: string; initial: string; confirm: string; onClose: () => void; onSave: (name: string) => void;
}) {
  const [v, setV] = useState(initial);
  const ok = v.trim() && v.trim() !== initial;
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!ok} onClick={() => onSave(v.trim())}>{confirm}</button>
    </>}>
      <div className="field" style={{ marginBottom: 0 }}><label>{label}</label>
        <input autoFocus value={v} maxLength={200} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && ok) onSave(v.trim()); }} />
      </div>
    </Modal>
  );
}
