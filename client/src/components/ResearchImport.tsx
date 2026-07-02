import { useEffect, useRef, useState } from "react";
import { api, getAuthToken } from "../api/client";
import { Banner, Spinner } from "./ui";
import { downloadCsv } from "../lib/csv";
import { fmtDate } from "../lib/format";

/**
 * Research data management: CSV import through the server's source-adapter
 * registry (analyze → map headers → commit), import history, and bulk delete.
 */

interface SourceDef { key: string; label: string; kind: "DOCUMENTS" | "PERMITS"; description: string }
interface FieldDef { key: string; label: string; required?: boolean }
interface SourcesResp { sources: SourceDef[]; documentFields: FieldDef[]; permitFields: FieldDef[] }
interface AnalyzeResp { headers: string[]; fields: FieldDef[]; suggestedMapping: Record<string, string>; rowCount: number; sample: Record<string, string>[] }
interface CommitResp { runId: string; rowsTotal: number; imported: number; skipped: number; failed: number; skippedReasons: { reason: string; count: number }[] }
interface IngestRun {
  id: string; kind: string; source: string; state: string | null; county: string | null; filename: string | null;
  rowsTotal: number; rowsImported: number; rowsSkipped: number; rowsFailed: number; status: string; createdAt: string;
}

const SAMPLE_DOC_ROWS = [
  ["Mineral Deed", "03/12/2026", "Smith, John et ux", "Blackrock Minerals LLC", "2026-00412", "Leon", "289653", "J HALLMARK", "40", ""],
  ["Oil & Gas Lease", "03/14/2026", "Jones Family Trust", "Apex Energy Partners LP", "2026-00418", "Leon", "289183", "T RAGSDALE", "120", ""],
];
const SAMPLE_PERMIT_ROWS = [
  ["Apex Energy Partners LP", "Leon", "42-289-40012", "889321", "HALLMARK UNIT", "1H", "Approved", "Horizontal", "03/02/2026", "03/20/2026", "", ""],
];

export function ResearchImport({ onDataChanged }: { onDataChanged: () => void }) {
  const [sources, setSources] = useState<SourcesResp | null>(null);
  const [kind, setKind] = useState<"DOCUMENTS" | "PERMITS">("DOCUMENTS");
  const [source, setSource] = useState("");
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadRuns = () => api.get<IngestRun[]>("/research/ingest/runs").then(setRuns).catch(() => {});
  useEffect(() => {
    api.get<SourcesResp>("/research/ingest/sources").then((s) => {
      setSources(s);
      setSource(s.sources.find((x) => x.kind === "DOCUMENTS")?.key ?? "");
    }).catch(() => {});
    loadRuns();
  }, []);

  const kindSources = sources?.sources.filter((s) => s.kind === kind) ?? [];

  function reset() {
    setCsv(null); setFilename(""); setAnalysis(null); setMapping({}); setResult(null); setError("");
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onFile(f: File) {
    reset();
    setFilename(f.name);
    const text = await f.text();
    setCsv(text);
    setBusy(true);
    try {
      const a = await api.post<AnalyzeResp>("/research/ingest/analyze", { kind, source, csv: text });
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
        kind, source, csv, mapping, state, county: county || undefined, filename: filename || undefined,
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
    if (kind === "DOCUMENTS") {
      downloadCsv("research-documents-template.csv",
        ["Instrument Type", "Recording Date", "Grantor", "Grantee", "Instrument Number", "County", "Abstract", "Survey", "Acreage", "Consideration"],
        SAMPLE_DOC_ROWS);
    } else {
      downloadCsv("research-permits-template.csv",
        ["Operator Name", "County", "API No", "Permit No", "Lease Name", "Well No", "Status", "Wellbore Profile", "Submitted Date", "Approved Date", "Spud Date", "Formation"],
        SAMPLE_PERMIT_ROWS);
    }
  }

  const requiredMissing = analysis?.fields.filter((f) => f.required && !mapping[f.key]) ?? [];

  return (
    <div>
      <div className="panel">
        <h3>Import Public-Records Data</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Upload county recording indexes (mineral deeds, leases, assignments…) or drilling-permit exports.
          Rows are classified, normalized and de-duplicated automatically; non-mineral instruments (liens, deeds of trust, easements) are skipped.
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <div className="field" style={{ marginBottom: 0 }}><label>Data kind</label>
            <select value={kind} onChange={(e) => { const k = e.target.value as "DOCUMENTS" | "PERMITS"; setKind(k); setSource(sources?.sources.find((s) => s.kind === k)?.key ?? ""); reset(); }}>
              <option value="DOCUMENTS">County recordings (deeds & leases)</option>
              <option value="PERMITS">Drilling permits</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, minWidth: 240 }}><label>Source format</label>
            <select value={source} onChange={(e) => { setSource(e.target.value); reset(); }}>
              {kindSources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, width: 90 }}><label>State</label>
            <input value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="TX" />
          </div>
          <div className="field" style={{ marginBottom: 0, minWidth: 160 }}><label>County (default)</label>
            <input value={county} onChange={(e) => setCounty(e.target.value)} placeholder="e.g. Leon" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}><label>CSV file</label>
            <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </div>
          <button className="small" onClick={downloadTemplate}>Download template</button>
        </div>
        {kindSources.find((s) => s.key === source) && (
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{kindSources.find((s) => s.key === source)!.description}</p>
        )}

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
            <div style={{ marginTop: 10 }}>
              <button className="primary" disabled={busy || requiredMissing.length > 0} onClick={onCommit}>
                Import {analysis.rowCount.toLocaleString()} rows
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
        <h3>Import History</h3>
        {runs.length === 0 ? <p className="muted">No imports yet.</p> : (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Date</th><th>Kind</th><th>Source</th><th>Geography</th><th>File</th><th>Imported</th><th>Skipped</th><th>Failed</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.createdAt)}</td>
                  <td>{r.kind === "DOCUMENTS" ? "Recordings" : "Permits"}</td>
                  <td>{r.source}</td>
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

      <div className="panel">
        <h3>Remove Data</h3>
        <p className="muted" style={{ marginTop: 0 }}>Clear imported research data for this organization (e.g. to redo a bad import or remove the sample dataset).</p>
        {!confirmDelete ? (
          <button className="small danger" onClick={() => setConfirmDelete(true)}>Delete research data…</button>
        ) : (
          <DeleteForm onDone={() => { setConfirmDelete(false); loadRuns(); onDataChanged(); }} onCancel={() => setConfirmDelete(false)} />
        )}
      </div>
    </div>
  );
}

function DeleteForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState("");
  const [source, setSource] = useState("");
  const [state, setState] = useState("");
  const [county, setCounty] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true); setError("");
    try {
      // DELETE with a JSON body (the shared api.del helper doesn't take one).
      const token = getAuthToken();
      const res = await fetch(`${api.base}/api/research/data`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          ...(kind ? { kind } : {}), ...(source ? { source } : {}),
          ...(state ? { state } : {}), ...(county ? { county } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
        <div className="field" style={{ marginBottom: 0 }}><label>Kind</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All</option><option value="DOCUMENTS">Recordings</option><option value="PERMITS">Permits</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}><label>Source</label><input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. sample (blank = all)" /></div>
        <div className="field" style={{ marginBottom: 0, width: 90 }}><label>State</label><input value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="All" /></div>
        <div className="field" style={{ marginBottom: 0 }}><label>County</label><input value={county} onChange={(e) => setCounty(e.target.value)} placeholder="All" /></div>
        <button className="danger" disabled={busy} onClick={run}>{busy ? "Deleting…" : "Delete matching data"}</button>
        <button className="small" onClick={onCancel}>Cancel</button>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
    </div>
  );
}
