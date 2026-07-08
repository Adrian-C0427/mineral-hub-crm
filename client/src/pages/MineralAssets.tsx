import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, MetricCard, Modal, Banner } from "../components/ui";
import { SortableTable, type Column } from "../components/SortableTable";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { useRowSelection, BulkActionsBar } from "../components/bulk";
import { TEXAS_COUNTY_OPTIONS } from "../lib/options";
import { downloadCsv } from "../lib/csv";
import { money, num, fmtDate } from "../lib/format";
import type { DealSummary, UserLite } from "../types";

/**
 * Mineral Assets — the company's permanent portfolio of owned mineral interests
 * (recordType = OWNED_ASSET). Distinct from Deals (acquisition opportunities),
 * but backed by the same Deal record so the Sell workflow, documents, map and
 * pipeline are shared, not duplicated.
 */

export const OWNERSHIP_TYPES = ["Mineral", "Royalty", "Overriding Royalty (ORRI)", "Working Interest", "NPRI", "Leasehold"];
export const OWNERSHIP_STATUSES = ["Active", "Leased", "Held by Production", "Encumbered", "Non-producing"];
export const PRODUCING_STATUSES = ["Producing", "Shut-in", "Non-producing", "Permitted"];

const fmtPct = (v: number | null): string => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

export function MineralAssets() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [assets, setAssets] = useState<DealSummary[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [users, setUsers] = useState<UserLite[]>([]);
  const sel = useRowSelection();

  const load = () => api.get<DealSummary[]>("/deals?recordType=OWNED_ASSET").then(setAssets);
  useEffect(() => { load(); api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);

  function exportSelected() {
    const rows = (assets ?? []).filter((a) => sel.selected.has(a.id));
    downloadCsv(`mineral-assets-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Asset", "State", "Counties", "Ownership", "Producing", "NRA", "Purchase Price", "Current Value", "ROI %"],
      rows.map((a) => [a.name, a.state ?? "", a.counties.join("; "), a.ownershipType ?? "", a.producingStatus ?? "", a.nra ?? "", a.purchasePrice ?? "", a.currentValue ?? "", a.roiSinceAcquisition?.toFixed(1) ?? ""]));
  }

  const totals = useMemo(() => {
    const rows = assets ?? [];
    const sum = (f: (d: DealSummary) => number | null) => rows.reduce((s, d) => s + (f(d) ?? 0), 0);
    return {
      count: rows.length,
      currentValue: sum((d) => d.currentValue),
      purchasePrice: sum((d) => d.purchasePrice),
      royalty: sum((d) => d.royaltyIncomeAnnual),
      forSale: rows.filter((d) => d.assetMode === "SELL").length,
    };
  }, [assets]);

  const columns: Column<DealSummary>[] = [
    { key: "name", header: "Asset", value: (d) => d.name, render: (d) => (
      <div><strong>{d.name}</strong>{d.assetMode === "SELL" && <span className="badge owned-badge" style={{ marginLeft: 8 }}>For sale</span>}</div>
    ) },
    { key: "location", header: "Location", value: (d) => d.counties.join(", "), render: (d) => [d.counties.join(", "), d.state].filter(Boolean).join(", ") || "—" },
    { key: "ownershipType", header: "Ownership", value: (d) => d.ownershipType, render: (d) => d.ownershipType || "—" },
    { key: "producing", header: "Producing", value: (d) => d.producingStatus, render: (d) => d.producingStatus || "—" },
    { key: "nra", header: "NRA", value: (d) => d.nra, type: "number", align: "right", render: (d) => num(d.nra) },
    { key: "purchasePrice", header: "Cost", value: (d) => d.purchasePrice, type: "number", align: "right", render: (d) => money(d.purchasePrice) },
    { key: "currentValue", header: "Current Value", value: (d) => d.currentValue, type: "number", align: "right", render: (d) => money(d.currentValue) },
    { key: "roi", header: "ROI", value: (d) => d.roiSinceAcquisition, type: "number", align: "right", render: (d) => (
      <span style={{ color: d.roiSinceAcquisition == null ? undefined : d.roiSinceAcquisition >= 0 ? "var(--green)" : "var(--red)" }}>{fmtPct(d.roiSinceAcquisition)}</span>
    ) },
    { key: "acquired", header: "Acquired", value: (d) => d.acquisitionDate, type: "date", align: "right", render: (d) => fmtDate(d.acquisitionDate) },
  ];

  if (!assets) return <Spinner label="Loading mineral assets…" />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 style={{ marginBottom: 0 }}>Mineral Assets</h1>
          <span className="muted">Owned mineral &amp; royalty interests — your portfolio, distinct from acquisition opportunities.</span>
        </div>
        {can("createDeals") && <button className="primary" onClick={() => setShowNew(true)}>+ New Asset</button>}
      </div>

      <div className="metrics-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <MetricCard label="Assets Owned" value={totals.count} hint={totals.forSale > 0 ? `${totals.forSale} marked for sale` : undefined} />
        <MetricCard label="Portfolio Value" value={money(totals.currentValue)} hint={`Cost basis ${money(totals.purchasePrice)}`} />
        <MetricCard
          label="Unrealized Gain"
          value={money(totals.currentValue - totals.purchasePrice)}
          hint={totals.purchasePrice > 0 ? fmtPct(((totals.currentValue - totals.purchasePrice) / totals.purchasePrice) * 100) : undefined}
          valueColor={(() => { const g = totals.currentValue - totals.purchasePrice; return g > 0 ? "var(--green)" : g < 0 ? "var(--red)" : undefined; })()}
        />
        <MetricCard label="Annual Royalty Income" value={money(totals.royalty)} valueColor={totals.royalty ? "var(--green)" : undefined} />
      </div>

      <div className="panel">
        {assets.length === 0 ? (
          <p className="muted">No mineral assets yet. Add one here, or convert a closed deal into an owned asset from its detail page.</p>
        ) : (
          <SortableTable
            customizeId="mineral-assets-list"
            columns={columns}
            rows={assets}
            rowKey={(d) => d.id}
            onRowClick={(d) => nav(`/assets/${d.id}`)}
            rowHref={(d) => `/assets/${d.id}`}
            defaultSort={{ key: "currentValue", dir: "desc" }}
            selection={{ selected: sel.selected, onToggle: sel.toggle, onToggleAll: sel.toggleAll }}
          />
        )}
      </div>

      <BulkActionsBar
        selectedIds={[...sel.selected]}
        onClear={sel.clear}
        onDone={load}
        users={users}
        itemLabel="asset"
        deleteUrl={can("deleteDeals") ? "/deals/bulk-delete" : undefined}
        assign={can("editDeals") ? { url: "/deals/bulk-assign", key: "assigneeIds" } : undefined}
        onExport={exportSelected}
      />

      {showNew && <NewAssetModal onClose={() => setShowNew(false)} onCreated={(d) => { setShowNew(false); nav(`/assets/${d.id}`); }} />}
    </div>
  );
}

function NewAssetModal({ onClose, onCreated }: { onClose: () => void; onCreated: (d: DealSummary) => void }) {
  const [name, setName] = useState("");
  const [counties, setCounties] = useState<string[]>([]);
  const [state, setState] = useState("TX");
  const [ownershipType, setOwnershipType] = useState(OWNERSHIP_TYPES[0]);
  const [producingStatus, setProducingStatus] = useState(PRODUCING_STATUSES[0]);
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [currentValue, setCurrentValue] = useState("");
  const [nra, setNra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) { setError("Give the asset a name."); return; }
    setBusy(true); setError(null);
    try {
      const d = await api.post<DealSummary>("/deals", {
        name: name.trim(),
        recordType: "OWNED_ASSET",
        assetMode: "HOLD",
        counties,
        state: state.trim() || null,
        ownershipType,
        producingStatus,
        acquisitionDate: acquisitionDate || null,
        purchasePrice: purchasePrice.trim() === "" ? null : Number(purchasePrice),
        currentValue: currentValue.trim() === "" ? null : Number(currentValue),
        nra: nra.trim() === "" ? null : Number(nra),
      });
      onCreated(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the asset");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New Mineral Asset"
      onClose={onClose}
      footer={<><button className="small" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create asset"}</button></>}
    >
      <div className="field"><label>Asset name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Smith Unit Royalty — Midland Co." autoFocus /></div>
      <div className="grid-2">
        <div className="field"><label>Counties</label><SearchableMultiSelect options={TEXAS_COUNTY_OPTIONS} value={counties} onChange={setCounties} placeholder="Search counties…" /></div>
        <div className="field"><label>State</label><input value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} /></div>
        <div className="field"><label>Ownership type</label><select value={ownershipType} onChange={(e) => setOwnershipType(e.target.value)}>{OWNERSHIP_TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
        <div className="field"><label>Producing status</label><select value={producingStatus} onChange={(e) => setProducingStatus(e.target.value)}>{PRODUCING_STATUSES.map((t) => <option key={t}>{t}</option>)}</select></div>
        <div className="field"><label>Acquisition date</label><input type="date" value={acquisitionDate} onChange={(e) => setAcquisitionDate(e.target.value)} /></div>
        <div className="field"><label>Net Revenue Acres (NRA)</label><input type="number" value={nra} onChange={(e) => setNra(e.target.value)} /></div>
        <div className="field"><label>Purchase price</label><input type="number" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} /></div>
        <div className="field"><label>Current estimated value</label><input type="number" value={currentValue} onChange={(e) => setCurrentValue(e.target.value)} /></div>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
    </Modal>
  );
}
