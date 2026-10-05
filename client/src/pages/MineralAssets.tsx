import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Modal, Banner, SearchInput, Req, ChipList } from "../components/ui";
import { StatStrip, Segmented, Tag } from "../components/kit";
import { dealSearchHaystack } from "../lib/dealSearch";
import { Select } from "../components/Select";
import { SortableTable, type Column } from "../components/SortableTable";
import { GeoFields } from "../components/GeoFields";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { SurveyMultiPicker } from "../components/AbstractPicker";
import { ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS } from "../lib/options";
import { useRowSelection, BulkActionsBar } from "../components/bulk";
import { downloadCsv } from "../lib/csv";
import { money, num, fmtDate } from "../lib/format";
import type { DealSummary, UserLite } from "../types";
import { MoneyInput } from "../components/MoneyInput";
import { DateField } from "../components/DateField";

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
  const [q, setQ] = useState("");
  // Status tabs: "all" or one producing-status value (the app's own list).
  const [statusTab, setStatusTab] = useState("all");
  const sel = useRowSelection();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = assets ?? [];
    if (statusTab !== "all") rows = rows.filter((d) => d.producingStatus === statusTab);
    if (!needle) return rows;
    return rows.filter((d) => dealSearchHaystack(d).includes(needle));
  }, [assets, q, statusTab]);

  const load = () => api.get<DealSummary[]>("/deals?recordType=OWNED_ASSET").then(setAssets);
  useEffect(() => { load(); api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);

  function exportSelected() {
    exportRows((assets ?? []).filter((a) => sel.selected.has(a.id)));
  }
  function exportRows(rows: DealSummary[]) {
    downloadCsv(`mineral-assets-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Asset", "State", "Counties", "Asset Type", "Producing", "NRA", "Purchase Price", "Current Value", "ROI %"],
      rows.map((a) => [a.name, a.state ?? "", a.counties.join("; "), a.assetTypes.join("/") || (a.ownershipType ?? ""), a.producingStatus ?? "", a.nra ?? "", a.purchasePrice ?? "", a.currentValue ?? "", a.roiSinceAcquisition?.toFixed(1) ?? ""]));
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
      producing: rows.filter((d) => d.producingStatus === "Producing").length,
      noValue: rows.filter((d) => d.currentValue == null).length,
      nra: sum((d) => d.nra),
    };
  }, [assets]);

  const columns: Column<DealSummary>[] = [
    { key: "name", header: "Asset", value: (d) => d.name, render: (d) => {
      // Sub-line: which economics are still blank, else surveys / operator.
      const missing = [d.nra == null && "NRA", d.purchasePrice == null && "cost", d.currentValue == null && "value", !d.acquisitionDate && "acquired date"].filter(Boolean) as string[];
      const sub = (d.surveys ?? []).join(", ") || d.operator || "";
      return (
        <div className="ma-asset">
          <span className="ma-asset-name"><strong>{d.name}</strong>{d.assetMode === "SELL" && <Tag tone="warn">For sale</Tag>}</span>
          {missing.length > 0
            ? <span className="ma-asset-sub missing">Missing {missing.join(", ")}</span>
            : sub && <span className="ma-asset-sub" title={sub}>{sub}</span>}
        </div>
      );
    } },
    { key: "location", header: "Location", value: (d) => d.counties.join(", "), render: (d) => <ChipList items={[...d.counties, d.state]} max={4} /> },
    // Standardized asset type (RI/ORRI/…); legacy rows created before the
    // rename still show their old free-text ownershipType.
    { key: "ownershipType", header: "Type", value: (d) => d.assetTypes.join("/") || d.ownershipType, render: (d) => (
      d.assetTypes.length
        ? <span className="ma-types">{d.assetTypes.map((t) => <span key={t} className="ma-type" title={ASSET_TYPE_LABELS[t] ?? t}>{t}</span>)}</span>
        : <ChipList items={[d.ownershipType]} />
    ) },
    { key: "producing", header: "Status", value: (d) => d.producingStatus,
      render: (d) => d.producingStatus
        ? <Tag dot tone={d.producingStatus === "Producing" ? "success" : "neutral"}>{d.producingStatus}</Tag>
        : <span className="ma-none">—</span> },
    { key: "nra", header: "NRA", value: (d) => d.nra, type: "number", align: "right", render: (d) => num(d.nra) },
    { key: "purchasePrice", header: "Cost", value: (d) => d.purchasePrice, type: "number", align: "right", render: (d) => money(d.purchasePrice) },
    { key: "currentValue", header: "Current value", value: (d) => d.currentValue, type: "number", align: "right", render: (d) => <span className="ma-strong">{money(d.currentValue)}</span> },
    { key: "roi", header: "ROI", value: (d) => d.roiSinceAcquisition, type: "number", align: "right", render: (d) => (
      <span className={d.roiSinceAcquisition == null ? "ma-none" : d.roiSinceAcquisition >= 0 ? "ma-pos" : "ma-neg"}>{fmtPct(d.roiSinceAcquisition)}</span>
    ) },
    { key: "income", header: "Income / yr", value: (d) => d.royaltyIncomeAnnual, type: "number", align: "right", render: (d) => money(d.royaltyIncomeAnnual) },
    { key: "acquired", header: "Acquired", value: (d) => d.acquisitionDate, type: "date", align: "right", render: (d) => fmtDate(d.acquisitionDate) },
  ];

  // Status tabs: All plus each producing status that occurs in the portfolio.
  const statusTabs = [
    { value: "all", label: "All", count: assets?.length ?? 0 },
    ...PRODUCING_STATUSES.map((st) => ({ value: st, label: st, count: (assets ?? []).filter((d) => d.producingStatus === st).length }))
      .filter((t) => t.count > 0 || t.value === statusTab),
  ];
  const gain = totals.currentValue - totals.purchasePrice;

  if (!assets) return <Spinner label="Loading mineral assets…" />;

  return (
    <div className="page contacts-page assets-page">
      <div className="page-header">
        <div>
          <h1 style={{ marginBottom: 0 }}>Mineral Assets</h1>
          <div className="page-sub">Owned mineral &amp; royalty interests — your portfolio, distinct from acquisition opportunities.</div>
        </div>
        <div className="ma-actions">
          {assets.length > 0 && (
            <button type="button" onClick={() => exportRows(filtered)} title="Export the assets shown to CSV">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
              Export CSV
            </button>
          )}
          {can("createDeals") && (
            <button className="pbtn pbtn-primary" onClick={() => setShowNew(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              New asset
            </button>
          )}
        </div>
      </div>

      <StatStrip min={220} className="ma-stats" cells={[
        { label: "Assets owned", value: num(totals.count),
          sub: [`${totals.producing} producing`, totals.forSale > 0 ? `${totals.forSale} marked for sale` : null].filter(Boolean).join(" · ") },
        { label: "Portfolio value", value: money(totals.currentValue),
          sub: <>Cost basis {money(totals.purchasePrice)}{totals.noValue > 0 && <span className="ma-warn"> · {totals.noValue} without a value</span>}</> },
        { label: "Unrealized gain", value: money(gain), tone: gain > 0 ? "success" : gain < 0 ? "danger" : "default",
          sub: totals.purchasePrice > 0
            ? `${fmtPct((gain / totals.purchasePrice) * 100)} on cost`
            : totals.currentValue > 0 ? <span className="ma-warn">Cost basis not set — add purchase price for a real gain figure</span> : undefined },
        { label: "Annual royalty income", value: money(totals.royalty), tone: totals.royalty ? "success" : "default",
          sub: totals.royalty ? "Trailing 12 mo · from revenue" : "Fills in from royalty income on each asset" },
      ]} />

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

      <div className="ct-card">
        {assets.length === 0 ? (
          <p className="muted" style={{ padding: "18px 20px", margin: 0 }}>No mineral assets yet. Add one here, or convert a closed deal into an owned asset from its detail page.</p>
        ) : (
          <SortableTable
            customizeId="mineral-assets-list"
            toolbar={
              <>
                <SearchInput value={q} onChange={setQ} placeholder="Search asset, abstract, survey, county, operator" ariaLabel="Search mineral assets" />
                {statusTabs.length > 1 && <Segmented options={statusTabs} value={statusTab} onChange={setStatusTab} ariaLabel="Producing status" />}
                {(q || statusTab !== "all") && <span className="muted" style={{ fontSize: 13, whiteSpace: "nowrap" }}>Showing {filtered.length} of {assets.length}</span>}
              </>
            }
            columns={columns}
            rows={filtered}
            rowKey={(d) => d.id}
            onRowClick={(d) => nav(`/assets/${d.id}`)}
            rowHref={(d) => `/assets/${d.id}`}
            defaultSort={{ key: "currentValue", dir: "desc" }}
            empty="No assets match your search."
            selection={{ selected: sel.selected, onToggle: sel.toggle, onToggleAll: sel.toggleAll }}
            rowsPerPage={[20, 50, 100, 200]}
            paginationNoun="asset"
            footerExtra={`${totals.nra ? ` · ${num(totals.nra)} total NRA` : ""}${totals.currentValue > 0 ? ` · ${money(totals.currentValue)} total value` : ""}`}
          />
        )}
      </div>

      {showNew && <NewAssetModal onClose={() => setShowNew(false)} onCreated={(d) => { setShowNew(false); nav(`/assets/${d.id}`); }} />}
    </div>
  );
}

function NewAssetModal({ onClose, onCreated }: { onClose: () => void; onCreated: (d: DealSummary) => void }) {
  const [name, setName] = useState("");
  const [states, setStates] = useState<string[]>([]);
  const [counties, setCounties] = useState<string[]>([]);
  const [abstractIds, setAbstractIds] = useState<string[]>([]);
  const [surveys, setSurveys] = useState<string[]>([]);
  const [assetTypes, setAssetTypes] = useState<string[]>([]);
  const [producingStatus, setProducingStatus] = useState(PRODUCING_STATUSES[0]);
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [currentValue, setCurrentValue] = useState("");
  const [nra, setNra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    // Assets require the full location chain + type — same bar as deals.
    const missing = [
      [name.trim() !== "", "Asset Name"], [states.length > 0, "State"], [counties.length > 0, "County"],
      [abstractIds.length > 0, "Abstract"], [surveys.length > 0, "Survey"], [assetTypes.length > 0, "Asset Type"],
    ].filter(([ok]) => !ok).map(([, label]) => label as string);
    if (missing.length) { setError(`Missing required fields: ${missing.join(", ")}`); return; }
    setBusy(true); setError(null);
    try {
      const d = await api.post<DealSummary>("/deals", {
        name: name.trim(),
        recordType: "OWNED_ASSET",
        assetMode: "HOLD",
        states,
        state: states[0] ?? null,
        counties,
        abstractIds,
        surveys,
        assetTypes,
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
      subtitle="An owned mineral or royalty interest added to your portfolio"
      onClose={onClose}
      wide
      footer={<>
        <span className="modal-req-note"><Req /> Required</span>
        <button className="small" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create asset"}</button>
      </>}
    >
      {/* Standard sectioned creation layout (same system as New Deal / New Buyer). */}
      <div className="modal-sec">Basics</div>
      <div className="nd-grid3">
        <div className="field" style={{ gridColumn: "1 / -1" }}><label>Asset name <Req /></label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Smith Unit Royalty — Midland Co." autoFocus /></div>
        <div className="field"><label>Asset type <Req /></label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={assetTypes} onChange={setAssetTypes} placeholder="Search asset types…" /></div>
        <div className="field"><label>Producing status</label><Select value={producingStatus} onChange={setProducingStatus} ariaLabel="Producing status" options={PRODUCING_STATUSES.map((t) => ({ value: t, label: t }))} /></div>
      </div>

      <div className="modal-sec">Location</div>
      <div className="nd-grid3">
        <GeoFields states={states} onStatesChange={setStates} counties={counties} onCountiesChange={setCounties} abstractIds={abstractIds} onAbstractsChange={setAbstractIds}
          labels={{ state: <>State <Req /></>, county: <>County <Req /></>, abstract: <>Abstract <Req /></> }} />
        <div className="field"><label>Survey name <Req /></label><SurveyMultiPicker value={surveys} onChange={setSurveys} abstractIds={abstractIds} /></div>
      </div>

      <div className="modal-sec">Economics</div>
      <div className="nd-grid3">
        <div className="field"><label>Net Revenue Acres (NRA)</label><input type="number" value={nra} onChange={(e) => setNra(e.target.value)} /></div>
        <div className="field"><label>Purchase price</label><MoneyInput value={purchasePrice} onChange={setPurchasePrice} ariaLabel="Purchase price" /></div>
        <div className="field"><label>Current estimated value</label><input type="number" value={currentValue} onChange={(e) => setCurrentValue(e.target.value)} /></div>
        <div className="field"><label>Acquisition date</label><DateField value={acquisitionDate} onChange={(v) => setAcquisitionDate(v)} /></div>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
    </Modal>
  );
}
