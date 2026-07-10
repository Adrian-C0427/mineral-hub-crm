import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Banner, Spinner, ConfirmDelete, Modal } from "./ui";
import { Select } from "./Select";
import { downloadCsv } from "../lib/csv";
import { fmtDate, fmtDateTime } from "../lib/format";
import { CsvDropzone } from "./CsvDropzone";

/**
 * Research data management: CSV import (Deeds / Leases / Drilling Permits →
 * analyze → map columns → commit), import history, and bulk delete. State and
 * county are resolved server-side (per-row County column, else the platform's
 * configured scope), so they aren't entered here.
 */

type Category = "deeds" | "leases" | "permits";
const CATEGORY_LABEL: Record<Category, string> = { deeds: "Deeds", leases: "Leases", permits: "Drilling Permits" };

interface FieldDef { key: string; label: string; required?: boolean }
interface AnalyzeResp { headers: string[]; fields: FieldDef[]; suggestedMapping: Record<string, string>; rowCount: number; sample: Record<string, string>[] }
interface CommitResp {
  runId: string; rowsTotal: number;
  imported: number; updated: number; duplicates: number; rejected: number;
  skippedReasons: { reason: string; count: number }[];
}
interface IngestRun {
  id: string; kind: string; source: string; state: string | null; county: string | null; filename: string | null;
  rowsTotal: number; rowsImported: number; rowsSkipped: number; rowsFailed: number; rowsUpdated: number; status: string; createdAt: string;
}
type RowOutcome = "IMPORTED" | "DUPLICATE" | "UPDATED" | "REJECTED";
interface ReviewRow { rowIndex: number; outcome: RowOutcome; reason: string | null; data: Record<string, string> }
interface ReviewResp { kind: "DOCUMENTS" | "PERMITS"; rows: ReviewRow[] }

// Templates match the canonical columns for each Data Type.
const DEED_TEMPLATE = {
  headers: ["Document Type", "Recording Date", "Grantor", "Grantee", "Instrument Number", "County", "Abstract", "Survey"],
  rows: [["Mineral Deed", "03/12/2026", "Smith, John et ux", "Blackrock Minerals LLC", "2026-00412", "Leon", "289653", "J HALLMARK"]],
};
const LEASE_TEMPLATE = {
  headers: ["Document Type", "Recording Date", "Grantor", "Grantee", "Instrument Number", "County", "Abstract", "Survey"],
  rows: [["Oil & Gas Lease", "03/14/2026", "Jones Family Trust", "Apex Energy Partners LP", "2026-00418", "Leon", "289183", "T RAGSDALE"]],
};
const PERMIT_TEMPLATE = {
  headers: ["Operator Name", "County", "API No", "Permit No", "Lease Name", "Well No", "Status", "Wellbore Profile", "Submitted Date", "Approved Date", "Spud Date", "Formation"],
  rows: [["Apex Energy Partners LP", "Leon", "42-289-40012", "889321", "HALLMARK UNIT", "1H", "Approved", "Horizontal", "03/02/2026", "03/20/2026", "", "Eagle Ford"]],
};

/** Import-history "Type" label from the stored source tag. */
function runTypeLabel(source: string): string {
  if (source === "csv-deeds") return "Deeds";
  if (source === "csv-leases") return "Leases";
  if (source === "csv-permits") return "Drilling Permits";
  if (source === "sample") return "Sample data";
  return source;
}

export function ResearchImport({ onDataChanged }: { onDataChanged: () => void }) {
  const [category, setCategory] = useState<Category>("deeds");
  const [csv, setCsv] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [analysis, setAnalysis] = useState<AnalyzeResp | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [assignState, setAssignState] = useState("");
  const [assignCounty, setAssignCounty] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CommitResp | null>(null);
  const [runs, setRuns] = useState<IngestRun[]>([]);
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set());
  const [confirmRuns, setConfirmRuns] = useState(false);
  const [deletingRuns, setDeletingRuns] = useState(false);
  const [reviewRun, setReviewRun] = useState<IngestRun | null>(null);

  const loadRuns = () => api.get<IngestRun[]>("/research/ingest/runs").then(setRuns).catch(() => {});
  useEffect(() => { loadRuns(); }, []);

  function reset() {
    setCsv(null); setFilename(""); setAnalysis(null); setMapping({}); setResult(null); setError("");
    setAssignState(""); setAssignCounty("");
  }

  async function onFile(f: File) {
    reset();
    setFilename(f.name);
    const text = await f.text();
    setCsv(text);
    setBusy(true);
    try {
      const a = await api.post<AnalyzeResp>("/research/ingest/analyze", { category, csv: text });
      setAnalysis(a);
      setMapping(a.suggestedMapping);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that CSV");
    } finally {
      setBusy(false);
    }
  }

  async function onCommit() {
    if (!csv) return;
    setBusy(true); setError("");
    try {
      const r = await api.post<CommitResp>("/research/ingest/commit", {
        category, csv, mapping, filename: filename || undefined,
        assignedState: assignState.trim() || undefined,
        assignedCounty: assignCounty.trim() || undefined,
      });
      setResult(r);
      setAnalysis(null);
      setCsv(null);
        loadRuns();
      onDataChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const t = category === "permits" ? PERMIT_TEMPLATE : category === "leases" ? LEASE_TEMPLATE : DEED_TEMPLATE;
    downloadCsv(`research-${category}-template.csv`, t.headers, t.rows);
  }

  const requiredMissing = analysis?.fields.filter((f) => f.required && !mapping[f.key]) ?? [];

  return (
    <div>
      <div className="panel">
        <h3>Import Public Records</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Upload a CSV of recorded deeds or leases (or a drilling-permit export). Rows are classified,
          normalized and de-duplicated automatically; non-mineral instruments (liens, deeds of trust, easements) are skipped.
          State and County come from the file's columns where present; if your file doesn't include them, assign them below before importing.
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <div className="field" style={{ marginBottom: 0, minWidth: 180 }}><label>Data Type</label>
            <Select value={category} onChange={(v) => { setCategory(v as Category); reset(); }} ariaLabel="Data type"
              options={[
                { value: "deeds", label: "Deeds" },
                { value: "leases", label: "Leases" },
                { value: "permits", label: "Drilling Permits" },
              ]} />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 250 }}><label>CSV file</label>
            <CsvDropzone slim onFile={onFile} />
          </div>
          <button className="small" onClick={downloadTemplate}>Download template</button>
        </div>

        {busy && <Spinner label="Working…" />}
        {error && <Banner kind="error">{error}</Banner>}

        {analysis && (
          <div style={{ marginTop: 14 }}>
            <h4 style={{ margin: "0 0 6px" }}>Map columns <span className="muted" style={{ fontWeight: 400 }}>({analysis.rowCount.toLocaleString()} rows found)</span></h4>
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              {analysis.fields.map((f) => (
                <div key={f.key} className="field" style={{ marginBottom: 0, minWidth: 200 }}>
                  <label>{f.label}{f.required ? " *" : ""}</label>
                  <Select value={mapping[f.key] ?? ""} onChange={(v) => setMapping((m) => ({ ...m, [f.key]: v }))}
                    placeholder="— not in file —" clearable searchable ariaLabel={`Map column for ${f.label}`}
                    options={analysis.headers.map((h) => ({ value: h, label: h }))} />
                </div>
              ))}
            </div>
            {requiredMissing.length > 0 && (
              <Banner kind="warn">Required: {requiredMissing.map((f) => f.label).join(", ")}</Banner>
            )}

            {/* Assign State/County for the whole file when the columns aren't mapped. */}
            {(!mapping.state || !mapping.county) && (
              <div style={{ marginTop: 12 }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                  {(!mapping.state && !mapping.county) ? "This file has no State or County column — assign them for every row:"
                    : !mapping.state ? "No State column mapped — assign the State for this file:"
                      : "No County column mapped — assign the County for this file:"}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {!mapping.state && (
                    <div className="field" style={{ marginBottom: 0, width: 110 }}><label>State *</label>
                      <input value={assignState} maxLength={2} onChange={(e) => setAssignState(e.target.value.toUpperCase())} placeholder="TX" />
                    </div>
                  )}
                  {!mapping.county && (
                    <div className="field" style={{ marginBottom: 0, minWidth: 180 }}><label>County *</label>
                      <input value={assignCounty} onChange={(e) => setAssignCounty(e.target.value)} placeholder="e.g. Leon" />
                    </div>
                  )}
                </div>
              </div>
            )}

            <div style={{ marginTop: 10 }}>
              <button className="primary"
                disabled={busy || requiredMissing.length > 0 || (!mapping.state && !assignState.trim()) || (!mapping.county && !assignCounty.trim())}
                onClick={onCommit}>
                Import {analysis.rowCount.toLocaleString()} rows as {CATEGORY_LABEL[category]}
              </button>
            </div>
          </div>
        )}

        {result && (
          <div className="import-summary">
            <div className="import-summary-head">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
              <span className="import-summary-title">Import complete</span>
            </div>
            <div className="import-summary-stats">
              <div className="iss"><span className="iss-num">{result.rowsTotal.toLocaleString()}</span><span className="iss-lbl">Processed</span></div>
              <div className="iss iss-ok"><span className="iss-num">{result.imported.toLocaleString()}</span><span className="iss-lbl">New imported</span></div>
              {result.updated > 0 && <div className="iss iss-upd"><span className="iss-num">{result.updated.toLocaleString()}</span><span className="iss-lbl">Updated</span></div>}
              {result.duplicates > 0 && <div className="iss iss-warn"><span className="iss-num">{result.duplicates.toLocaleString()}</span><span className="iss-lbl">Duplicates skipped</span></div>}
              {result.rejected > 0 && <div className="iss iss-bad"><span className="iss-num">{result.rejected.toLocaleString()}</span><span className="iss-lbl">Rejected</span></div>}
            </div>
            {result.skippedReasons.length > 0 && (
              <div className="import-summary-reasons">
                <span className="ddx-label">Why rows were skipped or rejected</span>
                <ul>
                  {result.skippedReasons.map((r) => (
                    <li key={r.reason}><span className="isr-count">{r.count.toLocaleString()}×</span><span>{r.reason}</span></li>
                  ))}
                </ul>
              </div>
            )}
            <ImportReview runId={result.runId} />
          </div>
        )}
      </div>

      <div className="panel">
        <div className="section-head"><h3 style={{ margin: 0 }}>Import History</h3>
          {selectedRuns.size > 0 && (
            <button className="small danger" onClick={() => setConfirmRuns(true)} disabled={deletingRuns}>
              Delete {selectedRuns.size} import{selectedRuns.size === 1 ? "" : "s"}…
            </button>
          )}
        </div>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Deleting an import removes only the records that file created; all other imports stay intact.</p>
        {runs.length === 0 ? <p className="muted">No imports yet.</p> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr>
              <th style={{ width: 28 }}><input type="checkbox" checked={runs.length > 0 && runs.every((r) => selectedRuns.has(r.id))} onChange={(e) => setSelectedRuns(e.target.checked ? new Set(runs.map((r) => r.id)) : new Set())} /></th>
              <th>Date</th><th>Type</th><th>Geography</th><th>File</th><th>Imported</th><th>Updated</th><th>Duplicates</th><th>Rejected</th><th></th>
            </tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" checked={selectedRuns.has(r.id)} onChange={() => setSelectedRuns((p) => { const n = new Set(p); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })} /></td>
                  <td>{fmtDateTime(r.createdAt)}</td>
                  <td>{runTypeLabel(r.source)}</td>
                  <td>{[r.county, r.state].filter(Boolean).join(", ") || "—"}</td>
                  <td>{r.filename ?? "—"}</td>
                  <td>{r.rowsImported.toLocaleString()}</td>
                  <td>{(r.rowsUpdated ?? 0).toLocaleString()}</td>
                  <td>{r.rowsSkipped.toLocaleString()}</td>
                  <td>{r.rowsFailed.toLocaleString()}</td>
                  <td className="right"><button className="small" onClick={() => setReviewRun(r)}>Review</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {reviewRun && (
          <Modal title={`Import review — ${reviewRun.filename ?? runTypeLabel(reviewRun.source)} (${fmtDate(reviewRun.createdAt)})`} wide onClose={() => setReviewRun(null)}
            footer={<button className="primary" onClick={() => setReviewRun(null)}>Done</button>}>
            <ImportReview runId={reviewRun.id} />
          </Modal>
        )}
        {confirmRuns && (
          <ConfirmDelete count={selectedRuns.size} itemLabel="import" busy={deletingRuns}
            onCancel={() => setConfirmRuns(false)}
            onConfirm={async () => {
              setDeletingRuns(true);
              try {
                await api.post("/research/ingest/runs/delete", { ids: [...selectedRuns] });
                setSelectedRuns(new Set()); setConfirmRuns(false); loadRuns(); onDataChanged();
              } finally { setDeletingRuns(false); }
            }} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import review — inspect exactly which rows were imported, skipped as
// duplicates, updated, or rejected (and why), per import run. Exportable.
// ---------------------------------------------------------------------------

const OUTCOME_TABS: { key: RowOutcome; label: string }[] = [
  { key: "IMPORTED", label: "New" },
  { key: "DUPLICATE", label: "Duplicates" },
  { key: "UPDATED", label: "Updated" },
  { key: "REJECTED", label: "Rejected" },
];
const DOC_COLS: [string, string][] = [
  ["docType", "Doc Type"], ["recordingDate", "Recorded"], ["grantor", "Grantor"], ["grantee", "Grantee"],
  ["instrumentNumber", "Instrument #"], ["volume", "Vol"], ["page", "Pg"], ["county", "County"], ["state", "St"], ["abstractId", "Abstract"],
];
const PERMIT_COLS: [string, string][] = [
  ["operator", "Operator"], ["apiNumber", "API"], ["permitNumber", "Permit"], ["leaseName", "Lease"], ["wellName", "Well"],
  ["status", "Status"], ["filedDate", "Filed"], ["approvedDate", "Approved"], ["county", "County"], ["state", "St"], ["formation", "Formation"],
];

function ImportReview({ runId }: { runId: string }) {
  const [resp, setResp] = useState<ReviewResp | null>(null);
  const [tab, setTab] = useState<RowOutcome>("IMPORTED");
  const [err, setErr] = useState("");
  useEffect(() => {
    setResp(null); setErr(""); setTab("IMPORTED");
    api.get<ReviewResp>(`/research/ingest/runs/${runId}/rows`).then(setResp).catch((e) => setErr(e instanceof Error ? e.message : "Could not load the review"));
  }, [runId]);

  if (err) return <Banner kind="error">{err}</Banner>;
  if (!resp) return <Spinner label="Loading import review…" />;
  if (resp.rows.length === 0) {
    return <p className="muted" style={{ margin: "12px 0 0", fontSize: 13 }}>No per-row detail is stored for this import (imports made before the review feature don't have one).</p>;
  }

  const counts = new Map<RowOutcome, number>();
  for (const r of resp.rows) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  const rows = resp.rows.filter((r) => r.outcome === tab);
  const cols = resp.kind === "PERMITS" ? PERMIT_COLS : DOC_COLS;
  const showReason = tab !== "IMPORTED";

  function exportCsv() {
    if (!resp) return;
    downloadCsv(
      `import-review-${runId.slice(0, 8)}.csv`,
      ["Row", "Outcome", "Reason", ...cols.map(([, l]) => l)],
      resp.rows.map((r) => [r.rowIndex + 1, r.outcome, r.reason ?? "", ...cols.map(([k]) => r.data[k] ?? "")]),
    );
  }

  return (
    <div className="import-review">
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 14 }}>
        <span className="ddx-label" style={{ marginRight: 2 }}>Review this import</span>
        <div className="pill-filter">
          {OUTCOME_TABS.map((t) => {
            const n = counts.get(t.key) ?? 0;
            return (
              <button key={t.key} type="button" className={tab === t.key ? "active" : ""} disabled={n === 0} style={n === 0 ? { opacity: 0.45 } : undefined}
                onClick={() => setTab(t.key)}>
                {t.label} ({n.toLocaleString()})
              </button>
            );
          })}
        </div>
        <span className="spacer" />
        <button type="button" className="small" onClick={exportCsv}>Export summary (CSV)</button>
      </div>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>No rows in this category.</p>
      ) : (
        <div className="table-scroll" style={{ marginTop: 10, maxHeight: 340, overflowY: "auto" }}>
          <table className="data-table">
            <thead><tr><th style={{ width: 52 }}>Row</th>{cols.map(([k, l]) => <th key={k}>{l}</th>)}{showReason && <th>Reason</th>}</tr></thead>
            <tbody>
              {rows.slice(0, 500).map((r) => (
                <tr key={r.rowIndex}>
                  <td className="muted">{r.rowIndex + 1}</td>
                  {cols.map(([k]) => <td key={k}>{r.data[k] || "—"}</td>)}
                  {showReason && <td className="muted">{r.reason ?? "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 500 && <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>Showing the first 500 of {rows.length.toLocaleString()} rows — use Export for the complete list.</p>}
    </div>
  );
}
