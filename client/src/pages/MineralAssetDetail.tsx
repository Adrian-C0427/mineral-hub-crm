import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, MetricCard, Banner, MatchPercentBadge, MatchBar, Modal, ConfirmDialog } from "../components/ui";
import { BuyerActivitySection } from "../components/BuyerActivitySection";
import { LogContactModal } from "../components/LogContactModal";
import { SendDealEmailModal } from "../components/SendDealEmailModal";
import { DealPortalPanel } from "../components/DealPortalPanel";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { AbstractMultiPicker } from "../components/AbstractPicker";
import { US_STATE_OPTIONS, TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, countiesForStates } from "../lib/options";
import { monthLabel, chartTooltip } from "../lib/charts";
import { money, num, fmtDate, toInputDate } from "../lib/format";
import { OWNERSHIP_TYPES, OWNERSHIP_STATUSES, PRODUCING_STATUSES } from "./MineralAssets";
import type { BuyerActivityRow, DealSummary, MatchRec, RevenueEntry, Seller, UserLite } from "../types";
const DealMap = lazy(() => import("../components/DealMap").then((m) => ({ default: m.DealMap })));

interface AssetDetail extends DealSummary {
  operator: string | null;
  notes: string | null;
  buyerActivity: BuyerActivityRow[];
  offers: { id: string; buyer: { id: string; name: string }; amount: number; status: string; conditions: string | null; expirationDate: string | null; dateSubmitted: string }[];
  files: { id: string; category: string; folder: string; filename: string; sizeBytes: number; createdAt: string }[];
  sellers: Seller[];
  revenueEntries: RevenueEntry[];
  canViewTaxId: boolean;
  metrics: { buyersContacted: number; interested: number; offers: number; highOffer: number | null };
}

const fmtPct = (v: number | null): string => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const REV_COLOR = "#22c55e";

export function MineralAssetDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const nav = useNavigate();
  const [asset, setAsset] = useState<AssetDetail | null>(null);
  const [matches, setMatches] = useState<MatchRec[] | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [tab, setTab] = useState<"hold" | "sell">("hold");
  // Reverting to an opportunity is a workflow reversal — always confirmed.
  const [confirmingRevert, setConfirmingRevert] = useState(false);
  const [reverting, setReverting] = useState(false);

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
  async function revertToOpportunity() {
    setReverting(true);
    try {
      await api.post(`/deals/${id}/convert`, { recordType: "OPPORTUNITY" });
      nav("/deals");
    } finally {
      setReverting(false);
    }
  }

  return (
    <div className="page">
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
          {/* Deliberately small/muted: reversing the asset workflow is rare and
              shouldn't visually compete with Mark for Sale. */}
          {canEdit && <button className="small" style={{ color: "var(--text-dim)" }} onClick={() => setConfirmingRevert(true)}>Revert to Opportunity…</button>}
        </div>
      </div>

      {confirmingRevert && (
        <ConfirmDialog
          title="Revert to acquisition opportunity?"
          message={
            <>
              <p style={{ marginTop: 0 }}><strong>{asset.name}</strong> will move out of Mineral Assets and back into the Deals pipeline as an acquisition opportunity.</p>
              <p style={{ marginBottom: 0 }}>
                Nothing is deleted: purchase price, revenue entries, and valuation history stay on the record (hidden while it's an opportunity) and return if you convert it back to an owned asset.
              </p>
            </>
          }
          confirmLabel="Revert to Opportunity"
          busy={reverting}
          onCancel={() => setConfirmingRevert(false)}
          onConfirm={revertToOpportunity}
        />
      )}

      <div className="metrics-row">
        <MetricCard label="Current Value" value={money(asset.currentValue)} hint={asset.bookValue != null ? `Book ${money(asset.bookValue)}` : undefined} />
        <MetricCard label="Purchase Price" value={money(asset.purchasePrice)} hint={asset.acquisitionDate ? `Acquired ${fmtDate(asset.acquisitionDate)}` : undefined} />
        <MetricCard label="ROI Since Acquisition" value={fmtPct(asset.roiSinceAcquisition)} />
        <MetricCard label="Unrealized Gain / Loss" value={money(asset.unrealizedGainLoss)} />
        <MetricCard label="Annual Royalty Income" value={money(asset.royaltyIncomeAnnual)} />
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

      <DocumentsPanel assetId={asset.id} files={asset.files} canDelete={canEdit} onChanged={onChanged} />
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

function OwnershipCard({ asset, canEdit, onSaved }: { asset: AssetDetail; canEdit: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(asset);
  useEffect(() => setF(asset), [asset]);
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

  async function save() {
    await api.patch(`/deals/${asset.id}`, {
      ownershipType: f.ownershipType, ownershipStatus: f.ownershipStatus,
      acquisitionDate: f.acquisitionDate || null,
      purchasePrice: f.purchasePrice, currentValue: f.currentValue, bookValue: f.bookValue,
      acreageNma: f.acreageNma, nra: f.nra, workingInterest: f.workingInterest, netRevenueInterest: f.netRevenueInterest,
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
          <KV k="Book Value" v={money(asset.bookValue)} />
          <KV k="NMA" v={num(asset.acreageNma)} />
          <KV k="NRA" v={num(asset.nra)} />
          <KV k="Working Interest" v={asset.workingInterest != null ? `${(asset.workingInterest * 100).toFixed(2)}%` : "—"} />
          <KV k="Net Revenue Interest" v={asset.netRevenueInterest != null ? `${(asset.netRevenueInterest * 100).toFixed(2)}%` : "—"} />
        </div>
      ) : (
        <div className="dd-grid">
          <Fld l="Ownership Type"><select value={f.ownershipType ?? ""} onChange={(e) => setF({ ...f, ownershipType: e.target.value })}><option value="">—</option>{OWNERSHIP_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Fld>
          <Fld l="Ownership Status"><select value={f.ownershipStatus ?? ""} onChange={(e) => setF({ ...f, ownershipStatus: e.target.value })}><option value="">—</option>{OWNERSHIP_STATUSES.map((t) => <option key={t}>{t}</option>)}</select></Fld>
          <Fld l="Acquisition Date"><input type="date" value={toInputDate(f.acquisitionDate)} onChange={(e) => setF({ ...f, acquisitionDate: e.target.value })} /></Fld>
          <Fld l="Purchase Price"><input type="number" value={f.purchasePrice ?? ""} onChange={(e) => setF({ ...f, purchasePrice: numOrNull(e.target.value) })} /></Fld>
          <Fld l="Current Value"><input type="number" value={f.currentValue ?? ""} onChange={(e) => setF({ ...f, currentValue: numOrNull(e.target.value) })} /></Fld>
          <Fld l="Book Value"><input type="number" value={f.bookValue ?? ""} onChange={(e) => setF({ ...f, bookValue: numOrNull(e.target.value) })} /></Fld>
          <Fld l="NMA"><input type="number" value={f.acreageNma ?? ""} onChange={(e) => setF({ ...f, acreageNma: numOrNull(e.target.value) })} /></Fld>
          <Fld l="NRA"><input type="number" value={f.nra ?? ""} onChange={(e) => setF({ ...f, nra: numOrNull(e.target.value) })} /></Fld>
          <Fld l="Working Interest (0–1)"><input type="number" step="0.01" value={f.workingInterest ?? ""} onChange={(e) => setF({ ...f, workingInterest: numOrNull(e.target.value) })} /></Fld>
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
          <KV k="Abstracts" v={asset.abstractIds.join(", ")} />
          <KV k="Wells" v={asset.wells?.join(", ")} />
          <div className="kv" style={{ gridColumn: "1 / -1" }}><span className="k">Property Notes</span><span className="v" style={{ whiteSpace: "normal" }}>{asset.notes || "—"}</span></div>
        </div>
      ) : (
        <div className="dd-grid">
          <Fld l="State"><SearchableMultiSelect options={US_STATE_OPTIONS} value={f.states?.length ? f.states : (f.state ? [f.state] : [])} onChange={(v) => setF({ ...f, states: v })} placeholder="Select states…" /></Fld>
          <Fld l="Counties"><SearchableMultiSelect options={countiesForStates(f.states?.length ? f.states : (f.state ? [f.state] : []))} value={f.counties} onChange={(v) => setF({ ...f, counties: v })} placeholder="Search counties…" /></Fld>
          <Fld l="Producing Status"><select value={f.producingStatus ?? ""} onChange={(e) => setF({ ...f, producingStatus: e.target.value })}><option value="">—</option>{PRODUCING_STATUSES.map((t) => <option key={t}>{t}</option>)}</select></Fld>
          <Fld l="Basins"><SearchableMultiSelect options={TEXAS_BASIN_OPTIONS} value={f.basins} onChange={(v) => setF({ ...f, basins: v })} /></Fld>
          <Fld l="Formations"><SearchableMultiSelect options={TEXAS_FORMATION_OPTIONS} value={f.formations} onChange={(v) => setF({ ...f, formations: v })} /></Fld>
          <Fld l="Operator"><input value={f.operator ?? ""} onChange={(e) => setF({ ...f, operator: e.target.value })} /></Fld>
          <Fld l="Surveys"><SearchableMultiSelect options={[]} value={f.surveys ?? []} onChange={(v) => setF({ ...f, surveys: v })} placeholder="Type a survey, Enter" /></Fld>
          <Fld l="Abstracts"><AbstractMultiPicker value={f.abstractIds} counties={f.counties} onChange={(v) => setF({ ...f, abstractIds: v })} /></Fld>
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
      royaltyIncomeAnnual: f.royaltyIncomeAnnual, leaseStatus: f.leaseStatus, leaseInfo: f.leaseInfo,
      divisionOrdersNote: f.divisionOrdersNote, taxInfo: f.taxInfo,
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
        <MetricCard label="Total Revenue Booked" value={money(totalRevenue)} hint={`${asset.revenueEntries?.length ?? 0} entries`} />
        <MetricCard label="ROI Since Acquisition" value={fmtPct(asset.roiSinceAcquisition)} />
        <MetricCard label="Unrealized Gain / Loss" value={money(asset.unrealizedGainLoss)} />
        <MetricCard label="Lease Status" value={asset.leaseStatus || "—"} />
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
          <div className="panel-title"><h3>Lease, Division Orders &amp; Tax</h3></div>
          {!edit ? (
            <div className="dd-grid" style={{ gridTemplateColumns: "1fr" }}>
              <KV k="Estimated Annual Royalty" v={money(asset.royaltyIncomeAnnual)} />
              <KV k="Lease Status" v={asset.leaseStatus} />
              <KV k="Lease Information" v={asset.leaseInfo} />
              <KV k="Division Orders" v={asset.divisionOrdersNote} />
              <KV k="Tax Information" v={asset.taxInfo} />
            </div>
          ) : (
            <div className="dd-grid" style={{ gridTemplateColumns: "1fr" }}>
              <Fld l="Estimated Annual Royalty"><input type="number" value={f.royaltyIncomeAnnual ?? ""} onChange={(e) => setF({ ...f, royaltyIncomeAnnual: e.target.value === "" ? null : Number(e.target.value) })} /></Fld>
              <Fld l="Lease Status"><input value={f.leaseStatus ?? ""} onChange={(e) => setF({ ...f, leaseStatus: e.target.value })} /></Fld>
              <Fld l="Lease Information"><textarea rows={2} value={f.leaseInfo ?? ""} onChange={(e) => setF({ ...f, leaseInfo: e.target.value })} /></Fld>
              <Fld l="Division Orders"><textarea rows={2} value={f.divisionOrdersNote ?? ""} onChange={(e) => setF({ ...f, divisionOrdersNote: e.target.value })} /></Fld>
              <Fld l="Tax Information"><textarea rows={2} value={f.taxInfo ?? ""} onChange={(e) => setF({ ...f, taxInfo: e.target.value })} /></Fld>
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

function AddRevenueModal({ assetId, onClose, onSaved }: { assetId: string; onClose: () => void; onSaved: () => void }) {
  const [month, setMonth] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("ROYALTY");
  const [operator, setOperator] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!/^\d{4}-\d{2}$/.test(month)) { setError("Pick a month."); return; }
    if (amount.trim() === "") { setError("Enter an amount."); return; }
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
        <div className="field"><label>Month</label><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></div>
        <div className="field"><label>Amount</label><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label>Type</label><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="ROYALTY">Royalty</option><option value="LEASE_BONUS">Lease Bonus</option><option value="OTHER">Other</option></select></div>
        <div className="field"><label>Operator</label><input value={operator} onChange={(e) => setOperator(e.target.value)} /></div>
        <div className="field" style={{ gridColumn: "1 / -1" }}><label>Note</label><input value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
    </Modal>
  );
}

function DocumentsPanel({ assetId, files, canDelete, onChanged }: { assetId: string; files: AssetDetail["files"]; canDelete: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const FOLDERS = ["Division Orders", "Deeds", "Leases", "Check Stubs", "Title", "Other"];
  const [folder, setFolder] = useState(FOLDERS[0]);

  async function upload(file: File) {
    setBusy(true); setErr(null);
    try {
      const form = new FormData();
      form.append("file", file); form.append("dealId", assetId); form.append("folder", folder);
      await api.upload("/files", form);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Upload failed"); }
    finally { setBusy(false); }
  }
  async function download(fileId: string) {
    const { url } = await api.get<{ url: string }>(`/files/${fileId}/download`);
    window.open(url, "_blank");
  }

  return (
    <div className="panel">
      <div className="section-head"><h3>Documents</h3></div>
      <div className="row" style={{ marginBottom: 12 }}>
        <select style={{ width: 170 }} value={folder} onChange={(e) => setFolder(e.target.value)}>{FOLDERS.map((c) => <option key={c}>{c}</option>)}</select>
        <label className="chip" style={{ margin: 0 }}>{busy ? "Uploading…" : "Upload file"}<input type="file" style={{ display: "none" }} disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
      </div>
      {err && <div className="error-text">{err}</div>}
      {files.length === 0 ? <p className="muted">No documents yet.</p> : (
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Folder</th><th>Filename</th><th className="right">Size</th><th>Uploaded</th><th></th></tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <td><span className="badge resp-pending">{f.folder}</span></td>
                  <td>{f.filename}</td>
                  <td className="right">{(f.sizeBytes / 1024).toFixed(0)} KB</td>
                  <td>{fmtDate(f.createdAt)}</td>
                  <td className="right">
                    <button className="small" onClick={() => download(f.id)}>Download</button>
                    {canDelete && <button className="small danger" style={{ marginLeft: 6 }} onClick={async () => { await api.del(`/files/${f.id}`); onChanged(); }}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
            <Fld l="Asking Price"><input type="number" value={f.askPrice ?? ""} onChange={(e) => setF({ ...f, askPrice: e.target.value === "" ? null : Number(e.target.value) })} /></Fld>
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

      <div className="panel">
        <div className="section-head"><h3>Buyer Activity</h3><span className="muted">Status, notes and communication history for this asset's marketing</span></div>
        <BuyerActivitySection
          dealId={asset.id}
          rows={asset.buyerActivity}
          onChanged={onChanged}
          onEdit={(r) => setLogBuyer({ id: r.buyerId, name: r.buyerName })}
        />
      </div>

      <div className="panel">
        <div className="section-head"><h3>Buyer Match Recommendations</h3><span className="muted">Ranked by fit with this asset</span></div>
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
                  <MatchPercentBadge value={m.matchPercent} />
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
      </div>

      {/* Location map + documents — identical to a standard deal. */}
      <div className="panel">
        <div className="section-head"><h3>Location</h3><span className="muted">This asset's abstracts and geographic extent</span></div>
        {asset.abstractIds.length === 0
          ? <p className="muted" style={{ marginBottom: 0 }}>No abstracts linked yet — add them to see the property on the map.</p>
          : <Suspense fallback={<Spinner label="Loading map…" />}><DealMap abstractIds={asset.abstractIds} /></Suspense>}
      </div>
      <DocumentsPanel assetId={asset.id} files={asset.files} canDelete={canEdit} onChanged={onChanged} />

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
