import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Banner, Spinner, ConfirmDelete, Modal, Req } from "./ui";
import { Select } from "./Select";
import { downloadCsv } from "../lib/csv";
import { fmtDate, fmtDateTime } from "../lib/format";
import { CsvDropzone } from "./CsvDropzone";
import { Segmented, Tag } from "./kit";

/**
 * Research data management: CSV import (Deeds / Leases / Drilling Permits →
 * analyze → map columns → commit), import history, and bulk delete. State and
 * county are resolved server-side (per-row County column, else the platform's
 * configured scope), so they aren't entered here.
 */

type Category = "deeds" | "leases" | "permits";
const CATEGORY_LABEL: Record<Category, string> = { deeds: "Deeds", leases: "Leases", permits: "Drilling Permits" };
/** Lower-case noun for the drop-zone prompt. */
const CATEGORY_NOUN: Record<Category, string> = { deeds: "deeds", leases: "leases", permits: "drilling-permit" };

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
/** Import-history type tag colour by source tag. */
const RUN_TONE: Record<string, "accent" | "violet" | "success" | "neutral"> = {
  "csv-deeds": "accent", "csv-leases": "violet", "csv-permits": "success", sample: "neutral",
};

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
  const allRunsSelected = runs.length > 0 && runs.every((r) => selectedRuns.has(r.id));
  const someRunsSelected = selectedRuns.size > 0 && !allRunsSelected;

  return (
    <div className="rs-imports">
      <section className="rs-card rs-import-card">
        <div className="rs-card-titles">
          <h3>Import public records</h3>
          <span className="rs-card-sub">
            Upload a CSV of recorded deeds or leases (or a drilling-permit export). Rows are classified,
            normalized and de-duplicated automatically; non-mineral instruments (liens, deeds of trust, easements) are skipped.
            State and County come from the file's columns where present; if your file doesn't include them, assign them below before importing.
          </span>
        </div>
        <div className="rs-import-row">
          <div className="rs-import-field">
            <span className="rec-flabel">Data type</span>
            <Segmented<Category> accent ariaLabel="Data type" value={category} onChange={(v) => { setCategory(v); reset(); }}
              options={[
                { value: "deeds", label: "Deeds" },
                { value: "leases", label: "Leases" },
                { value: "permits", label: "Drilling permits" },
              ]} />
          </div>
          <div className="rs-import-drop">
            <CsvDropzone slim onFile={onFile} label={`Drop a ${CATEGORY_NOUN[category]} CSV here, or click to browse`} />
          </div>
          <button type="button" className="rs-outline-btn" onClick={downloadTemplate}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
            Download template
          </button>
        </div>
        {filename && (analysis || busy) && <div className="rs-import-file">{filename}</div>}

        {busy && <Spinner label="Working…" />}
        {error && <Banner kind="error">{error}</Banner>}

        {analysis && (
          <div className="rs-import-step">
            <div className="rs-step-head">Map columns <span>({analysis.rowCount.toLocaleString()} rows found)</span></div>
            <div className="rs-map-grid">
              {analysis.fields.map((f) => (
                <div key={f.key} className="field" style={{ marginBottom: 0 }}>
                  <label>{f.label}{f.required && <Req />}</label>
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
              <div className="rs-assign">
                <div className="rs-assign-note">
                  {(!mapping.state && !mapping.county) ? "This file has no State or County column — assign them for every row:"
                    : !mapping.state ? "No State column mapped — assign the State for this file:"
                      : "No County column mapped — assign the County for this file:"}
                </div>
                <div className="rs-assign-row">
                  {!mapping.state && (
                    <div className="field" style={{ marginBottom: 0, width: 110 }}><label>State <Req /></label>
                      <input value={assignState} maxLength={2} onChange={(e) => setAssignState(e.target.value.toUpperCase())} placeholder="TX" />
                    </div>
                  )}
                  {!mapping.county && (
                    <div className="field" style={{ marginBottom: 0, minWidth: 180 }}><label>County <Req /></label>
                      <input value={assignCounty} onChange={(e) => setAssignCounty(e.target.value)} placeholder="e.g. Leon" />
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="rs-import-go">
              <button type="button" className="primary"
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
      </section>

      <section className="rs-card">
        <div className="rs-card-head">
          <div className="rs-card-titles">
            <h3>Import history</h3>
            <span className="rs-card-sub">Deleting an import removes only the records that file created; all other imports stay intact.</span>
          </div>
          <div className="rs-card-tools">
            {selectedRuns.size > 0 && <span className="rs-strong rs-small">{selectedRuns.size} selected</span>}
            <button type="button" className="rs-outline-btn rs-danger" onClick={() => setConfirmRuns(true)} disabled={selectedRuns.size === 0 || deletingRuns}>
              Delete selected{selectedRuns.size > 0 ? ` (${selectedRuns.size})` : ""}
            </button>
          </div>
        </div>
        {runs.length === 0 ? <p className="rs-empty">No imports yet.</p> : (
          <>
            <div className="table-scroll rs-flat-scroll"><table className="data-table rs-history">
              <thead><tr>
                <th className="center" style={{ width: 44 }}>
                  <input type="checkbox" aria-label="Select all imports" checked={allRunsSelected}
                    ref={(el) => { if (el) el.indeterminate = someRunsSelected; }}
                    onChange={(e) => setSelectedRuns(e.target.checked ? new Set(runs.map((r) => r.id)) : new Set())} />
                </th>
                <th className="active">Date <span className="rs-sort-ind" aria-hidden="true">↓</span></th>
                <th>Type</th><th>Geography</th><th>File</th>
                <th className="right">Imported</th><th className="right">Updated</th><th className="right">Duplicates</th><th className="right">Rejected</th><th style={{ width: 96 }}></th>
              </tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={selectedRuns.has(r.id) ? "row-selected" : undefined}>
                    <td className="center"><input type="checkbox" aria-label={`Select import ${r.filename ?? runTypeLabel(r.source)}`} checked={selectedRuns.has(r.id)} onChange={() => setSelectedRuns((p) => { const n = new Set(p); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })} /></td>
                    <td><span className="rs-mid rec-nowrap">{fmtDateTime(r.createdAt)}</span></td>
                    <td><Tag tone={RUN_TONE[r.source] ?? "neutral"}>{runTypeLabel(r.source)}</Tag></td>
                    <td>{r.county || r.state ? <span className="rs-mid rec-nowrap">{[r.county, r.state].filter(Boolean).join(", ")}</span> : <span className="rs-zero">—</span>}</td>
                    <td><span className="rs-file" title={r.filename ?? undefined}>{r.filename ?? "—"}</span></td>
                    <td className="right"><b className="rec-nowrap">{r.rowsImported.toLocaleString()}</b></td>
                    <td className="right"><span className={`rec-nowrap ${(r.rowsUpdated ?? 0) > 0 ? "rs-ok" : "rs-zero"}`}>{(r.rowsUpdated ?? 0).toLocaleString()}</span></td>
                    <td className="right"><span className={`rec-nowrap ${r.rowsSkipped > 0 ? "rs-warn" : "rs-zero"}`}>{r.rowsSkipped.toLocaleString()}</span></td>
                    <td className="right"><span className={`rec-nowrap ${r.rowsFailed > 0 ? "rs-bad" : "rs-zero"}`}>{r.rowsFailed.toLocaleString()}</span></td>
                    <td className="right"><button type="button" className="rs-outline-btn sm" onClick={() => setReviewRun(r)}>Review</button></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <div className="rs-card-foot">
              <span>{runs.length.toLocaleString()} import{runs.length === 1 ? "" : "s"} · sorted by date, newest first</span>
            </div>
          </>
        )}
        {reviewRun && (
          <Modal title={`Import review · ${reviewRun.filename ?? runTypeLabel(reviewRun.source)} (${fmtDate(reviewRun.createdAt)})`} wide onClose={() => setReviewRun(null)}
            footer={<button type="button" className="primary" onClick={() => setReviewRun(null)}>Done</button>}>
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
      </section>
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
    return <p className="rs-review-note">No per-row detail is stored for this import (imports made before the review feature don't have one).</p>;
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
      <div className="rs-review-bar">
        <span className="ddx-label">Review this import</span>
        <div className="seg seg-accent rs-review-seg" role="tablist" aria-label="Import outcome">
          {OUTCOME_TABS.map((t) => {
            const n = counts.get(t.key) ?? 0;
            return (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`seg-item ${tab === t.key ? "active" : ""}`} disabled={n === 0}
                onClick={() => setTab(t.key)}>
                <span>{t.label}</span><span className="seg-count">{n.toLocaleString()}</span>
              </button>
            );
          })}
        </div>
        <span className="spacer" />
        <button type="button" className="rs-outline-btn" onClick={exportCsv}>Export summary (CSV)</button>
      </div>
      {rows.length === 0 ? (
        <p className="rs-review-note">No rows in this category.</p>
      ) : (
        <div className="table-scroll rs-review-scroll">
          <table className="data-table rs-sticky-head">
            <thead><tr><th style={{ width: 56 }}>Row</th>{cols.map(([k, l]) => <th key={k}>{l}</th>)}{showReason && <th>Reason</th>}</tr></thead>
            <tbody>
              {rows.slice(0, 500).map((r) => (
                <tr key={r.rowIndex}>
                  <td className="rs-mid">{r.rowIndex + 1}</td>
                  {cols.map(([k]) => <td key={k}>{r.data[k] || <span className="rs-zero">—</span>}</td>)}
                  {showReason && <td className="rs-mid">{r.reason ?? "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 500 && <p className="rs-review-note">Showing the first 500 of {rows.length.toLocaleString()} rows — use Export for the complete list.</p>}
    </div>
  );
}
