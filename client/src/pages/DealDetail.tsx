import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Tabs } from "../components/Tabs";
import { useAuth } from "../auth/AuthContext";
import {
  Spinner, Modal, Banner, ConfirmDelete, ConfirmDialog, BackLink, OverflowMenu, showToast, ChipList, EmptyState,
} from "../components/ui";
import { StatStrip, Tag, type StatCell } from "../components/kit";
import { useStages } from "../stages";
import { ChevronDown, Pencil, Plus } from "lucide-react";
import { useUnsavedSection } from "../lib/unsaved";
import { StageChangeModal } from "../components/StageChangeModal";
import { LogContactModal } from "../components/LogContactModal";
import { BuyerActivitySection } from "../components/BuyerActivitySection";
import { CollapsibleSection } from "../components/CollapsibleSection";
import { SendDealEmailModal } from "../components/SendDealEmailModal";
import { useAbstractLabels } from "../components/AbstractPicker";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { GeoFields } from "../components/GeoFields";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS, ASSET_TYPE_LABELS, basinsForCounties, formationsForCounties, suggestFirst } from "../lib/options";
import { money, num, fmtDate, toInputDate, prettyEnum } from "../lib/format";
import { downloadCsv } from "../lib/csv";
import { SellerDetails } from "../components/SellerDetails";
import { DealPortalPanel } from "../components/DealPortalPanel";
import { DocumentsSection, DEAL_DOC_FOLDERS, type DocFile } from "../components/DocumentsSection";
import { OfferRowActions } from "../components/OfferActions";
import type { AssetChild, BuyerActivityRow, DealSummary, MatchRec, Seller, UserLite } from "../types";
import { NewDealModal } from "../components/NewDealModal";
import { MoneyInput } from "../components/MoneyInput";
import { MarketingFunnel } from "../components/MarketingFunnel";
import { DateField } from "../components/DateField";
import { royaltyLabel, royaltyOptions } from "../lib/royalty";
import { Select } from "../components/Select";
import { OperatorSelect } from "../components/OperatorSelect";
import {
  addDaysIso, applyAcreageEdit, AcreageNote, DaysToCloseField, editPriceGroup, priceGroupFromStored, PriceNote, syncPriceGroup,
  type AcreageState, type PriceField, type PriceGroup,
} from "../components/DealEconomics";
// MapLibre is heavy; only load it when a deal detail page is viewed.
const DealMap = lazy(() => import("../components/DealMap").then((m) => ({ default: m.DealMap })));

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
  // Destination picked from the "Move stage" menu; opening the standard
  // StageChangeModal (all its checks and confirmations) pre-set to it.
  const [stageTarget, setStageTarget] = useState<string | null>(null);
  const [logBuyer, setLogBuyer] = useState<EditTarget | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showEmail, setShowEmail] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [acceptOffer, setAcceptOffer] = useState<{ id: string; buyer: string; amount: number } | null>(null);
  const [acceptBusy, setAcceptBusy] = useState(false);
  const [showAddAsset, setShowAddAsset] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Top-level tab (Mineral Assets pattern) — pure navigation; every section
  // renders exactly as before, just grouped.
  const [tab, setTab] = useState<"general" | "additional" | "buyers" | "marketplace" | "documents">("general");
  const [confirmSplit, setConfirmSplit] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);
  // Match list shows the top 6 by default (reference); one click expands.
  const [showAllMatches, setShowAllMatches] = useState(false);

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
    ? { label: "Back to closed deals", fallback: "/deals/closed" }
    : deal.stage === "DEAD"
      ? { label: "Back to archived deals", fallback: "/deals/archived" }
      : { label: "Back to active deals", fallback: "/deals/active" };

  // Summary strip — the deal's own stored figures (the per-acre prices are the
  // saved per-NMA / per-NRA values; per NRA falls back to the total ÷ NRA the
  // page has always shown). Implied margin keeps the existing formula.
  const perAcreSub = (perNma: number | null | undefined, perNra: number | null | undefined) =>
    perNma == null && perNra == null ? undefined
      : `${money(perNma, { cents: true })} / NMA · ${money(perNra, { cents: true })} / NRA`;
  const ourPerNra = deal.ourCostPerNra ?? (deal.ourPrice != null && deal.nra ? Math.round(deal.ourPrice / deal.nra) : null);
  const askPerNra = deal.askPricePerNra ?? (deal.askPrice != null && deal.nra ? Math.round(deal.askPrice / deal.nra) : null);
  const hasMargin = deal.askPrice != null && deal.ourPrice != null && deal.ourPrice > 0;
  const royalty = royaltyLabel(deal.royaltyRate);
  const summary: StatCell[] = [
    { label: "Our cost", value: money(deal.ourPrice), sub: perAcreSub(deal.ourCostPerNma, ourPerNra) },
    { label: "Asking price", value: money(deal.askPrice), sub: perAcreSub(deal.askPricePerNma, askPerNra) },
    {
      label: "Implied margin",
      value: hasMargin ? `${deal.askPrice! >= deal.ourPrice! ? "+" : ""}${Math.round(((deal.askPrice! - deal.ourPrice!) / deal.ourPrice!) * 100)}%` : "—",
      tone: hasMargin ? (deal.askPrice! >= deal.ourPrice! ? "success" : "danger") : "default",
      sub: "Asking price over our cost",
    },
    {
      label: "Interest",
      value: deal.nra != null ? `${num(deal.nra)} NRA` : "—",
      sub: [deal.acreageNma != null ? `${num(deal.acreageNma)} NMA` : null, royalty ? `${royalty} royalty` : null].filter(Boolean).join(" · ") || undefined,
    },
    { label: "Final closing", value: deal.finalClosingDate ? relDays(deal.finalClosingDate) : "—", sub: deal.finalClosingDate ? fmtDate(deal.finalClosingDate) : "Not set" },
  ];

  // Tab labels with their record counts (counts of what each tab lists).
  const tabLabel = (text: string, count: number) => count > 0
    ? <><span className="tab-lbl" data-label={text}>{text}</span><span className="tab-badge">{count}</span></>
    : text;

  return (
    <div className="page deal-detail">
      <BackLink label={backTo.label} fallback={backTo.fallback} />
      <div className="page-header dd-head">
        <div className="dd-head-title">
          <h1>{deal.name}</h1>
          {can("editDeals") && (
            <button type="button" className="icon-btn dd-rename" title="Rename deal" aria-label="Rename deal" onClick={() => setRenaming(true)}>
              <Pencil size={14} />
            </button>
          )}
          <Tag tone={PRIORITY_TONE[deal.priority] ?? "neutral"} dot title={PRIORITY_TIP}>{prettyEnum(deal.priority)} priority</Tag>
          <StageTag stage={deal.stage} pipelineId={deal.pipelineId} />
          <span className="dd-days">{deal.daysInStage}d in stage</span>
        </div>
        <div className="dd-head-actions">
          {can("editDeals") && <MoveStageMenu stage={deal.stage} pipelineId={deal.pipelineId} onPick={setStageTarget} />}
          {can("deleteDeals") && <OverflowMenu items={[{ label: "Delete deal…", danger: true, onClick: () => setConfirmDelete(true) }]} />}
        </div>
      </div>

      {deal.stage === "DEAD" && deal.deadReason && <Banner kind="error">Dead: {deal.deadReason}</Banner>}

      {/* Deadline alert — Find Buyer By is close (or past) and no buyer is
          attached yet. One click lands on the Buyers tab. */}
      {deal.stage !== "CLOSED" && deal.stage !== "DEAD" && !deal.selectedBuyer && deal.findBuyerByDate && (() => {
        const days = Math.ceil((new Date(deal.findBuyerByDate).getTime() - Date.now()) / 86_400_000);
        if (days > 7) return null;
        const when = days < 0 ? `was ${-days} day${days === -1 ? "" : "s"} ago` : days === 0 ? "is today" : `is in ${days} day${days === 1 ? "" : "s"}`;
        return (
          <div className="dd-alert">
            <span className="dd-alert-main">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4l9 16H3L12 4zM12 10v4M12 17h.01" /></svg>
              <span className="dd-alert-msg"><b>Find buyer by {when}</b> ({fmtDate(deal.findBuyerByDate)}) and no buyer is attached to this deal yet.</span>
            </span>
            <button type="button" className="link-btn dd-alert-link" onClick={() => setTab("buyers")}>Review buyers →</button>
          </div>
        );
      })()}

      {deal.parent && (
        <Banner kind="info">
          This is one of the additional deals under <Link to={`/deals/${deal.parent.id}`}><strong>{deal.parent.name}</strong></Link>.
          {can("editDeals") && <> · <button type="button" className="link-btn" onClick={() => setConfirmSplit(true)}>Split into a standalone deal</button></>}
        </Banner>
      )}

      <StatStrip cells={summary} min={190} className="dd-summary" />

      {/* Persistent header — Deal Characteristics + Contract Timeline stay
          visible on every tab, exactly as before. */}
      <div className="dd-top-grid">
        <CharacteristicsCard deal={deal} onSaved={refreshAll} />
        <ContractTimelineCard deal={deal} onSaved={loadDeal} />
      </div>

      {/* Top-level tabs (same pattern as Mineral Assets) — organization only:
          every section below is the existing component, unchanged, just
          grouped so the page needs far less scrolling. */}
      <Tabs
        tabs={[
          { key: "general" as const, label: "General" },
          { key: "additional" as const, label: tabLabel("Additional deals", deal.assets?.length ?? 0), hidden: !!deal.parent },
          { key: "buyers" as const, label: tabLabel("Buyers", deal.buyerActivity.length) },
          { key: "marketplace" as const, label: "Marketplace" },
          { key: "documents" as const, label: tabLabel("Documents", can("viewDocuments") ? deal.files.length : 0) },
        ]}
        active={tab}
        onSelect={setTab}
      />

      {/* Tab panels stay MOUNTED and toggle with `hidden` instead of
          unmounting: switching is instant, the map/marketplace stats don't
          re-fetch or re-initialize on every visit, section open/closed state
          survives, and the page height never collapses mid-switch (the old
          source of layout jumping and flicker). */}
      <div hidden={tab !== "general"}>
      <SellerDetails
        dealId={deal.id}
        sellers={deal.sellers ?? []}
        users={users}
        canEdit={can("editDeals")}
        onChanged={loadDeal}
      />

      {/* Embedded, isolated map showing this deal's abstracts plus any tract
          boundaries imported onto it (shapefiles — also shown on the main map). */}
      <LocationCard deal={deal} />
      </div>

      {/* Additional Deals: the extra deals grouped under this seller. Hidden on a
          child deal (which is itself one of these — the tab is hidden too). */}
      <div hidden={tab !== "additional"}>
      {!deal.parent && (
        <AssetsSection
          deal={deal}
          canEdit={can("editDeals")}
          canPublish={can("publishOfferings")}
          onAdd={() => setShowAddAsset(true)}
          onChanged={loadDeal}
        />
      )}
      </div>

      <div hidden={tab !== "marketplace"}><DealPortalPanel dealId={deal.id} /></div>

      <div hidden={tab !== "buyers"}>
      {/* Marketing funnel — the single buyer-marketing summary (contacted →
          interested → offers → highest offer → estimated profit), shared with
          the Mineral Assets Sell tab; cost basis for a deal is our price. */}
      <MarketingFunnel metrics={deal.metrics} matchCount={matches?.length ?? 0} askPrice={deal.askPrice} costBasis={deal.ourPrice} />

      {deal.selectedBuyer && (
        <div className="dd-selected-banner">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
          <span><b>Selected buyer:</b> <Link to={`/buyers/${deal.selectedBuyer.id}`} className="subtle-link">{deal.selectedBuyer.name}</Link>
            {deal.selectedBuyer.companyName && deal.selectedBuyer.companyName !== deal.selectedBuyer.name && <span className="muted"> · {deal.selectedBuyer.companyName}</span>}</span>
          <span className="dd-selected-right"><b>Profit est:</b> <b className="pos">{money(deal.profitEst)}</b></span>
        </div>
      )}

      {/* Offers */}
      {deal.offers.length > 0 && (
        <div className="panel dd-card dd-offers">
          <div className="dd-card-head">
            <div>
              <h3 className="dd-card-title">Offers</h3>
              <div className="dd-card-sub">Every offer received on this deal</div>
            </div>
            <span className="dd-card-count">{deal.offers.length} offer{deal.offers.length === 1 ? "" : "s"}</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Buyer</th><th className="right">Amount</th><th>Status</th><th>Expires</th><th>Conditions</th><th></th></tr></thead>
              <tbody>
                {deal.offers.map((o) => {
                  // One source of truth for acceptance: the offer's own status
                  // OR the deal's selection — either one means accepted, so no
                  // surface can show "Accept" next to an accepted offer or let
                  // the edit modal silently downgrade it.
                  const accepted = o.status === "ACCEPTED" || deal.selectedOfferId === o.id;
                  return (
                  <tr key={o.id}>
                    <td><Link to={`/buyers/${o.buyer.id}`} className="dd-offer-buyer">{o.buyer.name}</Link></td>
                    <td className="right dd-offer-amt">{money(o.amount)}</td>
                    <td>{accepted ? "Accepted Offer" : prettyEnum(o.status)}</td>
                    <td>{fmtDate(o.expirationDate)}</td>
                    <td className="cell-clamp" title={o.conditions ?? undefined}>{o.conditions ?? "—"}</td>
                    <td className="right">
                      <span className="dd-offer-actions">
                        {accepted ? <Tag tone="success" dot>Accepted Offer</Tag> :
                          can("editDeals") ? <button className="small dd-accept" onClick={() => setAcceptOffer({ id: o.id, buyer: o.buyer.name, amount: o.amount })}>Accept</button> : null}
                        {can("editDeals") && <OfferRowActions offer={o} accepted={accepted} onChanged={refreshAll} dealNma={deal.acreageNma} dealNra={deal.nra} />}
                      </span>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Buyer Activity — expanded by default; collapsible per-buyer relationship + timeline */}
      <CollapsibleSection
        defaultOpen
        title="Buyer activity"
        sub="Every buyer's status, notes, and full communication history on this deal"
        right={<span className="dd-card-count">{deal.buyerActivity.length} buyer{deal.buyerActivity.length === 1 ? "" : "s"}</span>}
      >
        <BuyerActivitySection
          dealId={deal.id}
          rows={deal.buyerActivity}
          onChanged={refreshAll}
          canEdit={can("editDeals")}
          onEdit={(r) => setLogBuyer({ id: r.buyerId, name: r.buyerName, initial: { status: r.status, assignedTeamMemberId: r.assignedTeamMember?.id ?? null, notes: r.notes, dateSent: r.dateSent, nextFollowUpDate: r.nextFollowUpDate } })}
          onRecordOffer={can("editDeals") ? (r) => setLogBuyer({ id: r.buyerId, name: r.buyerName, initial: { status: "OFFER_RECEIVED", assignedTeamMemberId: r.assignedTeamMember?.id ?? null, notes: r.notes, dateSent: r.dateSent, nextFollowUpDate: r.nextFollowUpDate } }) : undefined}
        />
      </CollapsibleSection>

      {/* Match recommendations — expanded by default; actionable outreach */}
      <CollapsibleSection
        defaultOpen
        title="Buyer matches"
        sub="Ranked, every buyer, highest match first"
        right={matches ? <span className="dd-card-count">{matches.length} buyer{matches.length === 1 ? "" : "s"}</span> : undefined}
      >
        {!matches ? <Spinner /> : matches.length === 0 ? <p className="muted mr-none">No buyers in the system yet.</p> : (
          <>
            {can("editDeals") && (
              <div className="mr-bulk">
                <label className="mr-selall">
                  <input type="checkbox" checked={selected.size > 0 && selected.size === matches.length} onChange={selectAllMatches} /> Select all
                </label>
                <span className="mr-selcount">{selected.size} selected</span>
                <button className="small primary" disabled={selected.size === 0} onClick={() => setShowEmail(true)}>Send deal by email</button>
                <button className="small" disabled={selected.size === 0} onClick={markContacted}>Mark as contacted</button>
                <button className="small" disabled={selected.size === 0} onClick={exportSelected}>Export selected (CSV)</button>
                {selected.size > 0 && <button className="link-btn mr-deselect" onClick={() => setSelected(new Set())}>Deselect all</button>}
              </div>
            )}
            <div className="mr-list">
            {(showAllMatches ? matches : matches.slice(0, 6)).map((m) => {
              const ring = 2 * Math.PI * 14;
              const ringTone = m.matchPercent >= 70 ? "success" : m.matchPercent >= 55 ? "warn" : "low";
              return (
              <div className={`match-card ${selected.has(m.buyerId) ? "match-selected" : ""}`} key={m.buyerId}>
                {can("editDeals") && <input type="checkbox" checked={selected.has(m.buyerId)} onChange={() => toggleMatch(m.buyerId)} aria-label={`Select ${m.companyName || m.buyerName}`} />}
                <span className="match-rank">#{m.rank}</span>
                {/* Score ring: circular progress with the % inside. */}
                <span className={`mr-ring ${ringTone}`} aria-label={`${m.matchPercent}% match`}>
                  <svg width="36" height="36" viewBox="0 0 36 36">
                    <circle cx="18" cy="18" r="14" fill="none" className="mr-ring-track" strokeWidth="3" />
                    <circle cx="18" cy="18" r="14" fill="none" className="mr-ring-val" strokeWidth="3" strokeLinecap="round"
                      strokeDasharray={`${((ring * m.matchPercent) / 100).toFixed(1)} ${ring.toFixed(1)}`} transform="rotate(-90 18 18)" />
                  </svg>
                  <span className="mr-ring-n">{m.matchPercent}</span>
                </span>
                <div className="mr-main">
                  <div className="mr-title">
                    {/* Company name only — the primary identifier when evaluating matches.
                        Contact person is available on the Buyer Profile. */}
                    <Link to={`/buyers/${m.buyerId}`} className="match-name subtle-link" title={m.companyName || m.buyerName}>{m.companyName || m.buyerName}</Link>
                    {m.matchPercent >= 70 && m.criteriaSpecified >= 4 && <Tag tone="success" dot>Strong fit</Tag>}
                    {m.lastContactDate && <span className="mr-contacted">Contacted</span>}
                    <span className="mr-crit" title="How many buy-box criteria this buyer has set, and how many this deal matches">
                      {m.criteriaSpecified > 0 ? `${m.criteriaSpecifiedMatched}/${m.criteriaSpecified} criteria met` : "no buy box set"}
                    </span>
                  </div>
                  <div className="mr-meta">
                    Owner(s): {m.owners.length ? <ChipList items={m.owners} max={3} /> : "—"} · {m.previousDealsClosed} closed together · Last contact: {m.lastContactDate ? fmtDate(m.lastContactDate) : "never"}
                    {/* "stale" only makes sense for aged contact — a never-contacted buyer isn't stale. */}
                    {m.stale && m.lastContactDate && <span className="stale-flag" title="No contact in a while — worth a follow-up"> · stale</span>}
                  </div>
                  <div className="mr-tags">
                    {m.matching.map((c) => <span key={c.key} className="crit-tag crit-yes">{c.label}</span>)}
                    {m.nonMatching.map((c) => <span key={c.key} className="crit-tag crit-no">{c.label}</span>)}
                  </div>
                </div>
                {can("editDeals") && <button className="small match-log" onClick={() => setLogBuyer({ id: m.buyerId, name: m.buyerName })}>Log contact</button>}
              </div>
              );
            })}
            </div>
            <div className="mr-foot">
              <span className="mr-legend"><i className="yes" />In buy box</span>
              <span className="mr-legend"><i />Not in buyer's buy box</span>
              {matches.length > 6 && (
                <button className="small mr-more" onClick={() => setShowAllMatches((v) => !v)}>
                  {showAllMatches ? "Show top 6" : `Show all ${matches.length} buyers`}
                </button>
              )}
            </div>
          </>
        )}
      </CollapsibleSection>
      </div>

      {/* Documents */}
      <div hidden={tab !== "documents"}>
      {can("viewDocuments")
        ? <DocumentsSection ownerType="deal" ownerId={deal.id} files={deal.files} folders={deal.docFolders?.length ? deal.docFolders : DEAL_DOC_FOLDERS} onChanged={loadDeal} canEdit={can("manageDocuments")} canDelete={can("manageDocuments")} />
        : <div className="panel muted">You do not have permission to view documents.</div>}
      </div>

      {renaming && (
        <RenameDealModal dealId={deal.id} current={deal.name} onClose={() => setRenaming(false)}
          onRenamed={() => { setRenaming(false); refreshAll(); }} />
      )}
      {stageTarget && (
        <StageChangeModal
          deal={deal}
          initialStage={stageTarget}
          hasUnresolvedActivity={hasUnresolved}
          onClose={() => setStageTarget(null)}
          onChanged={() => { setStageTarget(null); refreshAll(); }}
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
          dealNra={deal.nra}
          dealNma={deal.acreageNma}
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
// Additional Deals — the extra deals grouped under this seller. Each is a full,
// independently-marketable child deal.
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
    <div className="panel dd-card">
      <div className="dd-card-head">
        <div>
          <h3 className="dd-card-title">Additional deals</h3>
          <div className="dd-card-sub">Other interests from the same seller. Each stays independently marketable.</div>
        </div>
        <div className="dd-card-actions">
          {canPublish && assets.length > 0 && (
            publishedCount < assets.length
              ? <button className="small" disabled={busy} onClick={() => publishAll(true)} title="Publish every deal to the buyer portal">Publish all</button>
              : <button className="small" disabled={busy} onClick={() => publishAll(false)} title="Unpublish every deal">Unpublish all</button>
          )}
          {canEdit && <button className="small primary dd-add-btn" onClick={onAdd}><Plus size={13} strokeWidth={2.2} aria-hidden="true" />Add deal</button>}
        </div>
      </div>

      {assets.length === 0 ? (
        <EmptyState title="No additional deals yet">
          Use <strong>Add deal</strong> to manage multiple interests from the same seller together — each stays independently marketable.
        </EmptyState>
      ) : (
        <>
          {/* Package total = this deal's own figures rolled up with its assets'. */}
          <div className="asset-total">
            <span className="muted">Package total</span>
            {deal.aggNra != null && <span><strong>{num(deal.aggNra)}</strong> NRA</span>}
            {deal.aggAcreageNma != null && <span><strong>{num(deal.aggAcreageNma)}</strong> NMA</span>}
            {deal.aggOurPrice != null && <span>Our <strong>{money(deal.aggOurPrice)}</strong></span>}
            {deal.aggAskPrice != null && <span className="asset-ask">Ask <strong>{money(deal.aggAskPrice)}</strong></span>}
          </div>
          <div className="asset-rows-scroll">
            <div className="asset-rows">
              {assets.map((a) => (
                <Link key={a.id} to={`/deals/${a.id}`} className="asset-row">
                  <span className="asset-row-name">
                    <span className="asset-row-title">{a.name}</span>
                    <StageTag stage={a.stage} />
                  </span>
                  <span className="asset-row-facts">
                    {(a.counties.length > 0 || a.states.length > 0) && <ChipList items={[...a.counties, ...a.states]} max={4} />}
                    {a.assetTypes.length > 0 && <ChipList items={a.assetTypes} />}
                    {a.operator && <span>{a.operator}</span>}
                    {a.rrc && <span>RRC {a.rrc}</span>}
                  </span>
                  <span className="asset-row-num">{a.nra != null ? <><strong>{num(a.nra)}</strong> NRA</> : "—"}</span>
                  <span className="asset-row-num muted">{a.ourPrice != null ? `Our ${money(a.ourPrice)}` : ""}</span>
                  <span className="asset-row-num asset-ask">{a.askPrice != null ? `Ask ${money(a.askPrice)}` : ""}</span>
                  <span className="asset-row-badges">
                    {a.publishedToPortal && <Tag tone="success" dot>Published</Tag>}
                    {a.selectedBuyer && <Tag tone="accent">→ {a.selectedBuyer.name}</Tag>}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The deal's economics as edited in Deal Characteristics — the same fields and
 * the same automatic calculations as New Deal (strings while editing):
 * NMA ↔ NRA through the royalty rate, and each price's total / per NMA /
 * per NRA from whichever of the three the user typed.
 */
interface EconForm extends AcreageState {
  cost: PriceGroup; ask: PriceGroup;
  estimatedClosingCosts: string; daysToClose: string;
}
const numStr = (v: number | null | undefined) => (v == null ? "" : String(v));
const numOrNull = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
function econFromDeal(d: DealDetailData): EconForm {
  return {
    royaltyRate: d.royaltyRate ?? "", nma: numStr(d.acreageNma), nra: numStr(d.nra), source: null,
    cost: priceGroupFromStored(d.ourCostPerNma, d.ourCostPerNra, d.ourPrice, d.acreageNma, d.nra),
    ask: priceGroupFromStored(d.askPricePerNma, d.askPricePerNra, d.askPrice, d.acreageNma, d.nra),
    estimatedClosingCosts: numStr(d.estimatedClosingCosts), daysToClose: numStr(d.daysToClose),
  };
}
/** Acreage + day count for an economics form. */
function econTotals(e: EconForm) {
  const dtc = e.daysToClose.trim() !== "" && Number(e.daysToClose) > 0 ? Math.round(Number(e.daysToClose)) : null;
  return { nma: numOrNull(e.nma), nra: numOrNull(e.nra), daysToClose: dtc };
}

function CharacteristicsCard({ deal, onSaved }: { deal: DealDetailData; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(deal);
  const abstractLabel = useAbstractLabels(deal.abstractIds);
  // Team assignment is deliberately not shown or edited on the deal page; the
  // deal's assignees are left untouched by every save below.
  // Seed the multi-state field from a legacy single `state` when needed. The
  // seed is also the dirty baseline for the unsaved-changes guard.
  const seed = useMemo(() => ({ ...deal, states: deal.states?.length ? deal.states : (deal.state ? [deal.state] : []) }), [deal]);
  useEffect(() => setF(seed), [seed]);
  // Economics are edited as strings, exactly like New Deal.
  const econSeed = useMemo(() => econFromDeal(deal), [deal]);
  const [econ, setEcon] = useState<EconForm>(econSeed);
  useEffect(() => setEcon(econSeed), [econSeed]);
  const discard = () => { setF(seed); setEcon(econSeed); setEdit(false); };
  // Leaving the page with unsaved characteristic edits triggers the standard
  // Save / Discard / Cancel dialog.
  useUnsavedSection(edit, { f, econ }, { f: seed, econ: econSeed }, save, discard);

  const set = (k: keyof DealDetailData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value === "" ? null : e.target.value } as DealDetailData));
  const setArr = (k: keyof DealDetailData) => (v: string[]) => setF((p) => ({ ...p, [k]: v } as DealDetailData));
  const setE = (patch: Partial<EconForm>) => setEcon((p) => ({ ...p, ...patch }));
  // A new NMA / NRA / royalty rate re-derives the other acreage figure, then
  // both prices' calculated fields (never the figure the user typed).
  const editAcreage = (edit: { nma?: string; nra?: string; royaltyRate?: string }) => setEcon((p) => {
    const a = applyAcreageEdit(p, edit);
    const m = numOrNull(a.nma), r = numOrNull(a.nra);
    return { ...p, ...a, cost: syncPriceGroup(p.cost, m, r), ask: syncPriceGroup(p.ask, m, r) };
  });
  const editPrice = (group: "cost" | "ask", field: PriceField) => (v: string) =>
    setEcon((p) => ({ ...p, [group]: editPriceGroup(p[group], field, v, numOrNull(p.nma), numOrNull(p.nra)) }));
  const t = econTotals(econ);

  // Original closing follows Date Under Contract + Days to Close (as in New
  // Deal) unless it was set independently of the stored window.
  const contractIso = deal.dateUnderContract ? toInputDate(deal.dateUnderContract) : "";
  const closingIso = deal.originalClosingDate ? toInputDate(deal.originalClosingDate) : "";
  const closingFollows = !closingIso || deal.daysToClose == null || closingIso === addDaysIso(contractIso, deal.daysToClose);
  const nextClosing = contractIso && t.daysToClose && t.daysToClose !== (deal.daysToClose ?? null) && closingFollows
    ? addDaysIso(contractIso, t.daysToClose) : null;

  async function save() {
    await api.patch(`/deals/${deal.id}`, {
      states: f.states, counties: f.counties, basins: f.basins, formations: f.formations,
      assetTypes: f.assetTypes, abstractIds: f.abstractIds, operator: f.operator || null, rrc: f.rrc,
      royaltyRate: econ.royaltyRate || null,
      acreageNma: t.nma, nra: t.nra,
      ourCostPerNma: numOrNull(econ.cost.perNma), ourCostPerNra: numOrNull(econ.cost.perNra), ourPrice: numOrNull(econ.cost.total),
      askPricePerNma: numOrNull(econ.ask.perNma), askPricePerNra: numOrNull(econ.ask.perNra), askPrice: numOrNull(econ.ask.total),
      estimatedClosingCosts: numOrNull(econ.estimatedClosingCosts),
      daysToClose: t.daysToClose,
      ...(nextClosing ? { originalClosingDate: nextClosing } : {}),
    });
    setEdit(false);
    onSaved(); // editing characteristics auto-refreshes matches
  }

  const list = (xs: readonly (string | null | undefined)[]) => xs.filter(Boolean).join(", ") || null;
  const states = deal.states?.length ? deal.states : [deal.state];
  // Our cost / asking price (totals and per-acre) and the implied margin are in
  // the summary strip above the card.
  const groups: { title: string; rows: { k: string; v: string | null }[] }[] = [
    {
      title: "Location",
      rows: [
        { k: "State", v: list(states) },
        { k: "County", v: list(deal.counties) },
        // Label the abstract with its county only when unambiguous.
        { k: deal.abstractIds.length > 1 ? "Abstracts" : "Abstract", v: deal.abstractIds.length ? abstractLabel : null },
        { k: "Basin", v: list(deal.basins) },
        { k: "Formation", v: list(deal.formations) },
        { k: "Operator", v: deal.operator },
        { k: "RRC number", v: deal.rrc },
      ],
    },
    {
      title: "Interest & terms",
      rows: [
        { k: "Asset type", v: list(deal.assetTypes.map((t) => ASSET_TYPE_LABELS[t] ?? t)) },
        { k: "Royalty rate", v: royaltyLabel(deal.royaltyRate) || null },
        { k: "NMA", v: deal.acreageNma != null ? num(deal.acreageNma) : null },
        { k: "NRA", v: deal.nra != null ? num(deal.nra) : null },
        { k: "Est. closing costs", v: deal.estimatedClosingCosts != null ? money(deal.estimatedClosingCosts) : null },
        { k: "Days to close", v: deal.daysToClose != null ? `${deal.daysToClose} days` : null },
      ],
    },
  ];

  return (
    <div className="panel dd-card ddc-card">
      <div className="dd-card-head">
        <h3 className="dd-card-title">Deal characteristics</h3>
        {edit ? <div className="dd-card-actions"><button className="small" onClick={discard}>Cancel</button><button className="small primary" onClick={save}>Save</button></div>
          : <button className="small" onClick={() => setEdit(true)}>Edit</button>}
      </div>
      {!edit ? (
        <div className="dd-card-body ddc-view">
          {groups.map((g) => (
            <div key={g.title} className="ddc-group">
              <div className="ddc-group-title">{g.title}</div>
              <div className="ddc-rows">
                {g.rows.map((r) => (
                  <div key={r.k} className="ddc-row">
                    <span className="ddc-k">{r.k}</span>
                    <span className={`ddc-v ${r.v ? "" : "dim"}`} title={r.v ?? undefined}>{r.v ?? "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (<div className="dd-card-body">
        <div className="dd-grid">
          <GeoFields
            states={f.states ?? []} onStatesChange={setArr("states")}
            counties={f.counties} onCountiesChange={setArr("counties")}
            abstractIds={f.abstractIds} onAbstractsChange={setArr("abstractIds")}
          />
          <Fld l="Basin"><SearchableMultiSelect options={suggestFirst(TEXAS_BASIN_OPTIONS, basinsForCounties(f.counties))} value={f.basins} onChange={setArr("basins")} placeholder="Search basins…" /></Fld>
          <Fld l="Formation"><SearchableMultiSelect options={suggestFirst(TEXAS_FORMATION_OPTIONS, formationsForCounties(f.counties))} value={f.formations} onChange={setArr("formations")} placeholder="Search formations…" /></Fld>
          <Fld l="Asset type"><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} labels={ASSET_TYPE_LABELS} value={f.assetTypes} onChange={setArr("assetTypes")} placeholder="Search asset types…" /></Fld>
          {/* Operator names run long — give the picker two columns. */}
          <div className="field" style={{ gridColumn: "span 2" }}>
            <label>Operator</label>
            <OperatorSelect states={f.states ?? []} counties={f.counties} value={f.operator ?? ""} onChange={(v) => setF((p) => ({ ...p, operator: v || null }))} />
          </div>
          <Fld l="RRC number">
            <input value={f.rrc ?? ""} onChange={set("rrc")} placeholder="RRC Number" />
          </Fld>
        </div>
        <div className="modal-sec">Economics <span className="modal-sec-hint">· with a royalty rate, NMA and NRA calculate each other; enter any one of a price's total, per NMA or per NRA</span></div>
        <div className="dd-grid">
          <Fld l="Royalty rate">
            <Select value={econ.royaltyRate} onChange={(v) => editAcreage({ royaltyRate: v })} options={royaltyOptions(econ.royaltyRate || null)}
              clearable placeholder="Select royalty rate…" ariaLabel="Royalty rate" />
          </Fld>
          <Fld l="NMA"><input type="number" value={econ.nma} onChange={(e) => editAcreage({ nma: e.target.value })} aria-label="NMA" /><AcreageNote s={econ} field="nma" /></Fld>
          <Fld l="NRA"><input type="number" value={econ.nra} onChange={(e) => editAcreage({ nra: e.target.value })} aria-label="NRA" /><AcreageNote s={econ} field="nra" /></Fld>
          <Fld l="Our cost per NMA"><MoneyInput decimals={2} value={econ.cost.perNma} onChange={editPrice("cost", "perNma")} ariaLabel="Our cost per NMA" placeholder="0.00" /></Fld>
          <Fld l="Our cost per NRA"><MoneyInput decimals={2} value={econ.cost.perNra} onChange={editPrice("cost", "perNra")} ariaLabel="Our cost per NRA" placeholder="0.00" /></Fld>
          <Fld l="Our cost">
            <MoneyInput value={econ.cost.total} onChange={editPrice("cost", "total")} ariaLabel="Our cost" placeholder="0" />
            <PriceNote g={econ.cost} />
          </Fld>
          <Fld l="Asking price per NMA"><MoneyInput decimals={2} value={econ.ask.perNma} onChange={editPrice("ask", "perNma")} ariaLabel="Asking price per NMA" placeholder="0.00" /></Fld>
          <Fld l="Asking price per NRA"><MoneyInput decimals={2} value={econ.ask.perNra} onChange={editPrice("ask", "perNra")} ariaLabel="Asking price per NRA" placeholder="0.00" /></Fld>
          <Fld l="Asking price (to buyers)">
            <MoneyInput value={econ.ask.total} onChange={editPrice("ask", "total")} ariaLabel="Asking price" placeholder="0" />
            <PriceNote g={econ.ask} />
          </Fld>
          <Fld l="Est. closing costs"><MoneyInput value={econ.estimatedClosingCosts} onChange={(v) => setE({ estimatedClosingCosts: v })} ariaLabel="Estimated closing costs" /></Fld>
          <div className="field" style={{ gridColumn: "span 2" }}>
            <label title="Days from Date Under Contract to closing · Find Buyer By gets every day beyond 30">Days to close</label>
            <DaysToCloseField value={econ.daysToClose} onChange={(v) => setE({ daysToClose: v })} />
            {nextClosing && <div className="nd-calc auto">Original closing moves to {fmtDate(nextClosing)}</div>}
          </div>
        </div>
      </div>)}
    </div>
  );
}

/** Compact relative day count for timeline milestones — "today", "13d ago", "in 2d". */
function relDays(iso: string): string {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days === 0) return "today";
  if (days < 0) return `${-days}d ago`;
  return `in ${days}d`;
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

  // Unsaved timeline edits get the standard Save / Discard / Cancel dialog on
  // any navigation attempt.
  useUnsavedSection(
    edit,
    { duc, fbb, oc, fc, cd },
    {
      duc: toInputDate(deal.dateUnderContract), fbb: toInputDate(deal.findBuyerByDate),
      oc: toInputDate(deal.originalClosingDate), fc: toInputDate(deal.finalClosingDate), cd: toInputDate(deal.closedDate),
    },
    save,
    () => setEdit(false),
  );

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
    { label: "Under contract", date: deal.dateUnderContract },
    { label: "Find buyer by", date: deal.findBuyerByDate, overridden: deal.findBuyerByIsOverridden, revertKey: "fbb" },
    { label: "Original closing", date: deal.originalClosingDate },
    { label: "Final closing", date: deal.finalClosingDate, overridden: deal.finalClosingIsOverridden, revertKey: "fc" },
    ...(deal.closedDate || isClosed ? [{ label: "Closed", date: deal.closedDate }] : []),
  ];

  return (
    <div className="panel dd-card ctl-card">
      <div className="dd-card-head">
        <h3 className="dd-card-title">Contract timeline</h3>
        {edit ? <div className="dd-card-actions"><button className="small" onClick={() => setEdit(false)}>Cancel</button><button className="small primary" onClick={save}>Save</button></div>
          : <button className="small" onClick={startEdit}>Edit dates</button>}
      </div>
      <div className="dd-card-body ctl-card-body">
      {noDates && !edit && (
        <p className="muted ctl-empty">
          No dates yet — <strong>Edit dates</strong> and set the Under Contract date; Find Buyer By and Final Closing auto-calculate from it.
        </p>
      )}
      {!edit ? (
        noDates ? null : (
        <div className="ctl">
          {(() => {
            // The first upcoming milestone gets the amber "next up" treatment
            // and a relative-time chip; the rest show quiet relative times.
            const nextLabel = milestones.find((m) => m.date != null && new Date(m.date).getTime() > Date.now())?.label;
            return milestones.map((m) => {
              const done = m.date != null && new Date(m.date).getTime() <= Date.now();
              const isNext = m.label === nextLabel;
              return (
                <div className={`ctl-item ${done ? "done" : ""}`} key={m.label}>
                  <div className="ctl-rail">
                    <span className={`ctl-dot ${done ? "done" : ""} ${isNext ? "next" : ""}`} />
                  </div>
                  <div className="ctl-body ctl-row">
                    <div className="ctl-text">
                      <span className={`ctl-lbl ${done ? "done" : ""} ${isNext ? "next" : ""}`}>{m.label}{m.overridden && <em className="ctl-ovr"> (overridden)</em>}</span>
                      <span className={`ctl-date ${m.date ? "" : "unset"}`}>
                        {m.date ? fmtDate(m.date) : "Not set"}
                        {m.overridden && m.revertKey && <button className="small" onClick={() => revert(m.revertKey!)}>Revert to auto</button>}
                      </span>
                    </div>
                    {m.date && <span className={`ctl-when ${isNext ? "chip" : "pill"}`}>{relDays(m.date)}</span>}
                  </div>
                </div>
              );
            });
          })()}
        </div>
        )
      ) : (
        <div className="dd-grid ctl-edit">
          <Fld l="Under contract"><DateField value={duc} onChange={(v) => setDuc(v)} /></Fld>
          <Fld l="Find buyer by"><DateField value={fbb} onChange={(v) => setFbb(v)} /></Fld>
          <Fld l="Original closing"><DateField value={oc} onChange={(v) => setOc(v)} /></Fld>
          <Fld l="Final closing"><DateField value={fc} onChange={(v) => setFc(v)} /></Fld>
          <Fld l="Closed date"><DateField value={cd} onChange={(v) => setCd(v)} /></Fld>
        </div>
      )}
      </div>
    </div>
  );
}

const PRIORITY_TONE: Record<string, "danger" | "warn" | "success"> = { HIGH: "danger", MEDIUM: "warn", LOW: "success" };
const PRIORITY_TIP = "Priority is computed automatically from deadline proximity and deal stage — e.g. it relaxes once a buyer is selected and the deal moves to closing.";

/** Stage tag tinted with the stage's (customizable, per-pipeline) colour. */
function StageTag({ stage, pipelineId }: { stage: string; pipelineId?: string | null }) {
  const { label, colorOf } = useStages();
  const c = colorOf(stage, pipelineId);
  return <span className="tag dd-stage-tag" style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)` }}>{label(stage)}</span>;
}

/** "Move stage" menu: lists the deal's own pipeline stages; picking one opens
 *  the standard StageChangeModal pre-set to it (reasons, checks and the
 *  Closed / Dead confirmations all still apply). */
function MoveStageMenu({ stage, pipelineId, onPick }: { stage: string; pipelineId?: string | null; onPick: (stage: string) => void }) {
  const { stagesOf } = useStages();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey, true); };
  }, [open]);
  return (
    <div className="ovf dd-stage" ref={ref}>
      <button type="button" className="primary dd-stage-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Move stage <ChevronDown size={13} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open && (
        <div className="ovf-menu dd-stage-menu" role="menu">
          {stagesOf(pipelineId).map((s) => (
            <button key={s.key} type="button" role="menuitem" className={`ovf-item ${s.key === stage ? "current" : ""}`}
              onClick={() => { setOpen(false); onPick(s.key); }}>
              <span>{s.label}</span>
              {s.key === stage && <span className="dd-stage-cur">Current</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Location card: the embedded deal map with its abstracts and imported tracts. */
function LocationCard({ deal }: { deal: DealDetailData }) {
  const abstractLabel = useAbstractLabels(deal.abstractIds);
  const states = deal.states?.length ? deal.states : [deal.state];
  const place = [deal.counties.join(", "), states.filter(Boolean).join(", ")].filter(Boolean).join(", ");
  const sub = [deal.abstractIds.length ? abstractLabel : null, place].filter(Boolean).join(" · ");
  return (
    <div className="panel dd-card dd-location">
      <div className="dd-card-head">
        <div>
          <h3 className="dd-card-title">Location</h3>
          {sub && <div className="dd-card-sub">{sub}</div>}
        </div>
        <span className="dd-card-note">This deal's abstracts, imported tracts, and geographic extent</span>
      </div>
      <div className="dd-card-body">
        <Suspense fallback={<Spinner label="Loading map…" />}><DealMap dealId={deal.id} abstractIds={deal.abstractIds} /></Suspense>
        {deal.abstractIds.length === 0 && (
          <p className="muted dd-location-hint">
            No abstracts linked yet — add them under <strong>Deal characteristics → Edit → Abstract</strong> and the map will draw this deal's extent.
          </p>
        )}
      </div>
    </div>
  );
}

function Fld({ l, children }: { l: string; children: React.ReactNode }) {
  return <div className="field"><label>{l}</label>{children}</div>;
}

/** Rename the deal. The name lives only on the Deal row (every reference joins
 * through the relation), so renaming never touches documents, buyer activity,
 * offers, or history. */
function RenameDealModal({ dealId, current, onClose, onRenamed }: {
  dealId: string; current: string; onClose: () => void; onRenamed: () => void;
}) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const n = name.trim();
    if (!n) { setError("Give the deal a name."); return; }
    if (n === current) { onClose(); return; }
    setBusy(true); setError(null);
    try {
      await api.patch(`/deals/${dealId}`, { name: n });
      showToast("Deal renamed", "success");
      onRenamed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename the deal");
      setBusy(false);
    }
  }
  return (
    <Modal title="Rename deal" onClose={onClose} dirty={name.trim() !== current}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !name.trim()} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <div className="field">
        <label>Deal name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
        The new name shows everywhere this deal is referenced. Documents, buyer activity, offers, and history stay attached.
      </p>
      {error && <Banner kind="error">{error}</Banner>}
    </Modal>
  );
}
