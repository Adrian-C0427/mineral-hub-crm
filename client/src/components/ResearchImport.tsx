import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Banner, Spinner, ConfirmDelete } from "./ui";
import { downloadCsv } from "../lib/csv";
import { fmtDate } from "../lib/format";

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
interface CommitResp { runId: string; rowsTotal: number; imported: number; skipped: number; failed: number; skippedReasons: { reason: string; count: number }[] }
interface IngestRun {
  id: string; kind: string; source: string; state: string | null; county: string | null; filename: string | null;
  rowsTotal: number; rowsImported: number; rowsSkipped: number; rowsFailed: number; status: string; createdAt: string;
}

// Templates match the canonical columns for each Data Type.
const DEED_TEMPLATE = {
  headers: ["Document Type", "Recording Date", "Grantor", "Grantee", "Instrument Number", "County", "Abstract", "Survey", "Legal Description"],
  rows: [["Mineral Deed", "03/12/2026", "Smith, John et ux", "Blackrock Minerals LLC", "2026-00412", "Leon", "289653", "J HALLMARK", "40 ac in the J HALLMARK SURVEY A-289"]],
};
const LEASE_TEMPLATE = {
  headers: ["Document Type", "Recording Date", "Grantor", "Grantee", "Instrument Number", "County", "Abstract", "Survey", "Legal Description"],
  rows: [["Oil & Gas Lease", "03/14/2026", "Jones Family Trust", "Apex Energy Partners LP", "2026-00418", "Leon", "289183", "T RAGSDALE", "120 ac, T RAGSDALE SURVEY A-183"]],
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
  const fileRef = useRef<HTMLInputElement>(null);

  const loadRuns = () => api.get<IngestRun[]>("/research/ingest/runs").then(setRuns).catch(() => {});
  useEffect(() => { loadRuns(); }, []);

  function reset() {
    setCsv(null); setFilename(""); setAnalysis(null); setMapping({}); setResult(null); setError("");
    setAssignState(""); setAssignCounty("");
    if (fileRef.current) fileRef.current.value = "";
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
      if (fileRef.current) fileRef.current.value = "";
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
            <select value={category} onChange={(e) => { setCategory(e.target.value as Category); reset(); }}>
              <option value="deeds">Deeds</option>
              <option value="leases">Leases</option>
              <option value="permits">Drilling Permits</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}><label>CSV file <span className="muted" style={{ fontWeight: 400, textTransform: "none" }}>· Supported file type: CSV</span></label>
            <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
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
                  <select value={mapping[f.key] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}>
                    <option value="">— not in file —</option>
                    {analysis.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
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
          <Banner kind="info">
            Imported <strong>{result.imported.toLocaleString()}</strong> of {result.rowsTotal.toLocaleString()} rows
            {result.skipped > 0 && <> · {result.skipped.toLocaleString()} skipped{result.skippedReasons.length > 0 && <> ({result.skippedReasons.slice(0, 3).map((r) => `${r.count}× ${r.reason}`).join("; ")})</>}</>}
            {result.failed > 0 && <> · {result.failed.toLocaleString()} unreadable (bad/missing dates or required fields)</>}
          </Banner>
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
              <th>Date</th><th>Type</th><th>Geography</th><th>File</th><th>Imported</th><th>Skipped</th><th>Failed</th>
            </tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" checked={selectedRuns.has(r.id)} onChange={() => setSelectedRuns((p) => { const n = new Set(p); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })} /></td>
                  <td>{fmtDate(r.createdAt)}</td>
                  <td>{runTypeLabel(r.source)}</td>
                  <td>{[r.county, r.state].filter(Boolean).join(", ") || "—"}</td>
                  <td>{r.filename ?? "—"}</td>
                  <td>{r.rowsImported.toLocaleString()}</td>
                  <td>{r.rowsSkipped.toLocaleString()}</td>
                  <td>{r.rowsFailed.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
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
