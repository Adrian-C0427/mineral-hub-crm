import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { Modal, ConfirmDialog } from "./ui";

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

export function MapShpImport({ onChanged, dealId, compact = false }: {
  onChanged: (bbox: BBox | null) => void;
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
  const fileRef = useRef<HTMLInputElement>(null);

  const listUrl = dealId ? `/map/tracts/imports?dealId=${encodeURIComponent(dealId)}` : "/map/tracts/imports";
  const loadImports = () => api.get<ImportRow[]>(listUrl).then(setImports).catch(() => setImports([]));
  useEffect(() => { if (open) void loadImports(); }, [open]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true); setError(null); setDone(null);
    try {
      const form = new FormData();
      if (dealId) form.append("dealId", dealId);
      for (const f of Array.from(files)) form.append("files", f);
      const res = await api.upload<ImportResult>("/map/tracts/import", form);
      setDone(res);
      void loadImports();
      onChanged(res.bbox);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setBusy(false);
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

  return (
    <>
      <button type="button" className={`mshp-btn ${compact ? "compact" : ""}`} onClick={() => setOpen(true)} title={dealId ? "Import tract boundaries for this deal from a shapefile (also shown on the main map)" : "Import tract boundaries from a shapefile"}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
        Import SHP
      </button>
      {open && (
        <Modal title={dealId ? "Import tract boundaries for this deal" : "Import tract boundaries"} subtitle={<>Upload a shapefile — a <strong>.zip</strong>, or the <strong>.shp</strong> with its .dbf and .prj alongside{dealId ? <> · they also appear on the main map</> : null}</>} onClose={() => setOpen(false)}
          footer={<button onClick={() => setOpen(false)}>Close</button>}>
          <label className={`mshp-drop ${busy ? "busy" : ""}`}>
            <input ref={fileRef} type="file" accept=".zip,.shp,.dbf,.prj,.shx,.cpg" multiple style={{ display: "none" }}
              disabled={busy} onChange={(e) => void upload(e.target.files)} />
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
            <div><strong>{busy ? "Importing…" : "Choose shapefile"}</strong></div>
            <div className="muted" style={{ fontSize: 12 }}>Polygon boundaries are mapped automatically; the .prj converts projected coordinates to lon/lat.</div>
          </label>
          {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
          {done && (
            <div className="mshp-done" role="status">
              Imported <strong>{done.count}</strong> boundar{done.count === 1 ? "y" : "ies"} from {done.sourceFile}
              {done.skipped > 0 ? <span className="muted"> · {done.skipped} non-polygon feature{done.skipped === 1 ? "" : "s"} skipped</span> : null}
            </div>
          )}

          <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", margin: "16px 0 6px" }}>{dealId ? "Shapefiles imported for this deal" : "Uploaded shapefiles"}</div>
          {imports === null ? (
            <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
          ) : imports.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>Nothing imported yet.</p>
          ) : imports.map((r) => (
            <div key={r.importId} className="row" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", padding: "8px 0", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sourceFile}</div>
                <div className="muted" style={{ fontSize: 12 }}>{r.count} boundar{r.count === 1 ? "y" : "ies"}{r.createdAt ? ` · ${r.createdAt.slice(0, 10)}` : ""}{!dealId && r.dealId ? ` · from deal ${r.dealName ?? ""}` : ""}</div>
              </div>
              <button type="button" className="small danger" onClick={() => setConfirmDel(r)}>Remove</button>
            </div>
          ))}
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
