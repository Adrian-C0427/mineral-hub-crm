import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Download, ExternalLink, FileText, FileSpreadsheet, Folder, FolderInput, FolderPlus, Image as ImageIcon, Link2, Plus, Presentation, Search, Upload, X } from "lucide-react";
import { api, ApiError } from "../api/client";
import { Banner, ConfirmDialog, Modal, OverflowMenu, Spinner, showToast } from "./ui";
import { Avatar } from "./kit";
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
 *                preview, open at the provider, link to a record — laid out
 *                as the design's browser + inspector (stat strip, toolbar,
 *                table, side panel for the selected file)
 *   pick-files   choose files (e.g. to link or import into a record)
 *   pick-folder  choose a destination folder (move, copy-to-drive)
 * Every action is the provider's own and is offered only when the item's
 * capabilities allow it. Nothing is overwritten: name conflicts ask first.
 */

type Crumb = { id: string | null; name: string };
type TypeFilter = "all" | "folder" | "sheet" | "doc" | "pdf";
type SortKey = "name" | "mod" | "size";

/** The design's file tiles: one colour per kind, used for the icon and its tinted tile. */
function kindClass(i: CloudItem): "folder" | "sheet" | "slides" | "image" | "pdf" | "doc" {
  if (i.isFolder) return "folder";
  if (i.kind === "google-sheet" || /sheet|excel|csv/.test(i.mimeType ?? "")) return "sheet";
  if (i.kind === "google-slides" || /presentation|powerpoint/.test(i.mimeType ?? "")) return "slides";
  if ((i.mimeType ?? "").startsWith("image/")) return "image";
  if (i.mimeType === "application/pdf") return "pdf";
  return "doc";
}

function ItemIcon({ i, size = 16 }: { i: CloudItem; size?: number }) {
  const k = kindClass(i);
  const cls = `cb-ico ${k}`;
  if (k === "folder") return <Folder size={size} className={cls} aria-hidden="true" />;
  if (k === "sheet") return <FileSpreadsheet size={size} className={cls} aria-hidden="true" />;
  if (k === "slides") return <Presentation size={size} className={cls} aria-hidden="true" />;
  if (k === "image") return <ImageIcon size={size} className={cls} aria-hidden="true" />;
  return <FileText size={size} className={cls} aria-hidden="true" />;
}

const typeOf = (i: CloudItem): TypeFilter => {
  const k = kindClass(i);
  return k === "folder" ? "folder" : k === "sheet" ? "sheet" : k === "pdf" ? "pdf" : k === "doc" ? "doc" : "all";
};

export function CloudBrowser({ account, mode, selected, onToggle, onPickFolder, onLinkItem, onLinkItems, toolsSlot, pickLabel = "Choose this folder" }: {
  account: ConnectedAccount;
  mode: "manage" | "pick-files" | "pick-folder";
  selected?: ReadonlySet<string>;
  onToggle?: (item: CloudItem) => void;
  onPickFolder?: (folder: Crumb) => void;
  onLinkItem?: (item: CloudItem) => void;
  /** Several files at once (the selection bar). Falls back to one call per file. */
  onLinkItems?: (items: CloudItem[]) => void;
  /** Where the manage mode's New folder / Upload buttons render (the page header). */
  toolsSlot?: HTMLElement | null;
  pickLabel?: string;
}) {
  const isGoogle = account.provider === "googledrive";
  const providerLabel = PROVIDER_LABEL[account.provider as "onedrive" | "googledrive"];
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
  // Manage-mode presentation state: the inspected file, checked rows, the
  // type filter and sort — all over the items already loaded.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "mod", dir: -1 });
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
  useEffect(() => { void load(false); setChecked(new Set()); setActiveId(null); }, [base, here.id, view, query]);
  useEffect(() => {
    if (mode !== "manage") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (checked.size) setChecked(new Set()); else setActiveId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, checked.size]);

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
      showToast(`Uploaded “${file.name}” to ${providerLabel}.`);
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

  /** Per-item actions: the same list in the row menu and the inspector. */
  const menuFor = (i: CloudItem) => [
    ...(!i.isFolder ? [{ label: "Preview", onClick: () => void showPreview(i) }] : []),
    ...(!i.isFolder && i.canDownload && i.exportFormats.length === 0 ? [{ label: "Download", onClick: () => void download(i) }] : []),
    ...i.exportFormats.map((f) => ({ label: `Download as ${EXPORT_LABEL[f]}`, onClick: () => void download(i, f) })),
    ...(!i.isFolder && onLinkItem ? [{ label: "Link to a record…", onClick: () => onLinkItem(i) }] : []),
    ...(i.canRename ? [{ label: "Rename…", onClick: () => setRenaming(i) }] : []),
    ...(i.canEdit && !atRootList ? [{ label: "Move to…", onClick: () => setMoving(i) }] : []),
    ...(i.canDelete ? [{ label: isGoogle ? "Move to trash" : "Delete (to recycle bin)", danger: true, onClick: () => setDeleting(i) }] : []),
  ];

  const tools = canWriteHere ? (
    <div className="cb-tools">
      <button className={mode === "manage" ? "fb-btn" : "small"} onClick={() => setNewFolder(true)}><FolderPlus size={14} aria-hidden="true" /> New folder</button>
      <button className={mode === "manage" ? "fb-btn primary" : "small primary"} disabled={!!upload} onClick={() => fileRef.current?.click()}><Upload size={14} aria-hidden="true" /> Upload</button>
      <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void doUpload(f); }} />
    </div>
  ) : null;

  const dialogs = (
    <>
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
            {preview.item.webUrl && <a className="integration-link-btn" href={preview.item.webUrl} target="_blank" rel="noreferrer noopener">Open in {providerLabel} ↗</a>}
            <button onClick={() => setPreview(null)}>Close</button>
          </>}>
          {preview.url
            ? <iframe className="cb-preview" src={preview.url} title={`Preview of ${preview.item.name}`} sandbox="allow-scripts allow-same-origin allow-popups allow-forms" referrerPolicy="no-referrer" />
            : <p className="muted" style={{ margin: 0 }}>No preview is available for this file type. Download it or open it at the provider.</p>}
        </Modal>
      )}
    </>
  );

  if (mode === "manage") {
    return (
      <ManageLayout
        account={account} isGoogle={isGoogle} providerLabel={providerLabel} rootName={rootName}
        view={view} switchView={switchView} q={q} setQ={setQ} query={query} setQuery={setQuery}
        stack={stack} crumbTo={crumbTo} items={items} loading={loading} cursor={cursor} loadMore={() => void load(true)}
        upload={upload} err={err} open={open} showPreview={showPreview} download={download} setMoving={setMoving} menuFor={menuFor}
        onLinkItem={onLinkItem} onLinkItems={onLinkItems}
        activeId={activeId} setActiveId={setActiveId} checked={checked} setChecked={setChecked}
        typeFilter={typeFilter} setTypeFilter={setTypeFilter} sort={sort} setSort={setSort}
        tools={tools} toolsSlot={toolsSlot ?? null} dialogs={dialogs}
      />
    );
  }

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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${providerLabel}`} aria-label="Search files" />
          {query && <button type="button" className="cb-clear" onClick={() => { setQ(""); setQuery(""); }}>Clear</button>}
        </form>
        {tools}
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
      {dialogs}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Files page layout (manage mode): stat strip, toolbar, table, inspector.
// Everything here is presentation over the items the browser already loaded
// and the handlers above; no new requests.
// ---------------------------------------------------------------------------

const TYPE_FILTERS: { key: TypeFilter; label: string }[] = [
  { key: "all", label: "All" }, { key: "folder", label: "Folders" }, { key: "sheet", label: "Sheets" }, { key: "doc", label: "Docs" }, { key: "pdf", label: "PDFs" },
];

function ManageLayout(p: {
  account: ConnectedAccount; isGoogle: boolean; providerLabel: string; rootName: string;
  view: CloudView; switchView: (v: CloudView) => void; q: string; setQ: (v: string) => void; query: string; setQuery: (v: string) => void;
  stack: Crumb[]; crumbTo: (idx: number) => void; items: CloudItem[]; loading: boolean; cursor: string | null; loadMore: () => void;
  upload: { name: string; pct: number } | null; err: string | null;
  open: (i: CloudItem) => void; showPreview: (i: CloudItem) => Promise<void>; download: (i: CloudItem, format?: string) => Promise<void>;
  setMoving: (i: CloudItem) => void; menuFor: (i: CloudItem) => { label: string; danger?: boolean; onClick: () => void }[];
  onLinkItem?: (item: CloudItem) => void; onLinkItems?: (items: CloudItem[]) => void;
  activeId: string | null; setActiveId: (id: string | null) => void; checked: Set<string>; setChecked: (s: Set<string>) => void;
  typeFilter: TypeFilter; setTypeFilter: (t: TypeFilter) => void; sort: { key: SortKey; dir: 1 | -1 }; setSort: (s: { key: SortKey; dir: 1 | -1 }) => void;
  tools: ReactNode; toolsSlot: HTMLElement | null; dialogs: ReactNode;
}) {
  const { items, query, checked, sort, typeFilter } = p;
  const here = p.stack[p.stack.length - 1];
  const counts = useMemo(() => {
    const c: Record<TypeFilter, number> = { all: items.length, folder: 0, sheet: 0, doc: 0, pdf: 0 };
    for (const i of items) { const t = typeOf(i); if (t !== "all") c[t]++; }
    return c;
  }, [items]);
  const visible = useMemo(() => {
    const list = items.filter((i) => typeFilter === "all" || typeOf(i) === typeFilter);
    const cmp = (a: CloudItem, b: CloudItem) => {
      let r = 0;
      if (sort.key === "name") r = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      else if (sort.key === "size") r = (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0);
      else r = (a.modifiedAt ?? "").localeCompare(b.modifiedAt ?? "");
      return (r || a.name.localeCompare(b.name)) * sort.dir;
    };
    const folders = list.filter((i) => i.isFolder).sort(cmp);
    const files = list.filter((i) => !i.isFolder).sort(cmp);
    return { folders, files };
  }, [items, typeFilter, sort]);
  const files = items.filter((i) => !i.isFolder);
  const folders = items.length - files.length;
  const weekAgo = Date.now() - 7 * 86_400_000;
  const recentCount = files.filter((i) => i.modifiedAt && new Date(i.modifiedAt).getTime() >= weekAgo).length;
  const active = items.find((i) => i.id === p.activeId) ?? null;
  const checkedItems = items.filter((i) => checked.has(i.id));
  const allIds = [...visible.folders, ...visible.files].map((i) => i.id);
  const allChecked = allIds.length > 0 && allIds.every((id) => checked.has(id));
  const toggleChecked = (id: string) => { const n = new Set(checked); n.has(id) ? n.delete(id) : n.add(id); p.setChecked(n); };
  const sortBtn = (key: SortKey, label: string, right = false) => (
    <button type="button" className={`fb-th fb-sort ${sort.key === key ? "active" : ""} ${right ? "right" : ""}`}
      onClick={() => p.setSort(sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 })}>
      <span>{label}</span><ChevronDown size={11} aria-hidden="true" style={{ transform: sort.key === key && sort.dir === 1 ? "rotate(180deg)" : undefined }} />
    </button>
  );
  const linkMany = () => {
    const files = checkedItems.filter((i) => !i.isFolder);
    if (!files.length) return;
    if (p.onLinkItems) p.onLinkItems(files); else p.onLinkItem?.(files[0]);
  };
  const downloadMany = () => { for (const i of checkedItems) if (!i.isFolder && i.canDownload && i.exportFormats.length === 0) void p.download(i); };
  const canDownloadMany = checkedItems.some((i) => !i.isFolder && i.canDownload && i.exportFormats.length === 0);
  const recent = [...files].sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? "")).slice(0, 6);

  const row = (i: CloudItem) => {
    const isActive = i.id === p.activeId;
    const isChecked = checked.has(i.id);
    return (
      <div key={i.id} role="row" className={`fb-row ${isActive ? "is-active" : ""} ${isChecked ? "is-checked" : ""}`}
        onClick={() => (i.isFolder ? p.open(i) : p.setActiveId(isActive ? null : i.id))}>
        <div className="fb-td fb-td-check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" className="fb-check" checked={isChecked} aria-label={`Select ${i.name}`} onChange={() => toggleChecked(i.id)} />
        </div>
        <div className="fb-td fb-td-name">
          <span className={`fb-tile ${kindClass(i)}`}><ItemIcon i={i} /></span>
          <span className="fb-name-wrap">
            <button type="button" className="fb-name" title={i.name} onClick={(e) => { e.stopPropagation(); p.open(i); }}>{i.name}</button>
            <span className="fb-sub">{kindLabel(i)}</span>
          </span>
        </div>
        <div className="fb-td fb-td-link" onClick={(e) => e.stopPropagation()}>
          {!i.isFolder && p.onLinkItem && (
            <button type="button" className="fb-linkbtn" onClick={() => p.onLinkItem?.(i)} title="Link this file to a deal, asset, contact or buyer"><Plus size={12} aria-hidden="true" /> Link</button>
          )}
        </div>
        <div className="fb-td fb-td-type">{kindLabel(i)}</div>
        <div className="fb-td fb-td-mod">
          {i.modifiedBy && <Avatar name={i.modifiedBy} size={20} title={i.modifiedBy} />}
          <span>{i.modifiedAt ? fmtDateLocal(i.modifiedAt) : "—"}</span>
        </div>
        <div className={`fb-td fb-td-size ${i.isFolder ? "dim" : ""}`}>{i.isFolder ? "—" : humanBytes(i.sizeBytes)}</div>
        <div className="fb-td fb-td-actions" onClick={(e) => e.stopPropagation()}>
          {i.webUrl && <a className="fb-iconbtn" href={i.webUrl} target="_blank" rel="noreferrer noopener" title={`Open in ${p.providerLabel}`}><ExternalLink size={14} /></a>}
          <OverflowMenu ariaLabel={`Actions for ${i.name}`} items={p.menuFor(i)} />
        </div>
      </div>
    );
  };

  const group = (key: string, title: string, meta: string, rows: CloudItem[]) => rows.length === 0 ? null : (
    <div key={key} className="fb-group">
      <div className="fb-group-head" role="row"><span className="fb-group-title">{title}</span><span className="fb-group-meta">{meta}</span></div>
      {rows.map(row)}
    </div>
  );

  return (
    <div className="fb">
      {p.toolsSlot && p.tools ? createPortal(p.tools, p.toolsSlot) : null}

      <div className="fb-kpis">
        <div className="fb-kpi"><span className="fb-kpi-label">Files</span><span className="fb-kpi-row"><span className="fb-kpi-value">{files.length}</span><span className="fb-kpi-note">{query ? "matching" : `in ${here.name}`}</span></span></div>
        <div className="fb-kpi"><span className="fb-kpi-label">Folders</span><span className="fb-kpi-row"><span className="fb-kpi-value">{folders}</span><span className="fb-kpi-note">{p.cursor ? "more available" : `${items.length} ${items.length === 1 ? "item" : "items"} in all`}</span></span></div>
        <div className="fb-kpi"><span className="fb-kpi-label">Updated this week</span><span className="fb-kpi-row"><span className="fb-kpi-value">{recentCount}</span><span className="fb-kpi-note">{files.length ? `${Math.round((recentCount / files.length) * 100)}% of files` : "—"}</span></span></div>
        <div className="fb-kpi"><span className="fb-kpi-label">Selected</span><span className="fb-kpi-row"><span className="fb-kpi-value">{checked.size}</span><span className={`fb-kpi-note ${checked.size ? "ok" : ""}`}>{checked.size ? "ready to link or download" : "tick files to act on several"}</span></span></div>
      </div>

      <div className="fb-grid">
        <section className="fb-main">
          {checked.size > 0 ? (
            <div className="fb-selbar">
              <div className="fb-selbar-actions">
                <span className="fb-sel-count">{checked.size} selected</span>
                <button type="button" className="fb-selbtn" disabled={!checkedItems.some((i) => !i.isFolder)} onClick={linkMany}><Link2 size={13} aria-hidden="true" /> Link to record</button>
                <button type="button" className="fb-selbtn" disabled={!canDownloadMany} onClick={downloadMany}>Download</button>
              </div>
              <button type="button" className="fb-selclear" onClick={() => p.setChecked(new Set())}>Clear selection</button>
            </div>
          ) : (
            <div className="fb-toolbar">
              <div className="fb-toolbar-left">
                {p.isGoogle && (
                  <div className="fb-seg" role="tablist" aria-label="Drive section">
                    {(["mine", "shared", "drives"] as CloudView[]).map((v) => (
                      <button key={v} type="button" role="tab" aria-selected={p.view === v} className={`fb-seg-btn ${p.view === v ? "active" : ""}`} onClick={() => p.switchView(v)}>
                        {v === "mine" ? "My Drive" : v === "shared" ? "Shared with me" : "Shared drives"}
                      </button>
                    ))}
                  </div>
                )}
                <form className="fb-search" onSubmit={(e) => { e.preventDefault(); p.setQuery(p.q.trim()); }}>
                  <Search size={14} aria-hidden="true" />
                  <input value={p.q} onChange={(e) => p.setQ(e.target.value)} placeholder={`Search files in ${query ? p.providerLabel : here.name}`} aria-label="Search files" />
                  {query && <button type="button" className="fb-iconbtn" title="Clear search" onClick={() => { p.setQ(""); p.setQuery(""); }}><X size={13} /></button>}
                </form>
                <div className="fb-seg" role="group" aria-label="File type">
                  {TYPE_FILTERS.map((t) => (
                    <button key={t.key} type="button" className={`fb-seg-btn ${typeFilter === t.key ? "active" : ""}`} onClick={() => { p.setTypeFilter(t.key); p.setChecked(new Set()); }}>
                      <span>{t.label}</span><span className="fb-seg-count">{counts[t.key]}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="fb-crumbrow">
            <nav className="fb-crumbs" aria-label="Folder path">
              <Folder size={14} aria-hidden="true" />
              <span className="fb-crumb-provider">{p.providerLabel}</span>
              {query ? <><span className="fb-crumb-sep">/</span><span className="fb-crumb current">Search results for “{query}”</span></> : p.stack.map((c, idx) => (
                <span key={`${c.id}-${idx}`} className="fb-crumb-wrap">
                  <span className="fb-crumb-sep">/</span>
                  {idx === p.stack.length - 1 ? <span className="fb-crumb current">{c.name}</span>
                    : <button type="button" className="fb-crumb" onClick={() => p.crumbTo(idx)}>{c.name}</button>}
                </span>
              ))}
            </nav>
            <div className="fb-crumb-meta">
              <span>{visible.folders.length + visible.files.length} of {items.length} items</span>
              {p.cursor && !p.loading && <><span className="fb-vsep" /><button type="button" className="link-btn fb-more" onClick={p.loadMore}>Load more</button></>}
            </div>
          </div>

          {p.upload && (
            <div className="cb-progress fb-progress" role="status">
              Uploading “{p.upload.name}”… {p.upload.pct < 100 ? `${p.upload.pct}%` : "finishing at the provider"}
              <span className="cb-progress-bar"><i style={{ width: `${p.upload.pct}%` }} /></span>
            </div>
          )}
          {p.err && <div className="fb-banner"><Banner kind="error">{p.err}</Banner></div>}

          <div className="fb-scroll">
            <div className="fb-table" role="table" aria-label={`${p.providerLabel} files`}>
              <div className="fb-head" role="row">
                <div className="fb-td fb-td-check">
                  <input type="checkbox" className="fb-check" aria-label="Select all" checked={allChecked}
                    ref={(el) => { if (el) el.indeterminate = checked.size > 0 && !allChecked; }}
                    onChange={() => p.setChecked(allChecked ? new Set() : new Set(allIds))} />
                </div>
                {sortBtn("name", "Name")}
                <div className="fb-th">Link to record</div>
                <div className="fb-th">Type</div>
                {sortBtn("mod", "Modified")}
                {sortBtn("size", "Size", true)}
                <div className="fb-th" />
              </div>
              {group("folders", "Folders", `${visible.folders.length} ${visible.folders.length === 1 ? "folder" : "folders"}`, visible.folders)}
              {group("files", "Files", `${visible.files.length} ${visible.files.length === 1 ? "file" : "files"}`, visible.files)}
              {p.loading && <Spinner label="Loading…" />}
              {!p.loading && visible.folders.length + visible.files.length === 0 && (
                <div className="fb-empty">
                  <Search size={28} aria-hidden="true" />
                  <span className="fb-empty-title">{items.length ? "No files match" : query ? "No matches" : "This folder is empty"}</span>
                  <span>{items.length ? "Try another search or clear the type filter." : query ? "Try another search." : "Upload a file or create a folder to get started."}</span>
                </div>
              )}
            </div>
          </div>

          <div className="fb-foot">
            <span>{files.length} {files.length === 1 ? "file" : "files"} · {folders} {folders === 1 ? "folder" : "folders"}</span>
            <span className="fb-connected"><i /> {p.providerLabel} connected{p.account.email ? ` · ${p.account.email}` : ""}</span>
          </div>
        </section>

        <aside className="fb-inspector" aria-label={active ? `Details for ${active.name}` : "Drive overview"}>
          {active ? (
            <>
              <div className="fb-insp-head">
                <div className="fb-insp-top">
                  <span className={`fb-tile lg ${kindClass(active)}`}><ItemIcon i={active} size={22} /></span>
                  <button type="button" className="fb-iconbtn" aria-label="Close" onClick={() => p.setActiveId(null)}><X size={14} /></button>
                </div>
                <div className="fb-insp-title">
                  <span className="fb-insp-name">{active.name}</span>
                  <span className="fb-insp-sub">{kindLabel(active)}{active.modifiedAt ? ` · ${fmtDateLocal(active.modifiedAt)}` : ""}</span>
                </div>
                <div className="fb-insp-actions">
                  {active.webUrl
                    ? <a className="fb-btn primary grow" href={active.webUrl} target="_blank" rel="noreferrer noopener"><ExternalLink size={13} aria-hidden="true" /> Open</a>
                    : <button type="button" className="fb-btn primary grow" onClick={() => void p.showPreview(active)}>Preview</button>}
                  {active.canDownload && active.exportFormats.length === 0 && <button type="button" className="fb-btn icon" title="Download" onClick={() => void p.download(active)}><Download size={14} /></button>}
                  {active.canEdit && <button type="button" className="fb-btn icon" title="Move" onClick={() => p.setMoving(active)}><FolderInput size={14} /></button>}
                  <span className="fb-btn icon menu"><OverflowMenu ariaLabel={`More actions for ${active.name}`} items={p.menuFor(active)} /></span>
                </div>
              </div>
              <dl className="fb-insp-kv">
                <div><dt>Location</dt><dd>{query ? "Search results" : here.name}</dd></div>
                <div><dt>Type</dt><dd>{kindLabel(active)}</dd></div>
                <div><dt>Modified</dt><dd>{active.modifiedAt ? fmtDateLocal(active.modifiedAt) : "—"}{active.modifiedBy ? ` · ${active.modifiedBy}` : ""}</dd></div>
                {active.owner && <div><dt>Owner</dt><dd>{active.owner}</dd></div>}
                {!active.isFolder && <div><dt>Size</dt><dd>{humanBytes(active.sizeBytes)}</dd></div>}
              </dl>
              {!active.isFolder && (
                <div className="fb-insp-links">
                  <div className="fb-insp-links-head">
                    <span>Linked records</span>
                    {p.onLinkItem && <button type="button" className="fb-linkadd" onClick={() => p.onLinkItem?.(active)}><Plus size={11} aria-hidden="true" /> Link</button>}
                  </div>
                  <div className="fb-insp-links-note">Attach this file to a deal, asset, contact or buyer so it shows up on that record. Links already made are listed on each record's Documents.</div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="fb-insp-head">
                <span className="fb-insp-name">Drive overview</span>
                <span className="fb-insp-sub">Select a file to see details and link it.</span>
              </div>
              <dl className="fb-insp-kv">
                <div><dt>Account</dt><dd>{p.account.email ?? p.account.displayName ?? p.providerLabel}</dd></div>
                <div><dt>Location</dt><dd>{query ? "Search results" : here.name}</dd></div>
                <div><dt>Items here</dt><dd>{items.length}{p.cursor ? "+" : ""}</dd></div>
              </dl>
              <div className="fb-insp-recent">
                <span className="fb-insp-links-head"><span>Recently modified</span></span>
                {recent.length === 0 ? <div className="fb-insp-links-note">No files in this folder yet.</div> : (
                  <div className="fb-recent-list">
                    {recent.map((i) => (
                      <button type="button" key={i.id} className="fb-recent" onClick={() => p.setActiveId(i.id)}>
                        <span className={`fb-tile sm ${kindClass(i)}`}><ItemIcon i={i} size={13} /></span>
                        <span className="fb-recent-text">
                          <span className="fb-recent-name">{i.name}</span>
                          <span className="fb-recent-sub">{i.modifiedBy ? `Edited by ${i.modifiedBy.split(" ")[0]} · ` : ""}{i.modifiedAt ? fmtDateLocal(i.modifiedAt) : ""}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
      {p.dialogs}
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
