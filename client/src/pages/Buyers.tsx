import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { RelationshipDot, Spinner, Banner } from "../components/ui";
import { Select } from "../components/Select";
import { SortableTable, type Column } from "../components/SortableTable";
import { NewBuyerModal } from "../components/NewBuyerModal";
import { useRowSelection, BulkActionsBar } from "../components/bulk";
import { pct } from "../lib/format";
import { downloadCsv } from "../lib/csv";
import { useAuth } from "../auth/AuthContext";
import type { UserLite } from "../types";

interface BuyerRow {
  id: string;
  name: string;
  companyName: string;
  contactName: string | null;
  focusArea: string;
  relationshipStatus: "HOT" | "WARM" | "COLD";
  closeRate: number;
  closedDeals: number;
  source: string | null;
  portalLead: boolean;
  duplicateReview: boolean;
}

export function Buyers() {
  const { can } = useAuth();
  const [buyers, setBuyers] = useState<BuyerRow[] | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [users, setUsers] = useState<UserLite[]>([]);
  const sel = useRowSelection();
  const nav = useNavigate();

  // The only major list without search/filters until now.
  const [q, setQ] = useState("");
  const [rel, setRel] = useState("");

  function load() { api.get<BuyerRow[]>("/buyers").then(setBuyers); }
  useEffect(() => { load(); api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);

  const filtered = useMemo(() => {
    if (!buyers) return [];
    const needle = q.trim().toLowerCase();
    return buyers.filter((b) => {
      if (rel && b.relationshipStatus !== rel) return false;
      if (!needle) return true;
      return [b.companyName, b.contactName, b.name, b.focusArea]
        .some((v) => v?.toLowerCase().includes(needle));
    });
  }, [buyers, q, rel]);

  if (!buyers) return <Spinner />;

  const columns: Column<BuyerRow>[] = [
    { key: "buyer", header: "Buyer", type: "text", value: (b) => b.companyName,
      render: (b) => (
        <div>
          <strong>{b.companyName}</strong>
          {/* Provenance at a glance: portal-captured leads and fuzzy-match reviews. */}
          {b.portalLead && <span className="badge" style={{ marginLeft: 6 }} title="Created or updated by a Buyer Portal submission">Portal lead</span>}
          {b.duplicateReview && <span className="badge" style={{ marginLeft: 6, background: "var(--red)", color: "#fff" }} title="Possible duplicate of an existing buyer — review and merge if needed">Review</span>}
          {b.contactName && <div className="muted" style={{ fontSize: 12 }}>{b.contactName}</div>}
        </div>
      ) },
    { key: "focus", header: "Focus Area", type: "text", value: (b) => b.focusArea },
    { key: "rel", header: "Relationship", type: "text", value: (b) => ({ HOT: 0, WARM: 1, COLD: 2 }[b.relationshipStatus]),
      render: (b) => <RelationshipDot status={b.relationshipStatus} /> },
    // New buyers show "—" rather than a discouraging 0% / 0 until they have history.
    { key: "close", header: "Close %", type: "number", align: "right", value: (b) => b.closeRate, render: (b) => (b.closedDeals > 0 ? pct(b.closeRate) : "—") },
    { key: "deals", header: "Deals", type: "number", align: "right", value: (b) => b.closedDeals, render: (b) => (b.closedDeals > 0 ? String(b.closedDeals) : "—") },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Buyers</h1>
        <div className="row">
          {can("createBuyers") && <button onClick={() => setShowImport((s) => !s)}>{showImport ? "Close import" : "Import CSV"}</button>}
          {can("createBuyers") && <button className="primary" onClick={() => setShowNew(true)}>+ New Buyer</button>}
        </div>
      </div>

      <div className="row" style={{ gap: 10, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 260px", maxWidth: 380 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none" }}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company, contact, focus area…" style={{ paddingLeft: 32 }} aria-label="Search buyers" />
        </div>
        <Select value={rel} onChange={setRel} width={170} placeholder="All relationships" clearable ariaLabel="Filter by relationship"
          options={[{ value: "HOT", label: "Hot" }, { value: "WARM", label: "Warm" }, { value: "COLD", label: "Cold" }]} />
        {(q || rel) && <span className="muted" style={{ fontSize: 13 }}>Showing {filtered.length} of {buyers.length}</span>}
      </div>

      <SortableTable
        customizeId="buyers-list"
        columns={columns}
        rows={filtered}
        rowKey={(b) => b.id}
        onRowClick={(b) => nav(`/buyers/${b.id}`)}
        rowHref={(b) => `/buyers/${b.id}`}
        defaultSort={{ key: "buyer", dir: "asc" }}
        empty={buyers.length === 0 ? "No buyers yet. Import a CSV or add one manually." : "No buyers match your search."}
        selection={{ selected: sel.selected, onToggle: sel.toggle, onToggleAll: sel.toggleAll }}
      />

      <BulkActionsBar
        selectedIds={[...sel.selected]}
        onClear={sel.clear}
        onDone={load}
        users={users}
        itemLabel="buyer"
        deleteUrl={can("deleteBuyers") ? "/buyers/bulk-delete" : undefined}
        assign={can("editBuyers") ? { url: "/buyers/bulk-assign", key: "ownerIds" } : undefined}
        onExport={() => {
          const rows = buyers.filter((b) => sel.selected.has(b.id));
          downloadCsv(`buyers-${new Date().toISOString().slice(0, 10)}.csv`,
            ["Company", "Contact", "Focus Area", "Relationship", "Close %", "Closed Deals"],
            rows.map((b) => [b.companyName, b.contactName ?? "", b.focusArea, b.relationshipStatus, b.closeRate, b.closedDeals]));
        }}
      />

      {showImport && <ImportWizard onDone={() => { load(); }} />}
      {showNew && <NewBuyerModal onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); nav(`/buyers/${id}`); }} />}
    </div>
  );
}

// --- Inline CSV import wizard (Upload → Map → Preview → Results) ---
type Step = "upload" | "map" | "preview" | "results";
interface AnalyzeResp { headers: string[]; fields: { key: string; label: string; required?: boolean }[]; suggestedMapping: Record<string, string>; rowCount: number; }
interface PreviewResp { rows: { index: number; status: string; reason: string; companyName: string; name: string; email: string | null }[]; counts: { new: number; duplicate: number; error: number }; }
interface CommitResp { inserted: number; skipped: number; errors: number; }

function ImportWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("upload");
  const [csv, setCsv] = useState("");
  const [analyze, setAnalyze] = useState<AnalyzeResp | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [result, setResult] = useState<CommitResp | null>(null);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    const text = await file.text();
    setCsv(text);
    setBusy(true); setErr(null);
    try {
      const a = await api.post<AnalyzeResp>("/buyers/import/analyze", { csv: text });
      setAnalyze(a);
      setMapping(a.suggestedMapping);
      setStep("map");
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not read CSV"); }
    finally { setBusy(false); }
  }

  async function doPreview() {
    if (!mapping.companyName) { setErr("Map the Company Name field to proceed."); return; }
    setBusy(true); setErr(null);
    try {
      const p = await api.post<PreviewResp>("/buyers/import/preview", { csv, mapping });
      setPreview(p); setStep("preview");
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Preview failed"); }
    finally { setBusy(false); }
  }

  async function doCommit() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<CommitResp>("/buyers/import/commit", { csv, mapping });
      setResult(r); setStep("results"); onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Import failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="section-head">
        <h3>Import buyers from CSV</h3>
        <span className="muted">Step: {step === "upload" ? "1 · Upload" : step === "map" ? "2 · Map fields" : step === "preview" ? "3 · Preview" : "4 · Results"}</span>
      </div>
      {err && <div className="error-text">{err}</div>}

      {step === "upload" && (
        <div
          className={`dropzone ${drag ? "drag" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
          onClick={() => document.getElementById("csv-input")?.click()}
        >
          {busy ? "Reading…" : "Drag & drop a CSV here, or click to choose a file"}
          <input id="csv-input" type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
        </div>
      )}

      {step === "map" && analyze && (
        <>
          <p className="muted">Map your CSV columns to buyer fields. <strong>Company Name is required.</strong> Blank optional fields are fine.</p>
          <div className="dd-grid">
            {analyze.fields.map((f) => (
              <div className="field" key={f.key}>
                <label>{f.label}{f.required ? " *" : ""}</label>
                <Select value={mapping[f.key] ?? ""} onChange={(v) => setMapping((m) => ({ ...m, [f.key]: v }))}
                  placeholder="— not mapped —" clearable searchable ariaLabel={`Map column for ${f.label}`}
                  options={analyze.headers.map((h) => ({ value: h, label: h }))} />
              </div>
            ))}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <button onClick={() => setStep("upload")}>Back</button>
            <button className="primary" onClick={doPreview} disabled={busy || !mapping.companyName}>Preview ({analyze.rowCount} rows)</button>
          </div>
        </>
      )}

      {step === "preview" && preview && (
        <>
          <div className="row" style={{ gap: 18, marginBottom: 10 }}>
            <span className="badge resp-offer">{preview.counts.new} New</span>
            <span className="badge resp-pending">{preview.counts.duplicate} Duplicate</span>
            <span className="badge resp-no">{preview.counts.error} Error</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 320 }}>
            <table className="data-table">
              <thead><tr><th>#</th><th>Company</th><th>Name</th><th>Email</th><th>Status</th><th>Reason</th></tr></thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.index} className={r.status === "Error" ? "row-overdue" : r.status === "Duplicate" ? "row-dimmed" : ""}>
                    <td>{r.index + 1}</td><td>{r.companyName || "—"}</td><td>{r.name}</td><td>{r.email ?? "—"}</td><td>{r.status}</td><td>{r.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <button onClick={() => setStep("map")}>Back</button>
            <button className="primary" onClick={doCommit} disabled={busy || preview.counts.new === 0}>Import {preview.counts.new} buyers</button>
          </div>
        </>
      )}

      {step === "results" && result && (
        <div>
          <Banner kind="info">
            Imported <strong>{result.inserted}</strong> new buyer{result.inserted !== 1 ? "s" : ""}. Skipped {result.skipped} duplicate(s), {result.errors} error(s).
          </Banner>
          <button onClick={() => { setStep("upload"); setCsv(""); setAnalyze(null); setPreview(null); setResult(null); }}>Import another file</button>
        </div>
      )}
    </div>
  );
}
