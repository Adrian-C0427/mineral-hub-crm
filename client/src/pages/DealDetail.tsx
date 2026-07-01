import { useCallback, useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  Spinner, PriorityBadge, StageBadge, MetricCard, ResponseBadge,
  MatchPercentBadge, MatchBar, Banner,
} from "../components/ui";
import { SortableTable, type Column } from "../components/SortableTable";
import { StageChangeModal } from "../components/StageChangeModal";
import { LogContactModal } from "../components/LogContactModal";
import { AbstractMultiPicker, useAbstractLabels } from "../components/AbstractPicker";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { TEXAS_COUNTY_OPTIONS, TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS } from "../lib/options";
import { money, num, fmtDate, toInputDate } from "../lib/format";
import type { BuyerActivityRow, DealSummary, MatchRec } from "../types";

interface DealDetailData extends DealSummary {
  operator: string | null;
  notes: string | null;
  sellerNames: string[];
  deadReason: string | null;
  buyerActivity: BuyerActivityRow[];
  offers: { id: string; buyer: { id: string; name: string }; amount: number; status: string; conditions: string | null; expirationDate: string | null; dateSubmitted: string }[];
  files: { id: string; category: string; filename: string; sizeBytes: number; createdAt: string }[];
  metrics: { buyersContacted: number; interested: number; offers: number; highOffer: number | null };
}

const FILE_CATEGORIES = ["PSA", "LPOA", "DEED", "PLAT_MAP", "TITLE_DOC", "OTHER"];

const RESPONSE_ORDER: Record<string, number> = {
  OFFER_MADE: 0, INTERESTED: 1, PENDING: 2, NOT_INTERESTED: 3, PASSED: 4,
};

export function DealDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const nav = useNavigate();
  const [deal, setDeal] = useState<DealDetailData | null>(null);
  const [matches, setMatches] = useState<MatchRec[] | null>(null);
  const [showStage, setShowStage] = useState(false);
  const [logBuyer, setLogBuyer] = useState<{ id: string; name: string } | null>(null);

  const loadDeal = useCallback(() => api.get<DealDetailData>(`/deals/${id}`).then(setDeal), [id]);
  const loadMatches = useCallback(() => api.get<MatchRec[]>(`/deals/${id}/matches`).then(setMatches), [id]);

  useEffect(() => { loadDeal(); loadMatches(); }, [loadDeal, loadMatches]);

  if (!deal) return <Spinner />;

  const refreshAll = () => { loadDeal(); loadMatches(); };
  const hasUnresolved = deal.buyerActivity.some((a) => a.responseStatus === "PENDING");

  return (
    <div className="page">
      <div className="page-header">
        <div className="row">
          <h1 style={{ marginBottom: 0 }}>{deal.name}</h1>
          <PriorityBadge priority={deal.priority} />
          <StageBadge stage={deal.stage} />
          <span className="muted">{deal.daysInStage}d in stage</span>
        </div>
        <div className="row">
          {can("deleteDeals") && <button className="danger" onClick={async () => { if (confirm("Hard-delete this deal?")) { await api.del(`/deals/${id}`); nav("/deals"); } }}>Delete</button>}
          <button className="primary" onClick={() => setShowStage(true)}>Move Stage</button>
        </div>
      </div>

      {deal.stage === "DEAD" && deal.deadReason && <Banner kind="error">Dead: {deal.deadReason}</Banner>}

      <div className="grid-2">
        <CharacteristicsCard deal={deal} onSaved={refreshAll} />
        <ContractTimelineCard deal={deal} onSaved={loadDeal} />
      </div>

      <div className="metrics-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <MetricCard label="Buyers Contacted" value={deal.metrics.buyersContacted} />
        <MetricCard label="Interested" value={deal.metrics.interested} />
        <MetricCard label="Offers" value={deal.metrics.offers} />
        <MetricCard label="High Offer" value={money(deal.metrics.highOffer)} />
      </div>

      {deal.selectedBuyer && (
        <div className="panel">
          <div className="row">
            <strong>Selected buyer:</strong> <Link to={`/buyers/${deal.selectedBuyer.id}`}>{deal.selectedBuyer.name}</Link>
            <span className="muted">· {deal.selectedBuyer.companyName}</span>
            <span className="spacer" />
            <strong>Profit est:</strong> <span>{money(deal.profitEst)}</span>
          </div>
        </div>
      )}

      {/* Offers */}
      {deal.offers.length > 0 && (
        <div className="panel">
          <h3>Offers</h3>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Buyer</th><th className="right">Amount</th><th>Status</th><th>Expires</th><th>Conditions</th><th></th></tr></thead>
              <tbody>
                {deal.offers.map((o) => (
                  <tr key={o.id}>
                    <td>{o.buyer.name}</td>
                    <td className="right">{money(o.amount)}</td>
                    <td>{o.status}</td>
                    <td>{fmtDate(o.expirationDate)}</td>
                    <td>{o.conditions ?? "—"}</td>
                    <td className="right">
                      {deal.selectedOfferId === o.id ? <span className="badge resp-offer">Accepted</span> :
                        <button className="small" onClick={async () => { await api.post(`/deals/${id}/accept-offer`, { offerId: o.id }); refreshAll(); }}>Accept</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Buyer Activity table */}
      <div className="panel">
        <div className="section-head"><h3>Buyer Activity</h3><span className="muted">Complete marketing log — every buyer ever contacted</span></div>
        <BuyerActivityTable rows={deal.buyerActivity} onLog={(b) => setLogBuyer(b)} />
      </div>

      {/* Match recommendations */}
      <div className="panel">
        <div className="section-head"><h3>Buyer Match Recommendations</h3><span className="muted">Ranked, every buyer, highest match first</span></div>
        {!matches ? <Spinner /> : matches.length === 0 ? <p className="muted">No buyers in the system yet.</p> :
          matches.map((m) => (
            <div className="match-card" key={m.buyerId}>
              <div className="match-card-head">
                <span className="match-rank">#{m.rank}</span>
                <Link to={`/buyers/${m.buyerId}`} style={{ fontWeight: 600 }}>{m.buyerName}</Link>
                <span className="muted">· {m.companyName}</span>
                <span className="spacer" />
                <MatchPercentBadge value={m.matchPercent} />
              </div>
              <MatchBar value={m.matchPercent} />
              <div>
                {m.matching.map((c) => <span key={c.key} className="crit-tag crit-yes">{c.label}</span>)}
                {m.nonMatching.map((c) => <span key={c.key} className="crit-tag crit-no">{c.label}</span>)}
              </div>
              <div className="dc-meta" style={{ marginTop: 8, justifyContent: "space-between" }}>
                <span>Owner(s): {m.owners.length ? m.owners.join(", ") : "—"} · {m.previousDealsClosed} closed together · Last contact: {fmtDate(m.lastContactDate)}
                  {m.stale && <span className="stale-flag"> · stale</span>}</span>
                <button className="small" onClick={() => setLogBuyer({ id: m.buyerId, name: m.buyerName })}>Log contact</button>
              </div>
            </div>
          ))}
      </div>

      {/* Documents */}
      <DocumentsSection dealId={deal.id} files={deal.files} onChanged={loadDeal} canDelete={can("deleteDeals")} />

      {showStage && (
        <StageChangeModal
          deal={deal}
          hasUnresolvedActivity={hasUnresolved}
          onClose={() => setShowStage(false)}
          onChanged={() => { setShowStage(false); refreshAll(); }}
        />
      )}
      {logBuyer && (
        <LogContactModal
          dealId={deal.id}
          buyerId={logBuyer.id}
          buyerName={logBuyer.name}
          onClose={() => setLogBuyer(null)}
          onLogged={() => { setLogBuyer(null); refreshAll(); }}
        />
      )}
    </div>
  );
}

function BuyerActivityTable({ rows, onLog }: { rows: BuyerActivityRow[]; onLog: (b: { id: string; name: string }) => void }) {
  const columns: Column<BuyerActivityRow>[] = [
    { key: "buyerName", header: "Buyer Name", type: "text", value: (r) => r.buyerName, render: (r) => <strong>{r.buyerName}</strong> },
    { key: "match", header: "Match %", type: "number", align: "right", value: (r) => r.matchPercent, render: (r) => <MatchPercentBadge value={r.matchPercent} /> },
    { key: "dateSent", header: "Date Sent", type: "date", value: (r) => r.dateSent, render: (r) => fmtDate(r.dateSent) },
    { key: "status", header: "Response Status", type: "text", value: (r) => RESPONSE_ORDER[r.responseStatus], render: (r) => <ResponseBadge status={r.responseStatus} /> },
    { key: "offer", header: "Offer Made", type: "number", align: "right", value: (r) => r.offerAmount, render: (r) => money(r.offerAmount) },
    { key: "last", header: "Last Activity", type: "date", value: (r) => r.lastActivityDate, render: (r) => fmtDate(r.lastActivityDate) },
    { key: "notes", header: "Internal Notes", type: "text", value: (r) => r.notes ?? "", render: (r) => <span className="wrap">{r.notes ?? "—"}</span> },
    { key: "actions", header: "", type: "text", value: () => "", render: (r) => <button className="small" onClick={(e) => { e.stopPropagation(); onLog({ id: r.buyerId, name: r.buyerName }); }}>Update</button> },
  ];
  return (
    <SortableTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      // Default grouping: Offer Made → Interested → (Pending) → Not Interested → Passed
      defaultCompare={(a, b) => RESPONSE_ORDER[a.responseStatus] - RESPONSE_ORDER[b.responseStatus]}
      rowClassName={(r) => (r.responseStatus === "PASSED" || r.responseStatus === "NOT_INTERESTED" ? "row-dimmed" : undefined)}
      empty="No buyers contacted yet. Use the match recommendations below to start marketing."
    />
  );
}

function CharacteristicsCard({ deal, onSaved }: { deal: DealDetailData; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(deal);
  const abstractLabel = useAbstractLabels(deal.abstractIds);
  useEffect(() => setF(deal), [deal]);
  const set = (k: keyof DealDetailData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value === "" ? null : e.target.value } as DealDetailData));
  const setNum = (k: keyof DealDetailData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value === "" ? null : Number(e.target.value) } as DealDetailData));
  const setArr = (k: keyof DealDetailData) => (v: string[]) => setF((p) => ({ ...p, [k]: v } as DealDetailData));

  async function save() {
    await api.patch(`/deals/${deal.id}`, {
      state: f.state, counties: f.counties, basins: f.basins, formations: f.formations,
      assetTypes: f.assetTypes, acreageNma: f.acreageNma, nra: f.nra, abstractIds: f.abstractIds, askPrice: f.askPrice, operator: f.operator,
    });
    setEdit(false);
    onSaved(); // editing characteristics auto-refreshes matches
  }

  return (
    <div className="panel">
      <div className="section-head">
        <h3>Deal characteristics</h3>
        {edit ? <div className="row"><button className="small" onClick={() => { setF(deal); setEdit(false); }}>Cancel</button><button className="small primary" onClick={save}>Save</button></div>
          : <button className="small" onClick={() => setEdit(true)}>Edit</button>}
      </div>
      {!edit ? (
        <div className="dd-grid">
          <KV k="State" v={deal.state} /><KV k="County" v={deal.counties.join(", ")} /><KV k="Basin" v={deal.basins.join(", ")} />
          <KV k="Formation" v={deal.formations.join(", ")} /><KV k="Asset Type" v={deal.assetTypes.join(", ")} /><KV k="NMA" v={num(deal.acreageNma)} />
          <KV k="NRA" v={num(deal.nra)} /><KV k="Ask Price" v={money(deal.askPrice)} /><KV k="Operator" v={deal.operator} />
          <KV k="Abstract (Leon Co.)" v={abstractLabel} />
        </div>
      ) : (
        <div className="dd-grid">
          <Fld l="State"><input value={f.state ?? ""} onChange={set("state")} /></Fld>
          <Fld l="County"><SearchableMultiSelect options={TEXAS_COUNTY_OPTIONS} value={f.counties} onChange={setArr("counties")} placeholder="Search counties…" /></Fld>
          <Fld l="Basin"><SearchableMultiSelect options={TEXAS_BASIN_OPTIONS} value={f.basins} onChange={setArr("basins")} placeholder="Search basins…" /></Fld>
          <Fld l="Formation"><SearchableMultiSelect options={TEXAS_FORMATION_OPTIONS} value={f.formations} onChange={setArr("formations")} placeholder="Search formations…" /></Fld>
          <Fld l="Asset Type"><SearchableMultiSelect options={ASSET_TYPE_OPTIONS} value={f.assetTypes} onChange={setArr("assetTypes")} placeholder="Search asset types…" /></Fld>
          <Fld l="NMA"><input type="number" value={f.acreageNma ?? ""} onChange={setNum("acreageNma")} /></Fld>
          <Fld l="NRA"><input type="number" value={f.nra ?? ""} onChange={setNum("nra")} /></Fld>
          <Fld l="Ask Price"><input type="number" value={f.askPrice ?? ""} onChange={setNum("askPrice")} /></Fld>
          <Fld l="Operator"><input value={f.operator ?? ""} onChange={set("operator")} /></Fld>
          <Fld l="Abstract"><AbstractMultiPicker value={f.abstractIds} counties={f.counties} onChange={setArr("abstractIds")} /></Fld>
        </div>
      )}
    </div>
  );
}

function ContractTimelineCard({ deal, onSaved }: { deal: DealDetailData; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [fbb, setFbb] = useState("");
  const [oc, setOc] = useState("");
  const [fc, setFc] = useState("");

  function startEdit() {
    setFbb(toInputDate(deal.findBuyerByDate));
    setOc(toInputDate(deal.originalClosingDate));
    setFc(toInputDate(deal.finalClosingDate));
    setEdit(true);
  }

  async function save() {
    const patch: Record<string, unknown> = {};
    // Only send changed fields. FBB/FC become overrides; OC is direct.
    if (fbb !== toInputDate(deal.findBuyerByDate)) patch.findBuyerByDateOverride = fbb || null;
    if (oc !== toInputDate(deal.originalClosingDate)) patch.originalClosingDate = oc || null;
    if (fc !== toInputDate(deal.finalClosingDate)) patch.finalClosingDateOverride = fc || null;
    await api.patch(`/deals/${deal.id}`, patch);
    setEdit(false);
    onSaved();
  }

  async function revert(field: "fbb" | "fc") {
    await api.patch(`/deals/${deal.id}`, field === "fbb" ? { findBuyerByDateOverride: null } : { finalClosingDateOverride: null });
    onSaved();
  }

  // Progress across the timeline (Under Contract → Final Closing).
  const start = deal.dateUnderContract ? new Date(deal.dateUnderContract).getTime() : null;
  const end = deal.finalClosingDate ? new Date(deal.finalClosingDate).getTime() : null;
  const pctDone = start && end && end > start ? Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100)) : 0;

  return (
    <div className="panel">
      <div className="section-head">
        <h3>Contract timeline</h3>
        {edit ? <div className="row"><button className="small" onClick={() => setEdit(false)}>Cancel</button><button className="small primary" onClick={save}>Save</button></div>
          : <button className="small" onClick={startEdit}>Edit dates</button>}
      </div>
      <div className="progress"><div className="progress-fill" style={{ width: `${pctDone}%` }} /></div>
      {!edit ? (
        <div className="dd-grid">
          <KV k="Under Contract" v={fmtDate(deal.dateUnderContract)} />
          <div className="kv">
            <span className="k">Find Buyer By {deal.findBuyerByIsOverridden && <em>(overridden)</em>}</span>
            <span className="v">{fmtDate(deal.findBuyerByDate)} {deal.findBuyerByIsOverridden && <button className="small" onClick={() => revert("fbb")}>Revert to auto</button>}</span>
          </div>
          <KV k="Orig. Closing" v={fmtDate(deal.originalClosingDate)} />
          <div className="kv">
            <span className="k">Final Closing {deal.finalClosingIsOverridden && <em>(overridden)</em>}</span>
            <span className="v">{fmtDate(deal.finalClosingDate)} {deal.finalClosingIsOverridden && <button className="small" onClick={() => revert("fc")}>Revert to auto</button>}</span>
          </div>
        </div>
      ) : (
        <div className="dd-grid">
          <KV k="Under Contract (read-only)" v={fmtDate(deal.dateUnderContract)} />
          <Fld l="Find Buyer By"><input type="date" value={fbb} onChange={(e) => setFbb(e.target.value)} /></Fld>
          <Fld l="Orig. Closing"><input type="date" value={oc} onChange={(e) => setOc(e.target.value)} /></Fld>
          <Fld l="Final Closing"><input type="date" value={fc} onChange={(e) => setFc(e.target.value)} /></Fld>
        </div>
      )}
    </div>
  );
}

function DocumentsSection({ dealId, files, onChanged, canDelete }: { dealId: string; files: DealDetailData["files"]; onChanged: () => void; canDelete: boolean }) {
  const [category, setCategory] = useState("PSA");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true); setErr(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("dealId", dealId);
      form.append("category", category);
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
        <select style={{ width: 160 }} value={category} onChange={(e) => setCategory(e.target.value)}>
          {FILE_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
        </select>
        <label className="chip" style={{ margin: 0 }}>
          {busy ? "Uploading…" : "Upload file"}
          <input type="file" style={{ display: "none" }} disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </div>
      {err && <div className="error-text">{err}</div>}
      {files.length === 0 ? <p className="muted">No documents yet.</p> : (
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Category</th><th>Filename</th><th className="right">Size</th><th>Uploaded</th><th></th></tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <td><span className="badge stage-under_contract">{f.category.replace("_", " ")}</span></td>
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

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v || "—"}</span></div>;
}
function Fld({ l, children }: { l: string; children: React.ReactNode }) {
  return <div className="field"><label>{l}</label>{children}</div>;
}
