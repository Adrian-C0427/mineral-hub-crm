import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { Modal, ConfirmDialog } from "./ui";
import { fmtDate } from "../lib/format";

/**
 * "Import SHP" control for the main map and every deal map: upload a shapefile
 * (a .zip, or the loose .shp/.dbf/.prj set) and its polygon boundaries become
 * "Imported tracts". From a deal map (`dealId`) the import is linked to that
 * deal — it shows on the deal's map AND the main map, from one stored copy.
 * Also lists prior uploads so any import can be removed as a unit. Parsing/
 * reprojection happens server-side; on success the map refetches the overlay
 * and flies to the imported extent (via onChanged).
 */

type BBox = [number, number, number, number];
interface ImportRow { importId: string; sourceFile: string; count: number; createdAt: string | null; dealId?: string | null; dealName?: string | null }
interface ImportResult { importId: string; sourceFile: string; count: number; skipped: number; bbox: BBox | null }

export function MapShpImport({ onChanged, onShow, dealId, compact = false }: {
  onChanged: (bbox: BBox | null) => void;
  /** Frame one upload on the map ("Show on map" on its row). */
  onShow?: (importId: string) => void;
  /** Import from a deal's map: links the tracts to this deal. */
  dealId?: string;
  /** Smaller button for the deal map's control stack. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [imports, setImports] = useState<ImportRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [confirmDel, setConfirmDel] = useState<ImportRow | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Name shown on the in-flight row while the server parses the upload.
  const [pending, setPending] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const listUrl = dealId ? `/map/tracts/imports?dealId=${encodeURIComponent(dealId)}` : "/map/tracts/imports";
  const loadImports = () => api.get<ImportRow[]>(listUrl).then(setImports).catch(() => setImports([]));
  useEffect(() => { if (open) void loadImports(); }, [open]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true); setError(null); setDone(null);
    const list = Array.from(files);
    setPending(list.find((f) => /\.(zip|shp)$/i.test(f.name))?.name ?? list[0].name);
    try {
      const form = new FormData();
      if (dealId) form.append("dealId", dealId);
      for (const f of list) form.append("files", f);
      const res = await api.upload<ImportResult>("/map/tracts/import", form);
      setDone(res);
      void loadImports();
      onChanged(res.bbox);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setBusy(false); setPending(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeImport(row: ImportRow) {
    setError(null);
    try {
      await api.del(`/map/tracts/imports/${row.importId}`);
      setDone(null);
      void loadImports();
      onChanged(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed");
    }
  }

  const files = imports ?? [];
  const totalBoundaries = files.reduce((n, r) => n + r.count, 0);

  return (
    <>
      <button type="button" className={`mshp-btn ${compact ? "compact" : ""}`} onClick={() => setOpen(true)} title={dealId ? "Import tract boundaries for this deal from a shapefile (also shown on the main map)" : "Import tract boundaries from a shapefile"}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V4M7 9l5-5 5 5M5 20h14" /></svg>
        Import SHP
      </button>
      {open && (
        <Modal title={dealId ? "Import tract boundaries for this deal" : "Import tract boundaries"} subtitle={<>Upload a shapefile — a .zip, or the .shp with its .dbf and .prj alongside{dealId ? <> · they also appear on the main map</> : null}</>} onClose={() => setOpen(false)}
          footer={<button type="button" className="primary" onClick={() => setOpen(false)}>Done</button>}>
          <div className="mshp-body">
            {/* Click to browse, or drop the files straight onto the zone — both
                send every selected file (the full .shp/.dbf/.prj/.shx/.cpg set). */}
            <label className={`mshp-drop ${busy ? "busy" : ""} ${dragOver ? "over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!busy) void upload(e.dataTransfer.files); }}>
              <input ref={fileRef} type="file" accept=".zip,.shp,.dbf,.prj,.shx,.cpg" multiple style={{ display: "none" }}
                disabled={busy} onChange={(e) => void upload(e.target.files)} />
              <span className="mshp-drop-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V4M7 9l5-5 5 5M5 20h14" /></svg></span>
              <span className="mshp-drop-title">{busy ? "Importing…" : <>Drop a shapefile here, or <span className="mshp-browse">browse</span></>}</span>
              <span className="mshp-drop-help">Polygon boundaries are mapped automatically. The .prj converts projected coordinates to lon/lat.</span>
              <span className="mshp-formats" aria-hidden="true"><span>.ZIP</span><span>.SHP</span><span>.DBF</span><span>.PRJ</span></span>
            </label>
            {error && <div className="error-text">{error}</div>}
            {done && (
              <div className="mshp-done" role="status">
                Imported <strong>{done.count}</strong> boundar{done.count === 1 ? "y" : "ies"} from {done.sourceFile}
                {done.skipped > 0 ? <span className="muted"> · {done.skipped} non-polygon feature{done.skipped === 1 ? "" : "s"} skipped</span> : null}
              </div>
            )}

            <div className="mshp-list-wrap">
              <div className="mshp-list-head">
                <span>{dealId ? "Shapefiles imported for this deal" : "Uploaded shapefiles"}</span>
                {files.length > 0 && <span className="mshp-list-sum">{totalBoundaries} boundar{totalBoundaries === 1 ? "y" : "ies"} in {files.length} file{files.length === 1 ? "" : "s"}</span>}
              </div>
              <div className="mshp-list">
                {busy && pending && (
                  <div className="mshp-row">
                    <span className="mshp-row-icon" aria-hidden="true"><MapGlyph /></span>
                    <div className="mshp-row-main"><span className="mshp-row-name">{pending}</span><span className="mshp-row-meta processing">Processing boundaries…</span></div>
                  </div>
                )}
                {imports === null ? (
                  <div className="mshp-list-empty">Loading…</div>
                ) : imports.length === 0 ? (
                  !busy && <div className="mshp-list-empty">Nothing imported yet.</div>
                ) : imports.map((r) => (
                  <div key={r.importId} className="mshp-row">
                    <span className="mshp-row-icon" aria-hidden="true"><MapGlyph /></span>
                    <div className="mshp-row-main">
                      <span className="mshp-row-name" title={r.sourceFile}>{r.sourceFile}</span>
                      <span className="mshp-row-meta">{r.count} boundar{r.count === 1 ? "y" : "ies"}{r.createdAt ? ` · ${fmtDate(r.createdAt)}` : ""}{!dealId && r.dealId ? ` · from deal ${r.dealName ?? ""}` : ""}</span>
                    </div>
                    <div className="mshp-row-actions">
                      {onShow && <button type="button" className="small" onClick={() => { setOpen(false); onShow(r.importId); }}>Show on map</button>}
                      <button type="button" className="small mshp-remove" onClick={() => setConfirmDel(r)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
      {confirmDel && (
        <ConfirmDialog
          title="Remove imported boundaries?"
          message={<>All <strong>{confirmDel.count}</strong> boundar{confirmDel.count === 1 ? "y" : "ies"} from <strong>{confirmDel.sourceFile}</strong> will be removed {dealId || confirmDel.dealId ? "from this deal's map and the main map" : "from the map"} for everyone in your workspace.</>}
          confirmLabel="Remove"
          danger
          onConfirm={() => { const r = confirmDel; setConfirmDel(null); void removeImport(r); }}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </>
  );
}

function MapGlyph() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M4 7l6-3 5 3 5-2v12l-5 3-5-3-6 3z" /></svg>;
}
