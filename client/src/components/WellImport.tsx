import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Banner, Spinner } from "./ui";
import { Select } from "./Select";
import { downloadCsv } from "../lib/csv";
import { fmtDate, fmtDateTime } from "../lib/format";
import { CsvDropzone } from "./CsvDropzone";

/**
 * Well production data management: CSV import (analyze → map headers → commit).
 * One CSV row = one well-month; wells are created automatically the first time
 * an API number (or well name + county) is seen.
 */

interface FieldDef { key: string; label: string; required?: boolean; hint?: string }
interface AnalyzeResp { headers: string[]; fields: FieldDef[]; suggestedMapping: Record<string, string>; rowCount: number; sample: Record<string, string>[] }
interface CommitResp { runId: string; rowsTotal: number; imported: number; skipped: number; failed: number; wellsCreated: number; skippedReasons: { reason: string; count: number }[] }
interface IngestRun {
  id: string; kind: string; source: string; state: string | null; county: string | null; filename: string | null;
  rowsTotal: number; rowsImported: number; rowsSkipped: number; rowsFailed: number; status: string; createdAt: string;
}

const TEMPLATE_HEADERS = ["API Number", "Well Name", "Operator", "Lease Name", "County", "Month", "Oil (bbl)", "Gas (mcf)", "NGL (bbl)", "Water (bbl)", "Days Producing"];
const TEMPLATE_ROWS = [
  ["42-329-41876", "MUSTANG DRAW UNIT 1H", "Permian Legacy Operating LLC", "MUSTANG DRAW UNIT", "Midland", "2026-04", "8125", "19500", "731", "22750", "30"],
  ["42-329-41876", "MUSTANG DRAW UNIT 1H", "Permian Legacy Operating LLC", "MUSTANG DRAW UNIT", "Midland", "2026-05", "7601", "18242", "684", "21283", "31"],
];

export function WellImport({ onDataChanged }: { onDataChanged: () => void }) {
  const [state, setState] = useState("TX");
  const [county, setCounty] = useState("");
  const [csv, setCsv] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [analysis, setAnalysis] = useState<AnalyzeResp | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CommitResp | null>(null);
  const [runs, setRuns] = useState<IngestRun[]>([]);

  const loadRuns = () =>
    api.get<IngestRun[]>("/research/ingest/runs").then((all) => setRuns(all.filter((r) => r.kind === "PRODUCTION"))).catch(() => {});
  useEffect(() => { loadRuns(); }, []);

  function reset() {
    setCsv(null); setFilename(""); setAnalysis(null); setMapping({}); setResult(null); setError("");
  }

  async function onFile(f: File) {
    reset();
    setFilename(f.name);
    const text = await f.text();
    setCsv(text);
    setBusy(true);
    try {
      const a = await api.post<AnalyzeResp>("/wells/import/analyze", { csv: text });
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
      const r = await api.post<CommitResp>("/wells/import/commit", {
        csv, mapping, state, county: county || undefined, filename: filename || undefined,
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

  const requiredMissing = analysis?.fields.filter((f) => f.required && !mapping[f.key]) ?? [];

  return (
    <div>
      <div className="panel">
        <h3>Import Production Data</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Upload monthly well production (state agency exports, purchased data or your own spreadsheets).
          Each row is one well-month; wells are created automatically and re-imports overwrite overlapping months.
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <div className="field" style={{ marginBottom: 0, width: 90 }}><label>State</label>
            <input value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="TX" />
          </div>
          <div className="field" style={{ marginBottom: 0, minWidth: 160 }}><label>County (default)</label>
            <input value={county} onChange={(e) => setCounty(e.target.value)} placeholder="e.g. Midland" />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 250 }}><label>CSV file</label>
            <CsvDropzone slim onFile={onFile} />
          </div>
          <button className="small" onClick={() => downloadCsv("well-production-template.csv", TEMPLATE_HEADERS, TEMPLATE_ROWS)}>Download template</button>
        </div>

        {busy && <Spinner label="Working…" />}
        {error && <Banner kind="error">{error}</Banner>}

        {analysis && (
          <div style={{ marginTop: 14 }}>
            <h4 style={{ margin: "0 0 6px" }}>Map columns <span className="muted" style={{ fontWeight: 400 }}>({analysis.rowCount.toLocaleString()} rows found)</span></h4>
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              {analysis.fields.map((f) => (
                <div key={f.key} className="field" style={{ marginBottom: 0, minWidth: 190 }}>
                  <label title={f.hint}>{f.label}{f.required ? " *" : ""}</label>
                  <Select value={mapping[f.key] ?? ""} onChange={(v) => setMapping((m) => ({ ...m, [f.key]: v }))}
                    placeholder="— not in file —" clearable searchable ariaLabel={`Map column for ${f.label}`}
                    options={analysis.headers.map((h) => ({ value: h, label: h }))} />
                </div>
              ))}
            </div>
            {requiredMissing.length > 0 && (
              <Banner kind="warn">Required: {requiredMissing.map((f) => f.label).join(", ")}</Banner>
            )}
            <div style={{ marginTop: 10 }}>
              <button className="primary" disabled={busy || requiredMissing.length > 0} onClick={onCommit}>
                Import {analysis.rowCount.toLocaleString()} rows
              </button>
            </div>
          </div>
        )}

        {result && (
          <Banner kind="info">
            Imported <strong>{result.imported.toLocaleString()}</strong> production months
            {result.wellsCreated > 0 && <> · created {result.wellsCreated.toLocaleString()} new wells</>}
            {result.skipped > 0 && <> · {result.skipped.toLocaleString()} skipped{result.skippedReasons.length > 0 && <> ({result.skippedReasons.slice(0, 3).map((r) => `${r.count}× ${r.reason}`).join("; ")})</>}</>}
            {result.failed > 0 && <> · {result.failed.toLocaleString()} unreadable (missing well identity or month)</>}
          </Banner>
        )}
      </div>

      <div className="panel">
        <h3>Import History</h3>
        {runs.length === 0 ? <p className="muted">No production imports yet.</p> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Date</th><th>Geography</th><th>File</th><th>Imported</th><th>Skipped</th><th>Failed</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.createdAt)}</td>
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
      </div>
    </div>
  );
}
