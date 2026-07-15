import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, MetricCard, Banner, MatchBar, Modal, ConfirmDialog, BackLink } from "../components/ui";
import { Select } from "../components/Select";
import { BuyerActivitySection } from "../components/BuyerActivitySection";
import { CollapsibleSection } from "../components/CollapsibleSection";
import { LogContactModal } from "../components/LogContactModal";
import { SendDealEmailModal } from "../components/SendDealEmailModal";
import { DealPortalPanel } from "../components/DealPortalPanel";
import { DocumentsSection, type DocFile } from "../components/DocumentsSection";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { GeoFields } from "../components/GeoFields";
import { useAbstractLabels, SurveyMultiPicker } from "../components/AbstractPicker";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS } from "../lib/options";
import { monthLabel, chartTooltip } from "../lib/charts";
import { money, num, fmtDate, toInputDate } from "../lib/format";
import { OWNERSHIP_TYPES, OWNERSHIP_STATUSES, PRODUCING_STATUSES } from "./MineralAssets";
import type { BuyerActivityRow, DealSummary, MatchRec, RevenueEntry, Seller, UserLite } from "../types";
import { MoneyInput } from "../components/MoneyInput";
const DealMap = lazy(() => import("../components/DealMap").then((m) => ({ default: m.DealMap })));
const TractSection = lazy(() => import("../components/TractSection").then((m) => ({ default: m.TractSection })));

// Mineral-asset document categories (module-specific; the shared DocumentsSection
// provides the identical Deal-page interface around them).
const ASSET_DOC_FOLDERS = ["Division Orders", "Deeds", "Leases", "Check Stubs", "Title", "Other"];

// Current-lease selectors.
const LEASE_STATUS_OPTIONS = ["Leased", "Held By Production", "Expired", "In Negotiation", "Unleased", "Top Lease", "Shut-in"];
const ROYALTY_RATE_OPTIONS = ["1/16", "1/8", "3/16", "1/6", "1/5", "1/4"];

interface AssetDetail extends DealSummary {
  operator: string | null;
  notes: string | null;
  buyerActivity: BuyerActivityRow[];
  offers: { id: string; buyer: { id: string; name: string }; amount: number; status: string; conditions: string | null; expirationDate: string | null; dateSubmitted: string }[];
  files: DocFile[];
  sellers: Seller[];
  revenueEntries: RevenueEntry[];
  canViewTaxId: boolean;
  metrics: { buyersContacted: number; interested: number; offers: number; highOffer: number | null };
}

const fmtPct = (v: number | null): string => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const REV_COLOR = "#22c55e";
/** Positive financial values render in the app's success green; negative in red. */
const posColor = (v: number | null | undefined): string | undefined =>
  v == null || v === 0 ? undefined : v > 0 ? "var(--green)" : "var(--red)";
/** Match-percent scale (green/amber/red) — mirrors the deal page. */
const matchColor = (pct: number): string => (pct >= 67 ? "#4ade80" : pct >= 34 ? "#f59e0b" : "#f87171");

export function MineralAssetDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const [asset, setAsset] = useState<AssetDetail | null>(null);
  const [matches, setMatches] = useState<MatchRec[] | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [tab, setTab] = useState<"hold" | "sell">("hold");

  const load = useCallback(() => api.get<AssetDetail>(`/deals/${id}`).then((d) => { setAsset(d); setTab(d.assetMode === "SELL" ? "sell" : "hold"); }), [id]);
  const loadMatches = useCallback(() => api.get<MatchRec[]>(`/deals/${id}/matches`).then(setMatches), [id]);
  useEffect(() => {
    api.get<AssetDetail>(`/deals/${id}`).then(setAsset);
    api.get<UserLite[]>("/users").then(setUsers).catch(() => {});
  }, [id]);
  // Initialize the tab from the asset's mode once, on first load.
  useEffect(() => { if (asset && matches === null) loadMatches(); }, [asset, matches, loadMatches]);

  if (!asset) return <Spinner />;
  const canEdit = can("editDeals");
  const refresh = () => { load(); loadMatches(); };

  async function setMode(mode: "HOLD" | "SELL") {
    await api.post(`/deals/${id}/asset-mode`, { assetMode: mode });
    refresh();
  }

  return (
    // `deal-detail` opts equivalent sections (KV grids, match cards, criteria
    // tags, panels) into the same styling used on the Active Deal page, so an
    // owned asset looks and behaves like a deal wherever the sections overlap.
    <div className="page deal-detail">
      <BackLink label="Back to Mineral Assets" fallback="/assets" />
      <div className="page-header">
        <div className="row">
          <h1 style={{ marginBottom: 0 }}>{asset.name}</h1>
          <span className="badge owned-badge">Owned Asset</span>
          {asset.ownershipType && <span className="badge resp-pending">{asset.ownershipType}</span>}
          {asset.assetMode === "SELL" && <span className="badge resp-interested">Marketing for sale</span>}
        </div>
        <div className="row">
          {canEdit && asset.assetMode !== "SELL" && <button className="primary" onClick={() => setMode("SELL")}>Mark for Sale</button>}
          {canEdit && asset.assetMode === "SELL" && <button onClick={() => setMode("HOLD")}>Move to Hold</button>}
        </div>
      </div>

      <div className="metrics-row">
        <MetricCard label="Current Value" value={money(asset.currentValue)} />
        <MetricCard label="Purchase Price" value={money(asset.purchasePrice)} hint={asset.acquisitionDate ? `Acquired ${fmtDate(asset.acquisitionDate)}` : undefined} />
        <MetricCard label="ROI Since Acquisition" value={fmtPct(asset.roiSinceAcquisition)} valueColor={posColor(asset.roiSinceAcquisition)} />
        <MetricCard label="Unrealized Gain / Loss" value={money(asset.unrealizedGainLoss)} valueColor={posColor(asset.unrealizedGainLoss)} />
        <MetricCard label="Annual Royalty Income" value={money(asset.royaltyIncomeAnnual)} hint="Trailing 12 mo · from revenue" valueColor={asset.royaltyIncomeAnnual ? "var(--green)" : undefined} />
      </div>

      <div className="asset-tabs">
        <button className={`tab ${tab === "hold" ? "active" : ""}`} onClick={() => setTab("hold")}>Hold — Portfolio Management</button>
        <button className={`tab ${tab === "sell" ? "active" : ""}`} onClick={() => setTab("sell")}>Sell — Active Marketing</button>
      </div>

      {tab === "hold" ? (
        <HoldTab asset={asset} canEdit={canEdit} onChanged={load} />
      ) : (
        <SellTab asset={asset} matches={matches} users={users} canEdit={canEdit} onChanged={refresh} onSetSell={() => setMode("SELL")} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hold tab — ownership, financials, property, revenue, map, sellers, docs
// ---------------------------------------------------------------------------

function HoldTab({ asset, canEdit, onChanged }: { asset: AssetDetail; canEdit: boolean; onChanged: () => void }) {
  return (
    <div>
      <div className="grid-2">
        <OwnershipCard asset={asset} canEdit={canEdit} onSaved={onChanged} />
        <PropertyCard asset={asset} canEdit={canEdit} onSaved={onChanged} />
      </div>

      <FinancialsCard asset={asset} canEdit={canEdit} onSaved={onChanged} />

      <div className="panel">
        <div className="section-head"><h3>Location</h3><span className="muted">This asset's abstracts and geographic extent</span></div>
        <Suspense fallback={<Spinner label="Loading map…" />}><DealMap abstractIds={asset.abstractIds} /></Suspense>
      </div>

      {/* Legal tract descriptions → parsed calls → mapped polygons + exports —
          identical to the Deal page. */}
      <Suspense fallback={<div className="panel"><Spinner label="Loading tract descriptions…" /></div>}>
        <TractSection dealId={asset.id} dealName={asset.name} canEdit={canEdit} abstractIds={asset.abstractIds} />
      </Suspense>

      <DocumentsSection ownerType="deal" ownerId={asset.id} files={asset.files} folders={ASSET_DOC_FOLDERS} onChanged={onChanged} canEdit={canEdit} canDelete={canEdit} />
    </div>
  );
}

function EditCard({ title, children, editing, onEdit, onCancel, onSave, canEdit }: {
  title: string; children: React.ReactNode; editing: boolean; onEdit: () => void; onCancel: () => void; onSave: () => void; canEdit: boolean;
}) {
  return (
    <div className="panel">
      <div className="section-head">
        <h3 style={{ margin: 0 }}>{title}</h3>
        {canEdit && (editing
          ? <div className="row"><button className="small" onClick={onCancel}>Cancel</button><button className="small primary" onClick={onSave}>Save</button></div>
          : <button className="small" onClick={onEdit}>Edit</button>)}
      </div>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v || "—"}</span></div>;
}
function Fld({ l, children }: { l: string; children: React.ReactNode }) {
  return <div className="field" style={{ marginBottom: 0 }}><label>{l}</label>{children}</div>;
}

// Royalty rate = a common fraction from the preset list, or a custom value via
// "Other". Stored as a plain string ("1/8", "3/16", or whatever's typed).
function RoyaltyRateField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const preset = value != null && value !== "" && ROYALTY_RATE_OPTIONS.includes(value);
  const [other, setOther] = useState<boolean>(value != null && value !== "" && !preset);
  const selectValue = other ? "__other__" : preset ? value! : "";
  return (
    <>
      <Select
        value={selectValue} clearable placeholder="—" ariaLabel="Royalty rate"
        options={[...ROYALTY_RATE_OPTIONS.map((o) => ({ value: o, label: o })), { value: "__other__", label: "Other (custom)" }]}
        onChange={(v) => {
          if (v === "__other__") { setOther(true); onChange(value && !preset ? value : ""); }
          else { setOther(false); onChange(v === "" ? null : v); }
        }}
      />
      {other && <input style={{ marginTop: 6 }} value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder="e.g. 1/3, 0.1875" />}
    </>
  );
}

function OwnershipCard({ asset, canEdit, onSaved }: { asset: AssetDetail; canEdit: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(asset);
  useEffect(() => setF(asset), [asset]);
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

  async function save() {
    await api.patch(`/deals/${asset.id}`, {
      ownershipType: f.ownershipType, ownershipStatus: f.ownershipStatus,
      acquisitionDate: f.acquisitionDate || null, rrc: f.rrc || null,
      purchasePrice: f.purchasePrice, currentValue: f.currentValue,
      acreageNma: f.acreageNma, nra: f.nra, netRevenueInterest: f.netRevenueInterest,
    });
    setEdit(false); onSaved();
  }

  return (
    <EditCard title="Ownership" canEdit={canEdit} editing={edit} onEdit={() => setEdit(true)} onCancel={() => { setF(asset); setEdit(false); }} onSave={save}>
      {!edit ? (
        <div className="dd-grid">
          <KV k="Ownership Type" v={asset.ownershipType} />
          <KV k="Ownership Status" v={asset.ownershipStatus} />
          <KV k="Acquisition Date" v={fmtDate(asset.acquisitionDate)} />
          <KV k="Purchase Price" v={money(asset.purchasePrice)} />
          <KV k="Current Value" v={money(asset.currentValue)} />
          <KV k="RRC" v={asset.rrc} />
          <KV k="NMA" v={num(asset.acreageNma)} />
          <KV k="NRA" v={num(asset.nra)} />
          <KV k="Net Revenue Interest" v={asset.netRevenueInterest != null ? `${(asset.netRevenueInterest * 100).toFixed(2)}%` : "—"} />
        </div>
      ) : (
        <div className="dd-grid">
          <Fld l="Ownership Type"><Select value={f.ownershipType ?? ""} onChange={(v) => setF({ ...f, ownershipType: v })} placeholder="—" clearable ariaLabel="Ownership type" options={OWNERSHIP_TYPES.map((t) => ({ value: t, label: t }))} /></Fld>
          <Fld l="Ownership Status"><Select value={f.ownershipStatus ?? ""} onChange={(v) => setF({ ...f, ownershipStatus: v })} placeholder="—" clearable ariaLabel="Ownership status" options={OWNERSHIP_STATUSES.map((t) => ({ value: t, label: t }))} /></Fld>
          <Fld l="Acquisition Date"><input type="date" value={toInputDate(f.acquisitionDate)} onChange={(e) => setF({ ...f, acquisitionDate: e.target.value })} /></Fld>
          <Fld l="Purchase Price"><MoneyInput value={f.purchasePrice != null ? String(f.purchasePrice) : ""} onChange={(v) => setF({ ...f, purchasePrice: v === "" ? null : Number(v) })} ariaLabel="Purchase price" /></Fld>
          <Fld l="Current Value"><input type="number" value={f.currentValue ?? ""} onChange={(e) => setF({ ...f, currentValue: numOrNull(e.target.value) })} /></Fld>
          <Fld l="RRC"><input value={f.rrc ?? ""} onChange={(e) => setF({ ...f, rrc: e.target.value })} placeholder="RRC lease / district / operator no." /></Fld>
          <Fld l="NMA"><input type="number" value={f.acreageNma ?? ""} onChange={(e) => setF({ ...f, acreageNma: numOrNull(e.target.value) })} /></Fld>
          <Fld l="NRA"><input type="number" value={f.nra ?? ""} onChange={(e) => setF({ ...f, nra: numOrNull(e.target.value) })} /></Fld>
          <Fld l="Net Revenue Interest (0–1)"><input type="number" step="0.01" value={f.netRevenueInterest ?? ""} onChange={(e) => setF({ ...f, netRevenueInterest: numOrNull(e.target.value) })} /></Fld>
        </div>
      )}
    </EditCard>
  );
}

function PropertyCard({ asset, canEdit, onSaved }: { asset: AssetDetail; canEdit: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(asset);
  useEffect(() => setF(asset), [asset]);
  // Resolve internal abstract IDs (e.g. TX-289222) to their recognizable
  // Abstract number/survey label — internal IDs are never shown in the UI.
  const abstractLabel = useAbstractLabels(asset.abstractIds);

  async function save() {
    await api.patch(`/deals/${asset.id}`, {
      counties: f.counties, states: f.states ?? [], basins: f.basins, formations: f.formations,
      operator: f.operator, abstractIds: f.abstractIds, surveys: f.surveys, wells: f.wells,
      producingStatus: f.producingStatus, notes: f.notes,
    });
    setEdit(false); onSaved();
  }

  return (
    <EditCard title="Property" canEdit={canEdit} editing={edit} onEdit={() => setEdit(true)} onCancel={() => { setF(asset); setEdit(false); }} onSave={save}>
      {!edit ? (
        <div className="dd-grid">
          <KV k="State" v={(asset.states?.length ? asset.states : (asset.state ? [asset.state] : [])).join(", ")} />
          <KV k="Counties" v={asset.counties.join(", ")} />
          <KV k="Producing Status" v={asset.producingStatus} />
          <KV k="Basins" v={asset.basins.join(", ")} />
          <KV k="Formations" v={asset.formations.join(", ")} />
          <KV k="Operator" v={asset.operator} />
          <KV k="Surveys" v={asset.surveys?.join(", ")} />
          <KV k="Abstracts" v={abstractLabel || null} />
          <KV k="Wells" v={asset.wells?.join(", ")} />
          <div className="kv" style={{ gridColumn: "1 / -1" }}><span className="k">Property Notes</span><span className="v" style={{ whiteSpace: "normal" }}>{asset.notes || "—"}</span></div>
        </div>
      ) : (
        <div className="dd-grid">
          <GeoFields
            states={f.states?.length ? f.states : (f.state ? [f.state] : [])} onStatesChange={(v) => setF({ ...f, states: v })}
            counties={f.counties} onCountiesChange={(v) => setF({ ...f, counties: v })}
            abstractIds={f.abstractIds} onAbstractsChange={(v) => setF({ ...f, abstractIds: v })}
            labels={{ county: "Counties", abstract: "Abstracts" }}
          />
          <Fld l="Producing Status"><Select value={f.producingStatus ?? ""} onChange={(v) => setF({ ...f, producingStatus: v })} placeholder="—" clearable ariaLabel="Producing status" options={PRODUCING_STATUSES.map((t) => ({ value: t, label: t }))} /></Fld>
          <Fld l="Basins"><SearchableMultiSelect options={[...TEXAS_BASIN_OPTIONS]} value={f.basins} onChange={(v) => setF({ ...f, basins: v })} /></Fld>
          <Fld l="Formations"><SearchableMultiSelect options={[...TEXAS_FORMATION_OPTIONS]} value={f.formations} onChange={(v) => setF({ ...f, formations: v })} /></Fld>
          <Fld l="Operator"><input value={f.operator ?? ""} onChange={(e) => setF({ ...f, operator: e.target.value })} /></Fld>
          <Fld l="Surveys"><SurveyMultiPicker value={f.surveys ?? []} onChange={(v) => setF({ ...f, surveys: v })} abstractIds={f.abstractIds} /></Fld>
          <Fld l="Wells"><SearchableMultiSelect options={[]} value={f.wells ?? []} onChange={(v) => setF({ ...f, wells: v })} placeholder="Type a well name/API, Enter" /></Fld>
          <div className="field" style={{ gridColumn: "1 / -1", marginBottom: 0 }}><label>Property Notes</label><textarea rows={3} value={f.notes ?? ""} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        </div>
      )}
    </EditCard>
  );
}

function FinancialsCard({ asset, canEdit, onSaved }: { asset: AssetDetail; canEdit: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(asset);
  const [showAddRev, setShowAddRev] = useState(false);
  useEffect(() => setF(asset), [asset]);

  const chartData = useMemo(
    () => (asset.revenueEntries ?? []).map((r) => ({ month: r.month.slice(0, 7), amount: r.amount, kind: r.kind })),
    [asset.revenueEntries],
  );
  const totalRevenue = useMemo(() => (asset.revenueEntries ?? []).reduce((s, r) => s + r.amount, 0), [asset.revenueEntries]);

  async function saveFinancials() {
    await api.patch(`/deals/${asset.id}`, {
      leaseStatuses: f.leaseStatuses ?? [],
      royaltyRate: f.royaltyRate,
      leaseEffectiveDate: f.leaseEffectiveDate || null,
      leaseExpirationDate: f.leaseExpirationDate || null,
    });
    setEdit(false); onSaved();
  }
  async function delRevenue(entryId: string) {
    await api.del(`/deals/${asset.id}/revenue/${entryId}`);
    onSaved();
  }

  return (
    <div className="panel">
      <div className="section-head">
        <h3 style={{ margin: 0 }}>Financials</h3>
        <div className="row">
          {canEdit && <button className="small" onClick={() => setShowAddRev(true)}>+ Add revenue</button>}
          {canEdit && (edit
            ? <><button className="small" onClick={() => { setF(asset); setEdit(false); }}>Cancel</button><button className="small primary" onClick={saveFinancials}>Save</button></>
            : <button className="small" onClick={() => setEdit(true)}>Edit</button>)}
        </div>
      </div>

      <div className="metrics-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <MetricCard label="Total Revenue Booked" value={money(totalRevenue)} hint={`${asset.revenueEntries?.length ?? 0} entries`} valueColor={totalRevenue ? "var(--green)" : undefined} />
        <MetricCard label="ROI Since Acquisition" value={fmtPct(asset.roiSinceAcquisition)} valueColor={posColor(asset.roiSinceAcquisition)} />
        <MetricCard label="Unrealized Gain / Loss" value={money(asset.unrealizedGainLoss)} valueColor={posColor(asset.unrealizedGainLoss)} />
        <MetricCard label="Lease Status" value={asset.leaseStatuses?.length ? asset.leaseStatuses.join(", ") : "—"} />
      </div>

      <div className="chart-grid">
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="panel-title"><h3>Revenue / Royalty History</h3></div>
          {chartData.length === 0 ? <p className="muted">No revenue entries yet. Add monthly royalty or lease income to build the history.</p> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 11 }} minTickGap={20} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)} width={54} />
                <Tooltip {...chartTooltip} labelFormatter={monthLabel} formatter={(v: number) => money(v)} />
                <Bar dataKey="amount" name="Revenue" isAnimationActive={false}>
                  {chartData.map((d, i) => <Cell key={i} fill={d.kind === "LEASE_BONUS" ? "#f59e0b" : REV_COLOR} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="panel-title"><h3>Current Lease</h3></div>
          {!edit ? (
            <div className="dd-grid" style={{ gridTemplateColumns: "1fr" }}>
              <KV k="Lease Status" v={asset.leaseStatuses?.length ? asset.leaseStatuses.join(", ") : null} />
              <KV k="Royalty Rate" v={asset.royaltyRate} />
              <KV k="Lease Effective Date" v={fmtDate(asset.leaseEffectiveDate)} />
              <KV k="Lease Expiration Date" v={fmtDate(asset.leaseExpirationDate)} />
            </div>
          ) : (
            <div className="dd-grid" style={{ gridTemplateColumns: "1fr" }}>
              <Fld l="Lease Status"><SearchableMultiSelect options={LEASE_STATUS_OPTIONS} value={f.leaseStatuses ?? []} onChange={(v) => setF({ ...f, leaseStatuses: v })} placeholder="Select lease status…" /></Fld>
              <Fld l="Royalty Rate"><RoyaltyRateField value={f.royaltyRate} onChange={(v) => setF({ ...f, royaltyRate: v })} /></Fld>
              <Fld l="Lease Effective Date"><input type="date" value={toInputDate(f.leaseEffectiveDate)} onChange={(e) => setF({ ...f, leaseEffectiveDate: e.target.value })} /></Fld>
              <Fld l="Lease Expiration Date"><input type="date" value={toInputDate(f.leaseExpirationDate)} onChange={(e) => setF({ ...f, leaseExpirationDate: e.target.value })} /></Fld>
            </div>
          )}
        </div>
      </div>

      {(asset.revenueEntries?.length ?? 0) > 0 && (
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="data-table">
            <thead><tr><th>Month</th><th>Type</th><th>Operator</th><th className="right">Amount</th><th>Note</th>{canEdit && <th></th>}</tr></thead>
            <tbody>
              {[...asset.revenueEntries].reverse().map((r) => (
                <tr key={r.id}>
                  <td>{r.month.slice(0, 7)}</td>
                  <td>{r.kind.replace("_", " ")}</td>
                  <td>{r.operator || "—"}</td>
                  <td className="right">{money(r.amount)}</td>
                  <td>{r.note || "—"}</td>
                  {canEdit && <td className="right"><button className="link-btn" style={{ color: "var(--red)" }} onClick={() => delRevenue(r.id)}>Delete</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAddRev && <AddRevenueModal assetId={asset.id} onClose={() => setShowAddRev(false)} onSaved={() => { setShowAddRev(false); onSaved(); }} />}
    </div>
  );
}

const MONTHS = [
  ["01", "January"], ["02", "February"], ["03", "March"], ["04", "April"], ["05", "May"], ["06", "June"],
  ["07", "July"], ["08", "August"], ["09", "September"], ["10", "October"], ["11", "November"], ["12", "December"],
] as const;

function AddRevenueModal({ assetId, onClose, onSaved }: { assetId: string; onClose: () => void; onSaved: () => void }) {
  const now = new Date();
  const curYear = now.getUTCFullYear();
  // Named month + a dedicated searchable year (default current), stored as YYYY-MM.
  const [monthNum, setMonthNum] = useState(String(now.getUTCMonth() + 1).padStart(2, "0"));
  const [year, setYear] = useState(String(curYear));
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("ROYALTY");
  const [operator, setOperator] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // All applicable years up to and including the current year (most recent first).
  const years = Array.from({ length: 26 }, (_, i) => String(curYear - i));

  async function save() {
    const y = Number(year);
    if (!Number.isInteger(y) || y < 1900 || y > curYear) { setError(`Enter a valid year (up to ${curYear}).`); return; }
    if (amount.trim() === "") { setError("Enter an amount."); return; }
    const month = `${year}-${monthNum}`;
    setBusy(true); setError(null);
    try {
      await api.post(`/deals/${assetId}/revenue`, { month, amount: Number(amount), kind, operator: operator.trim() || null, note: note.trim() || null });
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Add Revenue Entry" onClose={onClose} footer={<><button className="small" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Add"}</button></>}>
      <div className="grid-2">
        <div className="field"><label>Month</label>
          <Select value={monthNum} onChange={setMonthNum} ariaLabel="Month"
            options={MONTHS.map(([v, l]) => ({ value: v, label: l }))} />
        </div>
        <div className="field"><label>Year</label>
          {/* Searchable: typing filters the year list; free entry validated on save. */}
          <input list="rev-year-options" value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" placeholder="Search year…" />
          <datalist id="rev-year-options">{years.map((y) => <option key={y} value={y} />)}</datalist>
        </div>
        <div className="field"><label>Amount</label><MoneyInput value={amount} onChange={setAmount} ariaLabel="Offer amount" /></div>
        <div className="field"><label>Type</label><Select value={kind} onChange={setKind} ariaLabel="Revenue type" options={[{ value: "ROYALTY", label: "Royalty" }, { value: "LEASE_BONUS", label: "Lease Bonus" }, { value: "OTHER", label: "Other" }]} /></div>
        <div className="field"><label>Operator</label><input value={operator} onChange={(e) => setOperator(e.target.value)} /></div>
        <div className="field" style={{ gridColumn: "1 / -1" }}><label>Note</label><input value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sell tab — reuses the deal marketing machinery (matches, activity, offers, email)
// ---------------------------------------------------------------------------

function SellTab({ asset, matches, users, canEdit, onChanged, onSetSell }: {
  asset: AssetDetail; matches: MatchRec[] | null; users: UserLite[]; canEdit: boolean; onChanged: () => void; onSetSell: () => void;
}) {
  const [logBuyer, setLogBuyer] = useState<{ id: string; name: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showEmail, setShowEmail] = useState(false);
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(asset);
  const [acceptOffer, setAcceptOffer] = useState<{ id: string; buyer: string; amount: number } | null>(null);
  const [acceptBusy, setAcceptBusy] = useState(false);
  useEffect(() => setF(asset), [asset]);

  async function savePricing() {
    await api.patch(`/deals/${asset.id}`, { askPrice: f.askPrice, currentValue: f.currentValue, estimatedClosingCosts: f.estimatedClosingCosts });
    setEdit(false); onChanged();
  }
  async function markContacted() {
    if (selected.size === 0) return;
    await api.post(`/deals/${asset.id}/contact-bulk`, { buyerIds: [...selected] });
    setSelected(new Set()); onChanged();
  }

  return (
    <div>
      {asset.assetMode !== "SELL" && (
        <Banner kind="info">
          This asset isn't actively marketed yet. <button className="link-btn" onClick={onSetSell}>Mark it for sale</button> to add it to the Pipeline alongside acquisition opportunities.
        </Banner>
      )}

      <div className="panel">
        <div className="section-head">
          <h3 style={{ margin: 0 }}>Pricing &amp; Marketing</h3>
          {canEdit && (edit
            ? <div className="row"><button className="small" onClick={() => { setF(asset); setEdit(false); }}>Cancel</button><button className="small primary" onClick={savePricing}>Save</button></div>
            : <button className="small" onClick={() => setEdit(true)}>Edit</button>)}
        </div>
        {!edit ? (
          <div className="dd-grid">
            <KV k="Current Value" v={money(asset.currentValue)} />
            <KV k="Asking Price" v={money(asset.askPrice)} />
            <KV k="Est. Closing Costs" v={money(asset.estimatedClosingCosts)} />
            <KV k="Marketing Status" v={asset.assetMode === "SELL" ? "Active" : "Not marketed"} />
          </div>
        ) : (
          <div className="dd-grid">
            <Fld l="Current Value"><input type="number" value={f.currentValue ?? ""} onChange={(e) => setF({ ...f, currentValue: e.target.value === "" ? null : Number(e.target.value) })} /></Fld>
            <Fld l="Asking Price"><MoneyInput value={f.askPrice != null ? String(f.askPrice) : ""} onChange={(v) => setF({ ...f, askPrice: v === "" ? null : Number(v) })} ariaLabel="Asking price" /></Fld>
            <Fld l="Est. Closing Costs"><input type="number" value={f.estimatedClosingCosts ?? ""} onChange={(e) => setF({ ...f, estimatedClosingCosts: e.target.value === "" ? null : Number(e.target.value) })} /></Fld>
          </div>
        )}
      </div>

      <div className="metrics-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <MetricCard label="Buyers Contacted" value={asset.metrics.buyersContacted} />
        <MetricCard label="Interested" value={asset.metrics.interested} />
        <MetricCard label="Offers" value={asset.metrics.offers} />
        <MetricCard label="High Offer" value={money(asset.metrics.highOffer)} />
      </div>

      {asset.offers.length > 0 && (
        <div className="panel">
          <h3>Offers</h3>
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Buyer</th><th className="right">Amount</th><th>Status</th><th>Expires</th><th></th></tr></thead>
            <tbody>{asset.offers.map((o) => (
              <tr key={o.id}>
                <td>{o.buyer.name}</td><td className="right">{money(o.amount)}</td><td>{o.status}</td><td>{fmtDate(o.expirationDate)}</td>
                <td className="right">
                  {asset.selectedOfferId === o.id ? <span className="badge resp-offer">Accepted</span> :
                    canEdit && <button className="small" onClick={() => setAcceptOffer({ id: o.id, buyer: o.buyer.name, amount: o.amount })}>Accept</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      {/* Offering page publishing — identical to a standard deal. */}
      <DealPortalPanel dealId={asset.id} />

      <CollapsibleSection
        title="Buyer Activity"
        sub="Status, notes and communication history for this asset's marketing"
        right={<span className="muted" style={{ fontSize: 12.5 }}>{asset.buyerActivity.length} buyer{asset.buyerActivity.length === 1 ? "" : "s"}</span>}
      >
        <BuyerActivitySection
          dealId={asset.id}
          rows={asset.buyerActivity}
          onChanged={onChanged}
          onEdit={(r) => setLogBuyer({ id: r.buyerId, name: r.buyerName })}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Buyer Match Recommendations"
        sub="Ranked by fit with this asset"
        right={matches ? <span className="muted" style={{ fontSize: 12.5 }}>{matches.length} buyer{matches.length === 1 ? "" : "s"}</span> : undefined}
      >
        {!matches ? <Spinner /> : matches.length === 0 ? <p className="muted">No buyers in the system yet.</p> : (
          <>
            {canEdit && (
              <div className="row" style={{ marginBottom: 10 }}>
                <span className="muted" style={{ fontSize: 13 }}>{selected.size} selected</span>
                <button className="small primary" disabled={selected.size === 0} onClick={() => setShowEmail(true)}>Send via Email</button>
                <button className="small" disabled={selected.size === 0} onClick={markContacted}>Mark Contacted</button>
              </div>
            )}
            {matches.slice(0, 25).map((m) => (
              <div className={`match-card ${selected.has(m.buyerId) ? "match-selected" : ""}`} key={m.buyerId}>
                <div className="match-card-head">
                  {canEdit && <input type="checkbox" checked={selected.has(m.buyerId)} onChange={() => setSelected((p) => { const n = new Set(p); n.has(m.buyerId) ? n.delete(m.buyerId) : n.add(m.buyerId); return n; })} />}
                  <span className="match-rank">#{m.rank}</span>
                  <Link to={`/buyers/${m.buyerId}`} className="match-name">{m.companyName || m.buyerName}</Link>
                  <span className="match-right">
                    <span className="match-pct-num" style={{ color: matchColor(m.matchPercent) }}>{m.matchPercent}%</span>
                    <span className="muted" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                      {m.criteriaSpecified > 0 ? `${m.criteriaSpecifiedMatched}/${m.criteriaSpecified} criteria` : "no buy box set"}
                    </span>
                  </span>
                </div>
                <MatchBar value={m.matchPercent} />
                <div>
                  {m.matching.map((c) => <span key={c.key} className="crit-tag crit-yes">{c.label}</span>)}
                  {m.nonMatching.map((c) => <span key={c.key} className="crit-tag crit-no">{c.label}</span>)}
                </div>
              </div>
            ))}
          </>
        )}
      </CollapsibleSection>

      {/* Location map + documents — identical to a standard deal. */}
      <div className="panel">
        <div className="section-head"><h3>Location</h3><span className="muted">This asset's abstracts and geographic extent</span></div>
        {asset.abstractIds.length === 0
          ? <p className="muted" style={{ marginBottom: 0 }}>No abstracts linked yet — add them to see the property on the map.</p>
          : <Suspense fallback={<Spinner label="Loading map…" />}><DealMap abstractIds={asset.abstractIds} /></Suspense>}
      </div>

      {/* Legal tract descriptions — identical to the Deal page and the Hold tab. */}
      <Suspense fallback={<div className="panel"><Spinner label="Loading tract descriptions…" /></div>}>
        <TractSection dealId={asset.id} dealName={asset.name} canEdit={canEdit} abstractIds={asset.abstractIds} />
      </Suspense>

      <DocumentsSection ownerType="deal" ownerId={asset.id} files={asset.files} folders={ASSET_DOC_FOLDERS} onChanged={onChanged} canEdit={canEdit} canDelete={canEdit} />

      {logBuyer && <LogContactModal dealId={asset.id} buyerId={logBuyer.id} buyerName={logBuyer.name} users={users} onClose={() => setLogBuyer(null)} onLogged={() => { setLogBuyer(null); onChanged(); }} />}
      {showEmail && <SendDealEmailModal dealId={asset.id} dealName={asset.name} buyerIds={[...selected]} onClose={() => setShowEmail(false)} onSent={() => { setSelected(new Set()); setShowEmail(false); onChanged(); }} />}
      {acceptOffer && (
        <ConfirmDialog
          title="Accept this offer?"
          confirmLabel={acceptBusy ? "Accepting…" : "Accept"}
          busy={acceptBusy}
          onCancel={() => setAcceptOffer(null)}
          onConfirm={async () => {
            setAcceptBusy(true);
            try { await api.post(`/deals/${asset.id}/accept-offer`, { offerId: acceptOffer.id }); setAcceptOffer(null); onChanged(); }
            finally { setAcceptBusy(false); }
          }}
          message={
            <>
              <p style={{ marginTop: 0 }}>Accepting <strong>{acceptOffer.buyer}</strong>'s offer of <strong>{money(acceptOffer.amount)}</strong> will:</p>
              <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
                <li>Mark this buyer's offer as <strong>accepted</strong>.</li>
                <li>Move the asset sale into the <strong>Closing</strong> process.</li>
                {asset.publishedToPortal
                  ? <li>Remove the offering from the <strong>public Buyer Portal</strong>.</li>
                  : <li>Keep the offering off the public portal.</li>}
              </ul>
              <p className="muted" style={{ marginBottom: 0 }}>All buyer activity and communications are preserved for auditing.</p>
            </>
          }
        />
      )}
    </div>
  );
}
