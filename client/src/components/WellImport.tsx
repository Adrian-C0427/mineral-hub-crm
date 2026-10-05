import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Banner, Spinner, Req } from "./ui";
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
    <>
      <section className="va-card va-import">
        <div className="va-card-head va-card-head-col">
          <h3>Import production data</h3>
          <p className="va-card-sub">
            Upload monthly well production (state agency exports, purchased data or your own spreadsheets).
            Each row is one well-month; wells are created automatically and re-imports overwrite overlapping months.
          </p>
        </div>
        <div className="va-import-body">
          <div className="va-import-fields">
            <div className="field va-import-state"><label>State</label>
              <input value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="TX" />
            </div>
            <div className="field va-import-county"><label>County (default)</label>
              <input value={county} onChange={(e) => setCounty(e.target.value)} placeholder="e.g. Midland" />
            </div>
            <button className="va-import-template" onClick={() => downloadCsv("well-production-template.csv", TEMPLATE_HEADERS, TEMPLATE_ROWS)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
              Download template
            </button>
          </div>
          <div className="field va-import-file"><label>CSV file</label>
            <CsvDropzone onFile={onFile} label={filename ? `${filename} · drop another CSV or click to choose` : "Drop a production CSV here, or click to browse"} />
          </div>

          {busy && <Spinner label="Working…" />}
          {error && <Banner kind="error">{error}</Banner>}

          {analysis && (
            <div className="va-import-map">
              <div className="va-import-map-title">Map columns <span>({analysis.rowCount.toLocaleString()} rows found)</span></div>
              <div className="va-import-map-grid">
                {analysis.fields.map((f) => (
                  <div key={f.key} className="field">
                    <label title={f.hint}>{f.label}{f.required && <Req />}</label>
                    <Select value={mapping[f.key] ?? ""} onChange={(v) => setMapping((m) => ({ ...m, [f.key]: v }))}
                      placeholder="— not in file —" clearable searchable ariaLabel={`Map column for ${f.label}`}
                      options={analysis.headers.map((h) => ({ value: h, label: h }))} />
                  </div>
                ))}
              </div>
              {requiredMissing.length > 0 && (
                <Banner kind="warn">Required: {requiredMissing.map((f) => f.label).join(", ")}</Banner>
              )}
              <div>
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
      </section>

      <section className="va-card va-import-history">
        <div className="va-card-head"><h3>Import history</h3></div>
        {runs.length === 0 ? <p className="va-saved-empty">No production imports yet.</p> : (
          <div className="va-import-history-body">
            <div className="table-scroll va-table"><table className="data-table">
              <thead><tr><th>Date</th><th>Geography</th><th>File</th><th className="right">Imported</th><th className="right">Skipped</th><th className="right">Failed</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.createdAt)}</td>
                    <td>{[r.county, r.state].filter(Boolean).join(", ") || "—"}</td>
                    <td>{r.filename ?? "—"}</td>
                    <td className="right">{r.rowsImported.toLocaleString()}</td>
                    <td className="right">{r.rowsSkipped.toLocaleString()}</td>
                    <td className="right">{r.rowsFailed.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </section>
    </>
  );
}
