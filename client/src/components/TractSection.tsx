import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Modal, ConfirmDialog, Spinner, Banner, EmptyState, OverflowMenu } from "./ui";
import { Select } from "./Select";
import { GeoFields } from "./GeoFields";
import { ChevronDown } from "lucide-react";
import { TractMap, type TractMapFeature, type TractSegment } from "./TractMap";
import { exportTractMap } from "../lib/tractExport";

/**
 * Tract Descriptions: paste legal descriptions (deeds/leases/title docs), the
 * server parses metes-and-bounds into calls + a polygon, and the map below
 * draws it in the deal's geography. Anything the parser can't resolve is
 * surfaced per call — nothing fails silently.
 */

interface TractCall {
  seq: number; raw: string; azimuth: number | null; bearing: string | null;
  distanceFt: number | null; distanceRaw: string | null; curve: boolean; issue: string | null;
}
interface ParsedTract {
  ok: boolean; pobText: string | null; calls: TractCall[]; points: [number, number][];
  refs: { abstracts: string[]; surveys: string[]; county: string | null; state: string; statedAcres: number | null; sections: string[]; blocks: string[]; lots: string[]; quarters: string[] };
  closure: { closes: boolean; gapFt: number; precision: number } | null;
  computedAcres: number | null; warnings: string[]; unresolved: string[];
  source?: "rules" | "ai"; confidence?: number | null; assumptions?: string[];
}
interface Tract {
  id: string; name: string; text: string; state: string;
  counties?: string[]; abstractGisIds?: string[];
  parse: ParsedTract | null;
  geometry: GeoJSON.Feature | null;
  anchor: { lon: number; lat: number; source: "abstract" | "manual"; method?: "corner" | "corner-tie" | "area"; corner?: string; abstractId?: string } | null;
  createdAt: string; updatedAt: string;
}

const M_PER_FT = 0.3048, M_PER_DEG = 111320, DEG = Math.PI / 180;

/** Rebuild each resolvable call's segment in lon/lat (mirrors server anchoring). */
function segmentsOf(t: Tract): TractSegment[] {
  if (!t.parse?.ok || !t.anchor) return [];
  const cos = Math.cos(t.anchor.lat * DEG);
  const toLL = ([fx, fy]: [number, number]): [number, number] => [
    t.anchor!.lon + (fx * M_PER_FT) / (M_PER_DEG * cos),
    t.anchor!.lat + (fy * M_PER_FT) / M_PER_DEG,
  ];
  const segs: TractSegment[] = [];
  const pts = t.parse.points;
  // points[0] is the POB; each subsequent point came from the next resolvable call.
  let pi = 0;
  for (const c of t.parse.calls) {
    // Mirrors the server walk: any call with both components contributes.
    if (c.azimuth === null || c.distanceFt === null) continue;
    if (pi >= pts.length) break;
    const from = toLL(pts[pi]);
    // The final call may close the ring exactly (its endpoint was deduped by
    // the parser), so the last segment wraps back to the POB.
    const to = toLL(pi + 1 < pts.length ? pts[pi + 1] : pts[0]);
    segs.push({ tractId: t.id, seq: c.seq, bearing: c.bearing, distance: c.distanceRaw, from, to });
    pi++;
  }
  return segs;
}

export function TractSection({ dealId, dealName, canEdit, abstractIds = [] }: { dealId: string; dealName: string; canEdit: boolean; abstractIds?: string[] }) {
  const { user } = useAuth();
  const [tracts, setTracts] = useState<Tract[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ tract: Tract | null } | null>(null); // null tract = new
  const [deleting, setDeleting] = useState<Tract | null>(null);
  const [placingFor, setPlacingFor] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null); // tract id being regenerated
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mapHandle = useRef<maplibregl.Map | null>(null);

  // Export options.
  const [expFormat, setExpFormat] = useState<"png" | "jpeg" | "svg">("png");
  const [expNotes, setExpNotes] = useState("");

  const load = useCallback(() => api.get<Tract[]>(`/deals/${dealId}/tracts`).then(setTracts).catch((e) => setErr(e.message)), [dealId]);
  useEffect(() => { load(); }, [load]);

  const features: TractMapFeature[] = useMemo(() => (tracts ?? []).map((t) => ({
    id: t.id, name: t.name, geometry: t.geometry,
    pob: t.anchor ? { lon: t.anchor.lon, lat: t.anchor.lat } : null,
    segments: segmentsOf(t),
  })), [tracts]);


  async function placePob(lon: number, lat: number) {
    if (!placingFor) return;
    setPlacingFor(null);
    setBusy(true);
    try { await api.patch(`/deals/${dealId}/tracts/${placingFor}`, { anchor: { lon, lat } }); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  /** Generate Tract Map: deterministic re-parse + anchor + geometry (no AI). */
  async function generate(tractId: string) {
    setGenerating(tractId); setErr(null);
    try { await api.post(`/deals/${dealId}/tracts/${tractId}/generate`); await load(); setSelectedId(tractId); }
    catch (e) { setErr((e as Error).message); }
    finally { setGenerating(null); }
  }

  async function doExport() {
    const map = mapHandle.current;
    if (!map || !tracts) return;
    setBusy(true);
    try {
      await exportTractMap(map, {
        format: expFormat,
        dealName, orgName: user?.organization?.name ?? "Mineral Hub",
        logoUrl: user?.organization?.fullLogo ?? null,
        notes: expNotes.trim() || undefined,
        tracts: tracts.filter((t) => t.geometry).map((t) => ({ name: t.name, acres: t.parse?.computedAcres ?? t.parse?.refs.statedAcres ?? null, closes: t.parse?.closure?.closes ?? null })),
        rings: tracts.filter((t) => t.geometry).map((t) => ({
          name: t.name,
          ring: ((t.geometry!.geometry as GeoJSON.Polygon).coordinates[0] ?? []) as [number, number][],
          pob: t.anchor ? [t.anchor.lon, t.anchor.lat] : null,
        })),
      });
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!tracts) return <div className="panel"><Spinner label="Loading tract descriptions…" /></div>;

  const anyMapped = tracts.some((t) => t.geometry);
  return (
    <div className="panel">
      <div className="section-head">
        <div>
          <h3 style={{ margin: 0 }}>Tract Descriptions</h3>
          <span className="muted" style={{ fontSize: 12 }}>Paste legal descriptions and see them mapped — calls, closure, acreage</span>
        </div>
        {canEdit && <button className="primary small" onClick={() => setEditing({ tract: null })}>+ Add Tract</button>}
      </div>
      {err && <Banner kind="error">{err}</Banner>}

      {tracts.length > 0 && (
        <TractMap
          tracts={features} selectedId={selectedId}
          abstractIds={abstractIds}
          placingPob={placingFor !== null}
          onPobPlaced={placePob}
          onSelect={setSelectedId}
          onReady={(m) => { mapHandle.current = m; }}
        />
      )}
      {generating && <Banner kind="info">Parsing the legal description — boundary calls, closure, acreage and geometry are computed by the built-in tract engine.</Banner>}

      {tracts.length === 0 ? (
        <EmptyState title="No tract descriptions yet">
          Click <strong>+ Add Tract</strong> and paste the legal description from a deed, lease, title commitment
          or purchase agreement — the boundary is parsed and drawn automatically.
        </EmptyState>
      ) : (
        <div className="tract-cards">
          {tracts.map((t) => (
            <TractCard
              key={t.id} tract={t} canEdit={canEdit}
              expanded={t.id === selectedId}
              onToggle={() => setSelectedId(t.id === selectedId ? null : t.id)}
              generating={generating === t.id} anyBusy={busy || generating !== null}
              placing={placingFor === t.id}
              onGenerate={() => generate(t.id)}
              onPlacePob={() => setPlacingFor(placingFor === t.id ? null : t.id)}
              onEdit={() => setEditing({ tract: t })}
              onRemove={() => setDeleting(t)}
            />
          ))}
        </div>
      )}

      {anyMapped && (
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 13 }}>Export map:</span>
          <Select value={expFormat} onChange={(v) => setExpFormat(v as typeof expFormat)} width={150} ariaLabel="Export format"
            options={[{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }, { value: "svg", label: "SVG (vector)" }]} />
          <input placeholder="Optional notes for the export…" value={expNotes} onChange={(e) => setExpNotes(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
          <button className="primary small" disabled={busy} onClick={doExport}>Export</button>
        </div>
      )}

      {editing && (
        <TractEditor
          dealId={dealId} tract={editing.tract}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Remove tract description"
          message={<>Remove <strong>{deleting.name}</strong> from this deal? The legal description text will be deleted with it.</>}
          confirmLabel="Remove" danger busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            setBusy(true);
            try { await api.del(`/deals/${dealId}/tracts/${deleting.id}`); setDeleting(null); if (selectedId === deleting.id) setSelectedId(null); await load(); }
            catch (e) { setErr((e as Error).message); }
            finally { setBusy(false); }
          }}
        />
      )}
    </div>
  );
}

/**
 * One tract as an expandable card: name + acreage header, status chips,
 * Generate as the primary action, everything else in the overflow menu, and
 * the full parse detail (ValidationPanel) revealed on expand.
 */
function TractCard({ tract: t, canEdit, expanded, onToggle, generating, anyBusy, placing, onGenerate, onPlacePob, onEdit, onRemove }: {
  tract: Tract; canEdit: boolean; expanded: boolean; onToggle: () => void;
  generating: boolean; anyBusy: boolean; placing: boolean;
  onGenerate: () => void; onPlacePob: () => void; onEdit: () => void; onRemove: () => void;
}) {
  const p = t.parse;
  const issues = (p?.warnings.length ?? 0) + (p?.unresolved.length ?? 0);
  return (
    <div className={`tract-card ${expanded ? "expanded" : ""}`}>
      <div className="tract-card-head" role="button" tabIndex={0} aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <div className="tract-card-title">
          <h4>{t.name}</h4>
          <div className="tract-card-sub">
            Computed <strong>{p?.computedAcres != null ? `${p.computedAcres.toLocaleString()} ac` : "—"}</strong>
            <span className="tract-dot">·</span>
            Stated <strong>{p?.refs.statedAcres != null ? `${p.refs.statedAcres.toLocaleString()} ac` : "—"}</strong>
            {p?.refs.abstracts.length ? <><span className="tract-dot">·</span>{p.refs.abstracts.join(", ")}{p.refs.county ? `, ${p.refs.county} County` : ""}</> : null}
          </div>
        </div>
        <div className="tract-card-chips">
          {p?.closure && (p.closure.closes
            ? <span className="badge tract-chip-good">✓ Closes</span>
            : <span className="badge tract-chip-bad">✗ {p.closure.gapFt.toLocaleString()} ft gap</span>)}
          {t.geometry ? <span className="badge tract-chip-neutral">Mapped</span> : <span className="badge tract-chip-dim">Not anchored</span>}
          {p?.confidence != null && <ConfidenceBadge value={p.confidence} />}
          {issues > 0 && <span className="badge tract-chip-warn">{issues} to review</span>}
        </div>
        <div className="tract-card-actions" onClick={(e) => e.stopPropagation()}>
          {canEdit && (
            <button className="primary small" disabled={anyBusy} onClick={onGenerate}
              title="Re-parses the legal description and regenerates the tract geometry">
              {generating ? "Processing…" : "Generate Tract Map"}
            </button>
          )}
          {canEdit && (
            <OverflowMenu ariaLabel={`Actions for ${t.name}`} items={[
              { label: placing ? "Cancel POB placement" : "Place Point of Beginning", onClick: onPlacePob },
              { label: "Edit", onClick: onEdit },
              { label: "Remove", danger: true, onClick: onRemove },
            ]} />
          )}
          <span className={`tract-card-chevron ${expanded ? "open" : ""}`} aria-hidden="true"><ChevronDown size={16} /></span>
        </div>
      </div>
      {placing && <div className="tract-card-placing muted">Click the map above to place the Point of Beginning.</div>}
      {expanded && p && <div className="tract-card-body"><ValidationPanel tract={t} /></div>}
    </div>
  );
}

/** Confidence badge: green ≥80, amber 50–79, red <50 — same bands everywhere. */
function ConfidenceBadge({ value }: { value: number }) {
  const [bg, fg] = value >= 80 ? ["rgba(34,197,94,.15)", "#15803d"] : value >= 50 ? ["rgba(245,158,11,.15)", "#b45309"] : ["rgba(239,68,68,.15)", "#dc2626"];
  return (
    <span className="badge" style={{ background: bg, color: fg }}
      title="Deterministic confidence — scored from what the parser could verify: POB found, calls resolved, boundary closure, acreage agreement, and how many interpretive assumptions were needed">
      {value}% confidence
    </span>
  );
}

/** Per-tract QC readout: POB, every call with its reading, closure, refs, flags. */
function ValidationPanel({ tract }: { tract: Tract }) {
  const p = tract.parse!;
  return (
    <div>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        {p.confidence == null && <span className="badge" style={{ opacity: 0.75 }} title="Parsed before confidence scoring — use Generate Tract Map to rescore">Parsed</span>}
        {p.source === "ai" && <span className="badge" style={{ opacity: 0.6 }} title="Parsed by the retired AI extraction path — Generate Tract Map re-parses with the built-in engine">legacy parse</span>}
        {p.closure && (p.closure.closes
          ? <span className="muted" style={{ fontSize: 13 }}>Closes (precision 1:{p.closure.precision.toLocaleString()})</span>
          : <span style={{ fontSize: 13, color: "#dc2626" }}>Open boundary — {p.closure.gapFt.toLocaleString()} ft back to POB</span>)}
        {p.computedAcres != null && <span className="muted" style={{ fontSize: 13 }}>{p.computedAcres.toLocaleString()} ac computed{p.refs.statedAcres != null ? ` · ${p.refs.statedAcres.toLocaleString()} ac stated` : ""}</span>}
        {tract.anchor && (
          <span className="muted" style={{ fontSize: 13 }}>
            POB {tract.anchor.source === "manual" ? "placed manually"
              : tract.anchor.method === "corner-tie" ? `derived from the ${tract.anchor.corner} corner of the abstract + commencement tie-line`
                : tract.anchor.method === "corner" ? `derived from the ${tract.anchor.corner} corner of the abstract`
                  : "approximated from the abstract (no corner reference — refine with Place POB)"}
          </span>
        )}
      </div>
      {p.pobText && <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}><strong>POB:</strong> {p.pobText}</p>}
      {p.warnings.map((w, i) => <Banner key={i} kind="warn">{w}</Banner>)}
      {(p.assumptions?.length ?? 0) > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          <strong>Interpretive assumptions (verify these):</strong>
          <ul style={{ margin: "4px 0 0 18px" }}>{p.assumptions!.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}
      {p.calls.length > 0 && (
        <table className="table" style={{ marginTop: 8, fontSize: 13 }}>
          <thead><tr><th>#</th><th>Bearing</th><th>Distance</th><th>Reads as</th></tr></thead>
          <tbody>
            {p.calls.map((c) => (
              <tr key={c.seq} style={c.issue && !/long chord/i.test(c.issue) ? { background: "rgba(245,158,11,.08)" } : undefined}>
                <td>{c.seq}{c.curve ? " ⌒" : ""}</td>
                <td>{c.bearing ?? <span style={{ color: "#b45309" }}>unreadable</span>}</td>
                <td>{c.distanceRaw ?? <span style={{ color: "#b45309" }}>unreadable</span>}{c.distanceFt != null && c.distanceRaw && !/feet|foot|ft/i.test(c.distanceRaw) ? <span className="muted"> ({c.distanceFt.toLocaleString()} ft)</span> : null}</td>
                <td className="muted" style={{ maxWidth: 420 }}>{c.issue ? <span style={{ color: "#b45309" }}>{c.issue} </span> : null}{c.raw}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(p.refs.surveys.length > 0 || p.refs.abstracts.length > 0 || p.refs.sections.length > 0 || p.refs.blocks.length > 0 || p.refs.lots.length > 0) && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          <strong>References:</strong>{" "}
          {[
            p.refs.surveys.length ? `Survey: ${p.refs.surveys.join("; ")}` : "",
            p.refs.abstracts.length ? `Abstract: ${p.refs.abstracts.join(", ")}` : "",
            p.refs.sections.length ? `Section: ${p.refs.sections.join(", ")}` : "",
            p.refs.blocks.length ? `Block: ${p.refs.blocks.join(", ")}` : "",
            p.refs.lots.length ? `Lot: ${p.refs.lots.join(", ")}` : "",
            p.refs.county ? `${p.refs.county} County` : "",
          ].filter(Boolean).join(" · ")}
        </p>
      )}
    </div>
  );
}

/** Add/edit modal with a live parse preview before saving. */
function TractEditor({ dealId, tract, onClose, onSaved }: { dealId: string; tract: Tract | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(tract?.name ?? "");
  const [text, setText] = useState(tract?.text ?? "");
  const [states, setStates] = useState<string[]>(tract?.state ? [tract.state] : ["TX"]);
  const [counties, setCounties] = useState<string[]>(tract?.counties ?? []);
  const [abstractIds, setAbstractIds] = useState<string[]>(tract?.abstractGisIds ?? []);
  const [preview, setPreview] = useState<ParsedTract | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function runPreview() {
    if (!text.trim()) return;
    setBusy(true); setErr(null);
    try { setPreview(await api.post<ParsedTract>(`/deals/${dealId}/tracts/preview`, { text, state: states[0] ?? "TX" })); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setErr(null);
    const payload = { text, state: states[0] ?? "TX", counties, abstractIds };
    try {
      if (tract) await api.patch(`/deals/${dealId}/tracts/${tract.id}`, { name: name.trim() || tract.name, ...payload });
      else await api.post(`/deals/${dealId}/tracts`, { name: name.trim() || undefined, ...payload });
      onSaved();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal title={tract ? `Edit ${tract.name}` : "Add Tract Description"} onClose={onClose} wide
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button disabled={busy || !text.trim()} onClick={runPreview}>Preview parse</button>
        <button className="primary" disabled={busy || !text.trim()} onClick={save}>{tract ? "Save changes" : "Add tract"}</button>
      </>}>
      {err && <Banner kind="error">{err}</Banner>}
      <div className="tract-editor">
        <div className="field">
          <label>Tract name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tract 1 — 160-acre Home Place" />
          <span className="muted" style={{ fontSize: 12 }}>Optional — auto-named from the description if left blank.</span>
        </div>
        {/* Location context: many deeds never cite their abstract (they
            reference neighboring tracts instead). Setting it here places the
            tract precisely without any manual POB work. */}
        <div className="field" style={{ marginBottom: 4 }}>
          <label>Location (recommended)</label>
          <span className="muted" style={{ fontSize: 12 }}>
            State, county and abstract the tract sits in — used to place it on the map when the description doesn't say.
          </span>
        </div>
        <div className="dd-grid" style={{ marginBottom: 10 }}>
          <GeoFields
            states={states} onStatesChange={(v) => setStates(v.slice(-1))}
            counties={counties} onCountiesChange={setCounties}
            abstractIds={abstractIds} onAbstractsChange={setAbstractIds}
          />
        </div>
        <div className="field">
          <label>Legal description</label>
          <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={"Paste the legal description exactly as written in the deed, lease or title document…\n\nBEGINNING at a 1/2 inch iron rod…\nTHENCE N 45°30' E, 1200.00 feet to a point for corner;\nTHENCE …"} />
          <span className="muted" style={{ fontSize: 12 }}>Paste it exactly as written; boundary calls, closure and acreage are computed when you preview.</span>
        </div>
      </div>
      {preview && (
        <div className="tract-preview" style={{ marginTop: 16 }}>
          {preview.ok
            ? <Banner kind="info">Parsed {preview.calls.filter((c) => !c.issue || /long chord/i.test(c.issue)).length} of {preview.calls.length} calls
                {preview.computedAcres != null ? ` · ${preview.computedAcres.toLocaleString()} acres computed` : ""}
                {preview.closure ? (preview.closure.closes ? " · boundary closes" : ` · does NOT close (${preview.closure.gapFt.toLocaleString()} ft gap)`) : ""}</Banner>
            : <Banner kind="warn">Could not build a polygon from this text — it will be saved and flagged for manual review.</Banner>}
          {preview.warnings.map((w, i) => <Banner key={i} kind="warn">{w}</Banner>)}
          {preview.unresolved.length > 0 && (
            <p className="muted" style={{ fontSize: 12 }}><strong>Needs review:</strong> {preview.unresolved.slice(0, 3).join(" — ")}{preview.unresolved.length > 3 ? ` (+${preview.unresolved.length - 3} more)` : ""}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
