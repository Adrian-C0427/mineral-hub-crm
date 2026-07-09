import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  Spinner, PriorityBadge, StageBadge, MetricCard,
  MatchBar, Banner, ConfirmDelete, ConfirmDialog, BackLink,
} from "../components/ui";
import { SortableTable, type Column } from "../components/SortableTable";
import { StageChangeModal } from "../components/StageChangeModal";
import { LogContactModal } from "../components/LogContactModal";
import { BuyerActivitySection } from "../components/BuyerActivitySection";
import { SendDealEmailModal } from "../components/SendDealEmailModal";
import { useAbstractLabels } from "../components/AbstractPicker";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { GeoFields } from "../components/GeoFields";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS, basinsForCounties, formationsForCounties, suggestFirst } from "../lib/options";
import { operatorsForCounties } from "../lib/operators";
import { money, num, fmtDate, toInputDate } from "../lib/format";
import { downloadCsv } from "../lib/csv";
import { SellerDetails } from "../components/SellerDetails";
import { DealPortalPanel } from "../components/DealPortalPanel";
import { AssigneePicker } from "../components/AssigneePicker";
import { DocumentsSection, DEAL_DOC_FOLDERS, type DocFile } from "../components/DocumentsSection";
import type { AssetChild, BuyerActivityRow, DealSummary, MatchRec, Seller, UserLite } from "../types";
import { NewDealModal } from "../components/NewDealModal";
// MapLibre is heavy; only load it when a deal detail page is viewed.
const DealMap = lazy(() => import("../components/DealMap").then((m) => ({ default: m.DealMap })));
const TractSection = lazy(() => import("../components/TractSection").then((m) => ({ default: m.TractSection })));

interface DealDetailData extends DealSummary {
  operator: string | null;
  rrc: string | null;
  notes: string | null;
  sellerNames: string[];
  deadReason: string | null;
  buyerActivity: BuyerActivityRow[];
  offers: { id: string; buyer: { id: string; name: string }; amount: number; status: string; conditions: string | null; expirationDate: string | null; dateSubmitted: string }[];
  files: DocFile[];
  sellers: Seller[];
  canViewTaxId: boolean;
  metrics: { buyersContacted: number; interested: number; offers: number; highOffer: number | null };
  // Multi-asset grouping.
  parent: { id: string; name: string } | null;
  assets?: AssetChild[];
  assetCount?: number;
}

interface EditTarget { id: string; name: string; initial?: { status?: BuyerActivityRow["status"]; assignedTeamMemberId?: string | null; notes?: string | null; dateSent?: string | null; nextFollowUpDate?: string | null } }

export function DealDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const nav = useNavigate();
  const [deal, setDeal] = useState<DealDetailData | null>(null);
  const [matches, setMatches] = useState<MatchRec[] | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [showStage, setShowStage] = useState(false);
  const [logBuyer, setLogBuyer] = useState<EditTarget | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showEmail, setShowEmail] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [acceptOffer, setAcceptOffer] = useState<{ id: string; buyer: string; amount: number } | null>(null);
  const [acceptBusy, setAcceptBusy] = useState(false);
  const [showAddAsset, setShowAddAsset] = useState(false);
  const [confirmSplit, setConfirmSplit] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);

  const loadDeal = useCallback(() => api.get<DealDetailData>(`/deals/${id}`).then(setDeal), [id]);
  const loadMatches = useCallback(() => api.get<MatchRec[]>(`/deals/${id}/matches`).then(setMatches), [id]);

  useEffect(() => {
    loadDeal(); loadMatches();
    api.get<UserLite[]>("/users").then(setUsers).catch(() => {});
  }, [loadDeal, loadMatches]);

  if (!deal) return <Spinner />;

  const refreshAll = () => { loadDeal(); loadMatches(); };
  // "Awaiting a response" means contacted AND no response yet — a buyer who
  // replied (responseReceived) isn't pending even if their status is still
  // Contacted.
  const hasUnresolved = deal.buyerActivity.some((a) => a.status === "CONTACTED" && !a.responseReceived);

  const toggleMatch = (buyerId: string) =>
    setSelected((prev) => { const n = new Set(prev); n.has(buyerId) ? n.delete(buyerId) : n.add(buyerId); return n; });
  const selectAllMatches = () =>
    setSelected((prev) => (matches && prev.size === matches.length ? new Set() : new Set((matches ?? []).map((m) => m.buyerId))));
  async function markContacted() {
    if (selected.size === 0) return;
    await api.post(`/deals/${id}/contact-bulk`, { buyerIds: [...selected] });
    setSelected(new Set());
    refreshAll();
  }
  function exportSelected() {
    const chosen = (matches ?? []).filter((m) => selected.has(m.buyerId));
    downloadCsv(
      `matches-${deal!.name}-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Rank", "Buyer", "Company", "Match %", "Owners", "Closed together", "Last contact"],
      chosen.map((m) => [m.rank, m.buyerName, m.companyName, m.matchPercent, m.owners.join("; "), m.previousDealsClosed, m.lastContactDate ?? ""]),
    );
  }

  // The Back link names the list this deal belongs to, so it's clear where you
  // return: Closed → Closed Deals, Dead → Archived Deals, otherwise Active Deals.
  const backTo = deal.stage === "CLOSED"
    ? { label: "Back to Closed Deals", fallback: "/deals/closed" }
    : deal.stage === "DEAD"
      ? { label: "Back to Archived Deals", fallback: "/deals/archived" }
      : { label: "Back to Active Deals", fallback: "/deals/active" };

  return (
    <div className="page deal-detail">
      <BackLink label={backTo.label} fallback={backTo.fallback} />
      <div className="page-header">
        <div className="row">
          <h1 style={{ marginBottom: 0 }}>{deal.name}</h1>
          <PriorityBadge priority={deal.priority} />
          <StageBadge stage={deal.stage} />
          <span className="muted" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
            {deal.daysInStage}d in stage
          </span>
        </div>
        <div className="row">
          {can("deleteDeals") && <button className="danger" onClick={() => setConfirmDelete(true)}>Delete</button>}
          {can("editDeals") && <button className="primary" onClick={() => setShowStage(true)}>Move Stage →</button>}
        </div>
      </div>

      {deal.stage === "DEAD" && deal.deadReason && <Banner kind="error">Dead: {deal.deadReason}</Banner>}

      {deal.parent && (
        <Banner kind="info">
          This is an asset within the <Link to={`/deals/${deal.parent.id}`}><strong>{deal.parent.name}</strong></Link> seller package.
          {can("editDeals") && <> · <button type="button" className="link-btn" onClick={() => setConfirmSplit(true)}>Split into a standalone deal</button></>}
        </Banner>
      )}

      <div className="dd-top-grid">
        <CharacteristicsCard deal={deal} users={users} canEdit={can("editDeals")} onSaved={refreshAll} />
        <ContractTimelineCard deal={deal} onSaved={loadDeal} />
      </div>

      <SellerDetails
        dealId={deal.id}
        sellers={deal.sellers ?? []}
        users={users}
        canEdit={can("editDeals")}
        onChanged={loadDeal}
      />

      {/* Multi-asset seller: the individual interests grouped under this deal.
          Hidden on a child asset (which is itself one of these). */}
      {!deal.parent && (
        <AssetsSection
          deal={deal}
          canEdit={can("editDeals")}
          canPublish={can("publishOfferings")}
          onAdd={() => setShowAddAsset(true)}
          onChanged={loadDeal}
        />
      )}

      <DealPortalPanel dealId={deal.id} />

      {/* Embedded, isolated map showing only this deal's extent. Without any
          abstracts there is nothing to draw, so a compact empty state replaces
          the map instead of a large blank canvas. */}
      <div className="panel">
        <div className="section-head"><h3>Location</h3><span className="muted">This deal's abstracts and geographic extent</span></div>
        {deal.abstractIds.length > 0 ? (
          <Suspense fallback={<Spinner label="Loading map…" />}><DealMap abstractIds={deal.abstractIds} /></Suspense>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            No abstracts linked yet — add them under <strong>Deal characteristics → Edit → Abstract</strong> and the map will draw this deal's extent.
          </p>
        )}
      </div>

      {/* Legal tract descriptions → parsed calls → mapped polygons + exports. */}
      <Suspense fallback={<Spinner label="Loading tract descriptions…" />}>
        <TractSection dealId={deal.id} dealName={deal.name} canEdit={can("editDeals")} abstractIds={deal.abstractIds} />
      </Suspense>

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
            {deal.selectedBuyer.companyName && deal.selectedBuyer.companyName !== deal.selectedBuyer.name && <span className="muted">· {deal.selectedBuyer.companyName}</span>}
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
                        can("editDeals") ? <button className="small" onClick={() => setAcceptOffer({ id: o.id, buyer: o.buyer.name, amount: o.amount })}>Accept</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Buyer Activity — expandable per-buyer relationship + timeline */}
      <div className="panel">
        <div className="section-head"><h3>Buyer Activity</h3><span className="muted">Every buyer's status, notes, and full communication history on this deal</span></div>
        <BuyerActivitySection
          dealId={deal.id}
          rows={deal.buyerActivity}
          onChanged={refreshAll}
          canEdit={can("editDeals")}
          onEdit={(r) => setLogBuyer({ id: r.buyerId, name: r.buyerName, initial: { status: r.status, assignedTeamMemberId: r.assignedTeamMember?.id ?? null, notes: r.notes, dateSent: r.dateSent, nextFollowUpDate: r.nextFollowUpDate } })}
          onRecordOffer={can("editDeals") ? (r) => setLogBuyer({ id: r.buyerId, name: r.buyerName, initial: { status: "OFFER_RECEIVED", assignedTeamMemberId: r.assignedTeamMember?.id ?? null, notes: r.notes, dateSent: r.dateSent, nextFollowUpDate: r.nextFollowUpDate } }) : undefined}
        />
      </div>

      {/* Match recommendations — actionable outreach */}
      <div className="panel">
        <div className="section-head"><h3>Buyer Match Recommendations</h3><span className="muted">Ranked, every buyer, highest match first</span></div>
        {!matches ? <Spinner /> : matches.length === 0 ? <p className="muted">No buyers in the system yet.</p> : (
          <>
            {can("editDeals") && (
              <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <label style={{ fontSize: 13, textTransform: "none" }}>
                  <input type="checkbox" checked={selected.size > 0 && selected.size === matches.length} onChange={selectAllMatches} /> Select all
                </label>
                <span className="muted" style={{ fontSize: 13 }}>{selected.size} selected</span>
                <button className="small primary" disabled={selected.size === 0} onClick={() => setShowEmail(true)}>Send Deal via Email</button>
                <button className="small" disabled={selected.size === 0} onClick={markContacted}>Mark as Contacted</button>
                <button className="small" disabled={selected.size === 0} onClick={exportSelected}>Export Selected (CSV)</button>
                <button className="small" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>Remove Selection</button>
              </div>
            )}
            {matches.map((m) => (
              <div className={`match-card ${selected.has(m.buyerId) ? "match-selected" : ""}`} key={m.buyerId}>
                <div className="match-card-head">
                  {can("editDeals") && <input type="checkbox" checked={selected.has(m.buyerId)} onChange={() => toggleMatch(m.buyerId)} />}
                  <span className="match-rank">#{m.rank}</span>
                  {/* Company name only — the primary identifier when evaluating matches.
                      Contact person is available on the Buyer Profile. */}
                  <Link to={`/buyers/${m.buyerId}`} className="match-name" title={m.companyName || m.buyerName}>{m.companyName || m.buyerName}</Link>
                  <span className="match-right">
                    <span className="match-pct-num" style={{ color: pctColor(m.matchPercent) }}>{m.matchPercent}%</span>
                    {/* Coverage context: "100%" against a sparse buy box is weak
                        evidence, so say how many criteria were actually compared. */}
                    <span className="muted" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}
                      title="How many buy-box criteria this buyer has set, and how many this deal matches">
                      {m.criteriaSpecified > 0
                        ? `${m.criteriaSpecifiedMatched}/${m.criteriaSpecified} criteria`
                        : "no buy box set"}
                    </span>
                  </span>
                </div>
                <MatchBar value={m.matchPercent} />
                <div>
                  {m.matching.map((c) => <span key={c.key} className="crit-tag crit-yes">{c.label}</span>)}
                  {m.nonMatching.map((c) => <span key={c.key} className="crit-tag crit-no">{c.label}</span>)}
                </div>
                <div className="dc-meta" style={{ marginTop: 8, justifyContent: "space-between" }}>
                  <span>Owner(s): {m.owners.length ? m.owners.join(", ") : "—"} · {m.previousDealsClosed} closed together · Last contact: {m.lastContactDate ? fmtDate(m.lastContactDate) : "never"}
                    {/* "stale" only makes sense for aged contact — a never-contacted buyer isn't stale. */}
                    {m.stale && m.lastContactDate && <span className="stale-flag" title="No contact in a while — worth a follow-up"> · stale</span>}</span>
                  {can("editDeals") && <button className="small" onClick={() => setLogBuyer({ id: m.buyerId, name: m.buyerName })}>Log contact</button>}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Documents */}
      <DocumentsSection ownerType="deal" ownerId={deal.id} files={deal.files} folders={DEAL_DOC_FOLDERS} onChanged={loadDeal} canEdit={can("manageDocuments")} canDelete={can("manageDocuments")} />

      {showStage && (
        <StageChangeModal
          deal={deal}
          hasUnresolvedActivity={hasUnresolved}
          onClose={() => setShowStage(false)}
          onChanged={() => { setShowStage(false); refreshAll(); }}
        />
      )}
      {acceptOffer && (
        <ConfirmDialog
          title="Accept this offer?"
          confirmLabel={acceptBusy ? "Accepting…" : "Accept"}
          busy={acceptBusy}
          onCancel={() => setAcceptOffer(null)}
          onConfirm={async () => {
            setAcceptBusy(true);
            try { await api.post(`/deals/${id}/accept-offer`, { offerId: acceptOffer.id }); setAcceptOffer(null); refreshAll(); }
            finally { setAcceptBusy(false); }
          }}
          message={
            <>
              <p style={{ marginTop: 0 }}>
                Accepting <strong>{acceptOffer.buyer}</strong>'s offer of <strong>{money(acceptOffer.amount)}</strong> will:
              </p>
              <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
                <li>Mark this buyer's offer as <strong>accepted</strong>.</li>
                <li>Move the deal into the <strong>Closing</strong> process.</li>
                {deal.publishedToPortal
                  ? <li>Remove the opportunity from the <strong>public Buyer Portal</strong> so it's no longer marketed to other buyers.</li>
                  : <li>Keep the opportunity off the public portal.</li>}
              </ul>
              <p className="muted" style={{ marginBottom: 0 }}>All buyer activity and communications are preserved for auditing.</p>
            </>
          }
        />
      )}
      {logBuyer && (
        <LogContactModal
          dealId={deal.id}
          buyerId={logBuyer.id}
          buyerName={logBuyer.name}
          users={users}
          initial={logBuyer.initial}
          onClose={() => setLogBuyer(null)}
          onLogged={() => { setLogBuyer(null); refreshAll(); }}
        />
      )}
      {showEmail && (
        <SendDealEmailModal
          dealId={deal.id}
          dealName={deal.name}
          buyerIds={[...selected]}
          onClose={() => setShowEmail(false)}
          onSent={() => { setSelected(new Set()); refreshAll(); }}
        />
      )}
      {confirmDelete && (
        <ConfirmDelete
          itemLabel="deal"
          name={deal.name}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => { await api.del(`/deals/${id}`); nav("/deals"); }}
        />
      )}

      {showAddAsset && (
        <NewDealModal
          parentDealId={deal.id}
          onClose={() => setShowAddAsset(false)}
          onCreated={() => { setShowAddAsset(false); loadDeal(); }}
        />
      )}

      {confirmSplit && (
        <ConfirmDialog
          title="Split into a standalone deal?"
          confirmLabel="Split out"
          busy={splitBusy}
          message={
            <>
              <strong>{deal.name}</strong> will become its own standalone deal, detached from the{" "}
              <strong>{deal.parent?.name}</strong> package. All of its documents, timeline, buyer activity, offers, and
              notes are preserved, and the seller information is copied so it stays linked.
            </>
          }
          onCancel={() => setConfirmSplit(false)}
          onConfirm={async () => {
            setSplitBusy(true);
            try { await api.post(`/deals/${deal.id}/split`, {}); setConfirmSplit(false); loadDeal(); }
            finally { setSplitBusy(false); }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assets / Tracts — the individual mineral interests grouped under this deal.
// Each is a full, independently-marketable child deal.
// ---------------------------------------------------------------------------
function AssetsSection({ deal, canEdit, canPublish, onAdd, onChanged }: {
  deal: DealDetailData; canEdit: boolean; canPublish: boolean; onAdd: () => void; onChanged: () => void;
}) {
  const assets = deal.assets ?? [];
  const [busy, setBusy] = useState(false);
  const publishedCount = assets.filter((a) => a.publishedToPortal).length;

  async function publishAll(published: boolean) {
    setBusy(true);
    try { await api.post(`/deals/${deal.id}/assets/publish`, { published, visibility: "PUBLIC" }); onChanged(); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="section-head">
        <div>
          <h3 style={{ margin: 0 }}>Additional Deals{assets.length ? ` (${assets.length})` : ""}</h3>
          <span className="muted" style={{ fontSize: 12 }}>Individual interests under this seller — each is independently marketable</span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {canPublish && assets.length > 0 && (
            publishedCount < assets.length
              ? <button className="small" disabled={busy} onClick={() => publishAll(true)} title="Publish every asset to the buyer portal">Publish all</button>
              : <button className="small" disabled={busy} onClick={() => publishAll(false)} title="Unpublish every asset">Unpublish all</button>
          )}
          {canEdit && <button className="small primary" onClick={onAdd}>+ Add asset</button>}
        </div>
      </div>

      {assets.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          No separate assets yet. This deal is a single interest — add assets to manage multiple interests from the same
          seller together (each stays independently marketable).
        </p>
      ) : (
        <>
          {/* Package total = this deal's own figures rolled up with its assets'. */}
          <div className="asset-total">
            <span className="muted">Package total</span>
            {deal.aggNra != null && <span><strong>{num(deal.aggNra)}</strong> NRA</span>}
            {deal.aggAcreageNma != null && <span><strong>{num(deal.aggAcreageNma)}</strong> NMA</span>}
            {deal.aggOurPrice != null && <span>Our <strong>{money(deal.aggOurPrice)}</strong></span>}
            {deal.aggAskPrice != null && <span style={{ color: "var(--accent)" }}>Ask <strong>{money(deal.aggAskPrice)}</strong></span>}
          </div>
        <div className="asset-grid">
          {assets.map((a) => (
            <Link key={a.id} to={`/deals/${a.id}`} className="asset-card">
              <div className="asset-card-head">
                <span className="asset-card-name">{a.name}</span>
                <StageBadge stage={a.stage} />
              </div>
              <div className="asset-card-facts">
                {a.counties.length > 0 && <span>{a.counties.join(", ")}{a.states.length ? ` · ${a.states.join(", ")}` : ""}</span>}
                {a.nra != null && <span><strong>{num(a.nra)}</strong> NRA</span>}
                {a.assetTypes.length > 0 && <span>{a.assetTypes.join("/")}</span>}
                {a.operator && <span>{a.operator}</span>}
                {a.rrc && <span>RRC {a.rrc}</span>}
              </div>
              <div className="asset-card-foot">
                {a.ourPrice != null && <span className="muted">Our {money(a.ourPrice)}</span>}
                {a.askPrice != null && <span style={{ color: "var(--accent)" }}>Ask {money(a.askPrice)}</span>}
                {a.publishedToPortal && <span className="badge resp-offer">Published</span>}
                {a.selectedBuyer && <span className="badge resp-pending">→ {a.selectedBuyer.name}</span>}
              </div>
            </Link>
          ))}
        </div>
        </>
      )}
    </div>
  );
}

function CharacteristicsCard({ deal, users, canEdit, onSaved }: { deal: DealDetailData; users: UserLite[]; canEdit: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(deal);
  const abstractLabel = useAbstractLabels(deal.abstractIds);
  // Assigned team members are a core deal characteristic, so they live in this
  // card. Assignment saves immediately (independent of the Edit flow above).
  const assigneeIds = (deal.assignees ?? []).map((a) => a.id);
  async function saveAssignees(next: string[]) { await api.patch(`/deals/${deal.id}`, { assigneeIds: next }); onSaved(); }
  // Seed the multi-state field from a legacy single `state` when needed.
  useEffect(() => setF({ ...deal, states: deal.states?.length ? deal.states : (deal.state ? [deal.state] : []) }), [deal]);

  // Operator suggestions come from the deal's counties (same source as the Map
  // page), recomputed whenever the selected counties change.
  const [operatorOptions, setOperatorOptions] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    operatorsForCounties(f.counties).then((ops) => { if (live) setOperatorOptions(ops); });
    return () => { live = false; };
  }, [f.counties]);
  const set = (k: keyof DealDetailData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value === "" ? null : e.target.value } as DealDetailData));
  const setNum = (k: keyof DealDetailData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value === "" ? null : Number(e.target.value) } as DealDetailData));
  const setArr = (k: keyof DealDetailData) => (v: string[]) => setF((p) => ({ ...p, [k]: v } as DealDetailData));

  async function save() {
    await api.patch(`/deals/${deal.id}`, {
      states: f.states, counties: f.counties, basins: f.basins, formations: f.formations,
      assetTypes: f.assetTypes, acreageNma: f.acreageNma, nra: f.nra, abstractIds: f.abstractIds, askPrice: f.askPrice, ourPrice: f.ourPrice, operator: f.operator, rrc: f.rrc,
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
        <div className="ddc-grid">
          <DKV k="State" v={(deal.states?.length ? deal.states : (deal.state ? [deal.state] : [])).join(", ") || null} />
          <DKV k="County" v={deal.counties.join(", ") || null} />
          <DKV k="Basin" v={deal.basins.join(", ") || null} />
          <DKV k="Formation" v={deal.formations.join(", ") || null} />
          <DKV k="Asset Type" v={deal.assetTypes.join(", ") || null} />
          <DKV k="NMA" v={deal.acreageNma != null ? num(deal.acreageNma) : null} mono />
          <DKV k="NRA" v={deal.nra != null ? num(deal.nra) : null} mono />
          <DKV k="Our Price" v={deal.ourPrice != null ? money(deal.ourPrice) : null} mono />
          <DKV k="Ask Price (to buyers)" v={deal.askPrice != null ? money(deal.askPrice) : null} mono accent />
          <DKV k="Operator" v={deal.operator} />
          <DKV k="RRC" v={deal.rrc} />
          {/* Label the abstract with its county only when unambiguous. */}
          <DKV k={deal.counties.length === 1 ? `Abstract (${deal.counties[0]} Co.)` : "Abstract"} v={abstractLabel || null} span2 />
        </div>
      ) : (
        <div className="dd-grid">
          <GeoFields
            states={f.states ?? []} onStatesChange={setArr("states")}
            counties={f.counties} onCountiesChange={setArr("counties")}
            abstractIds={f.abstractIds} onAbstractsChange={setArr("abstractIds")}
          />
          <Fld l="Basin"><SearchableMultiSelect options={suggestFirst(TEXAS_BASIN_OPTIONS, basinsForCounties(f.counties))} value={f.basins} onChange={setArr("basins")} placeholder="Search basins…" /></Fld>
          <Fld l="Formation"><SearchableMultiSelect options={suggestFirst(TEXAS_FORMATION_OPTIONS, formationsForCounties(f.counties))} value={f.formations} onChange={setArr("formations")} placeholder="Search formations…" /></Fld>
          <Fld l="Asset Type"><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={f.assetTypes} onChange={setArr("assetTypes")} placeholder="Search asset types…" /></Fld>
          <Fld l="NMA"><input type="number" value={f.acreageNma ?? ""} onChange={setNum("acreageNma")} /></Fld>
          <Fld l="NRA"><input type="number" value={f.nra ?? ""} onChange={setNum("nra")} /></Fld>
          <Fld l="Our Price"><input type="number" value={f.ourPrice ?? ""} onChange={setNum("ourPrice")} /></Fld>
          <Fld l="Ask Price (to buyers)"><input type="number" value={f.askPrice ?? ""} onChange={setNum("askPrice")} /></Fld>
          <Fld l="Operator">
            <input
              list="deal-operator-options"
              value={f.operator ?? ""}
              onChange={set("operator")}
              placeholder={operatorOptions.length ? `Search ${operatorOptions.length} operators in these counties…` : (f.counties.length ? "No operator data for these counties" : "Add a county to see operators")}
            />
            <datalist id="deal-operator-options">
              {operatorOptions.map((o) => <option key={o} value={o} />)}
            </datalist>
          </Fld>
          <Fld l="RRC">
            <input value={f.rrc ?? ""} onChange={set("rrc")} placeholder="RRC lease / district / operator no." />
          </Fld>
        </div>
      )}

      {/* Assigned Team Members — a core deal attribute, kept inside this card. */}
      <div className="ddc-assignees">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <span className="ddx-label">Assigned Team Members</span>
          <span className="muted" style={{ fontSize: 12 }}>{assigneeIds.length ? `${assigneeIds.length} assigned` : "Unassigned"}</span>
        </div>
        {canEdit ? (
          <AssigneePicker users={users} value={assigneeIds} onChange={saveAssignees} />
        ) : (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {assigneeIds.length === 0 ? <span className="muted">Unassigned</span> : (deal.assignees ?? []).map((a) => <span key={a.id} className="badge resp-pending">{a.name}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}

function ContractTimelineCard({ deal, onSaved }: { deal: DealDetailData; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [duc, setDuc] = useState("");
  const [fbb, setFbb] = useState("");
  const [oc, setOc] = useState("");
  const [fc, setFc] = useState("");
  const [cd, setCd] = useState("");

  function startEdit() {
    setDuc(toInputDate(deal.dateUnderContract));
    setFbb(toInputDate(deal.findBuyerByDate));
    setOc(toInputDate(deal.originalClosingDate));
    setFc(toInputDate(deal.finalClosingDate));
    setCd(toInputDate(deal.closedDate));
    setEdit(true);
  }

  async function save() {
    const patch: Record<string, unknown> = {};
    // Only send changed fields. FBB/FC become overrides; DUC/OC/Closed are direct.
    if (duc !== toInputDate(deal.dateUnderContract)) patch.dateUnderContract = duc || null;
    if (fbb !== toInputDate(deal.findBuyerByDate)) patch.findBuyerByDateOverride = fbb || null;
    if (oc !== toInputDate(deal.originalClosingDate)) patch.originalClosingDate = oc || null;
    if (fc !== toInputDate(deal.finalClosingDate)) patch.finalClosingDateOverride = fc || null;
    if (cd !== toInputDate(deal.closedDate)) patch.closedDate = cd || null;
    await api.patch(`/deals/${deal.id}`, patch);
    setEdit(false);
    onSaved();
  }

  async function revert(field: "fbb" | "fc") {
    await api.patch(`/deals/${deal.id}`, field === "fbb" ? { findBuyerByDateOverride: null } : { finalClosingDateOverride: null });
    onSaved();
  }

  const isClosed = deal.stage === "CLOSED";
  const noDates = !deal.dateUnderContract && !deal.findBuyerByDate && !deal.originalClosingDate && !deal.finalClosingDate && !deal.closedDate;

  // Vertical milestone timeline: filled glowing dot = milestone date reached;
  // hollow dot = upcoming. Closed Date appears once the deal is closed/has a date.
  const milestones: { label: string; date: string | null; overridden?: boolean; revertKey?: "fbb" | "fc" }[] = [
    { label: "Under Contract", date: deal.dateUnderContract },
    { label: "Find Buyer By", date: deal.findBuyerByDate, overridden: deal.findBuyerByIsOverridden, revertKey: "fbb" },
    { label: "Orig. Closing", date: deal.originalClosingDate },
    { label: "Final Closing", date: deal.finalClosingDate, overridden: deal.finalClosingIsOverridden, revertKey: "fc" },
    ...(deal.closedDate || isClosed ? [{ label: "Closed", date: deal.closedDate }] : []),
  ];

  return (
    <div className="panel">
      <div className="section-head">
        <h3>Contract timeline</h3>
        {edit ? <div className="row"><button className="small" onClick={() => setEdit(false)}>Cancel</button><button className="small primary" onClick={save}>Save</button></div>
          : <button className="small" onClick={startEdit}>Edit dates</button>}
      </div>
      {noDates && !edit && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          No dates yet — <strong>Edit dates</strong> and set the Under Contract date; Find Buyer By and Final Closing auto-calculate from it.
        </p>
      )}
      {!edit ? (
        noDates ? null : (
        <div className="ctl">
          {milestones.map((m) => {
            const done = m.date != null && new Date(m.date).getTime() <= Date.now();
            return (
              <div className={`ctl-item ${done ? "done" : ""}`} key={m.label}>
                <div className="ctl-rail">
                  <span className={`ctl-dot ${done ? "done" : ""}`} />
                </div>
                <div className="ctl-body">
                  <div className={`ctl-lbl ${done ? "done" : ""}`}>{m.label}{m.overridden && <em style={{ letterSpacing: 0, textTransform: "none" }}> (overridden)</em>}</div>
                  <div className="ctl-date">
                    {fmtDate(m.date)}
                    {m.overridden && m.revertKey && <button className="small" onClick={() => revert(m.revertKey!)}>Revert to auto</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        )
      ) : (
        <div className="dd-grid">
          <Fld l="Under Contract"><input type="date" value={duc} onChange={(e) => setDuc(e.target.value)} /></Fld>
          <Fld l="Find Buyer By"><input type="date" value={fbb} onChange={(e) => setFbb(e.target.value)} /></Fld>
          <Fld l="Orig. Closing"><input type="date" value={oc} onChange={(e) => setOc(e.target.value)} /></Fld>
          <Fld l="Final Closing"><input type="date" value={fc} onChange={(e) => setFc(e.target.value)} /></Fld>
          <Fld l="Closed Date"><input type="date" value={cd} onChange={(e) => setCd(e.target.value)} /></Fld>
        </div>
      )}
    </div>
  );
}


/** Match-percent color scale (mirrors the reference: green / amber / red). */
function pctColor(pct: number): string {
  return pct >= 67 ? "#4ade80" : pct >= 34 ? "#f59e0b" : "#f87171";
}

/** Reference-style KV: uppercase micro-label over a semibold value (mono for
 *  numerics, green accent for the buyer-facing ask price, dimmed em-dash when empty). */
function DKV({ k, v, mono, accent, span2 }: { k: string; v: React.ReactNode; mono?: boolean; accent?: boolean; span2?: boolean }) {
  const empty = v == null || v === "";
  return (
    <div style={span2 ? { gridColumn: "span 2" } : undefined}>
      <div className="ddx-label">{k}</div>
      <div className={`ddx-val${mono && !empty ? " mono" : ""}${accent && !empty ? " pos" : ""}${empty ? " dim" : ""}`}>{empty ? "—" : v}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v || "—"}</span></div>;
}
function Fld({ l, children }: { l: string; children: React.ReactNode }) {
  return <div className="field"><label>{l}</label>{children}</div>;
}
