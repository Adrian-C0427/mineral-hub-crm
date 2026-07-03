import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  Spinner, PriorityBadge, StageBadge, MetricCard,
  MatchPercentBadge, MatchBar, Banner, ConfirmDelete,
} from "../components/ui";
import { SortableTable, type Column } from "../components/SortableTable";
import { StageChangeModal } from "../components/StageChangeModal";
import { LogContactModal } from "../components/LogContactModal";
import { BuyerActivitySection } from "../components/BuyerActivitySection";
import { SendDealEmailModal } from "../components/SendDealEmailModal";
import { AbstractMultiPicker, useAbstractLabels } from "../components/AbstractPicker";
import { SearchableMultiSelect } from "../components/SearchableMultiSelect";
import { TEXAS_COUNTY_OPTIONS, TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS } from "../lib/options";
import { operatorsForCounties } from "../lib/operators";
import { money, num, fmtDate, toInputDate } from "../lib/format";
import { downloadCsv } from "../lib/csv";
import { SellerDetails } from "../components/SellerDetails";
import type { BuyerActivityRow, DealSummary, MatchRec, Seller, UserLite } from "../types";
// MapLibre is heavy; only load it when a deal detail page is viewed.
const DealMap = lazy(() => import("../components/DealMap").then((m) => ({ default: m.DealMap })));

interface DealDetailData extends DealSummary {
  operator: string | null;
  notes: string | null;
  sellerNames: string[];
  deadReason: string | null;
  buyerActivity: BuyerActivityRow[];
  offers: { id: string; buyer: { id: string; name: string }; amount: number; status: string; conditions: string | null; expirationDate: string | null; dateSubmitted: string }[];
  files: DocFile[];
  sellers: Seller[];
  canViewTaxId: boolean;
  metrics: { buyersContacted: number; interested: number; offers: number; highOffer: number | null };
}

interface DocFile {
  id: string; category: string; folder: string; filename: string; mimeType: string;
  sizeBytes: number; uploadedBy: string | null; createdAt: string; updatedAt: string; versionCount: number;
}

// Default document folders. `folder` is a free string server-side, so this list
// can grow (or become org-configurable) without any schema/route change.
const DOC_FOLDERS = ["Seller PSA", "Wholesale PSA", "Check Stubs", "Division Orders", "Deeds", "Title", "Other"];

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

  const loadDeal = useCallback(() => api.get<DealDetailData>(`/deals/${id}`).then(setDeal), [id]);
  const loadMatches = useCallback(() => api.get<MatchRec[]>(`/deals/${id}/matches`).then(setMatches), [id]);

  useEffect(() => {
    loadDeal(); loadMatches();
    api.get<UserLite[]>("/users").then(setUsers).catch(() => {});
  }, [loadDeal, loadMatches]);

  if (!deal) return <Spinner />;

  const refreshAll = () => { loadDeal(); loadMatches(); };
  const hasUnresolved = deal.buyerActivity.some((a) => a.status === "CONTACTED");

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
          {can("deleteDeals") && <button className="danger" onClick={() => setConfirmDelete(true)}>Delete</button>}
          <button className="primary" onClick={() => setShowStage(true)}>Move Stage</button>
        </div>
      </div>

      {deal.stage === "DEAD" && deal.deadReason && <Banner kind="error">Dead: {deal.deadReason}</Banner>}

      <div className="grid-2">
        <CharacteristicsCard deal={deal} onSaved={refreshAll} />
        <ContractTimelineCard deal={deal} onSaved={loadDeal} />
      </div>

      <SellerDetails
        dealId={deal.id}
        sellers={deal.sellers ?? []}
        users={users}
        canEdit={can("editDeals")}
        onChanged={loadDeal}
      />

      {/* Embedded, isolated map showing only this deal's extent */}
      <div className="panel">
        <div className="section-head"><h3>Location</h3><span className="muted">This deal's abstracts and geographic extent</span></div>
        <Suspense fallback={<Spinner label="Loading map…" />}><DealMap abstractIds={deal.abstractIds} /></Suspense>
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

      {/* Buyer Activity — expandable per-buyer relationship + timeline */}
      <div className="panel">
        <div className="section-head"><h3>Buyer Activity</h3><span className="muted">Every buyer's status, notes, and full communication history on this deal</span></div>
        <BuyerActivitySection
          dealId={deal.id}
          rows={deal.buyerActivity}
          onChanged={refreshAll}
          onEdit={(r) => setLogBuyer({ id: r.buyerId, name: r.buyerName, initial: { status: r.status, assignedTeamMemberId: r.assignedTeamMember?.id ?? null, notes: r.notes, dateSent: r.dateSent, nextFollowUpDate: r.nextFollowUpDate } })}
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
                  {can("editDeals") && <button className="small" onClick={() => setLogBuyer({ id: m.buyerId, name: m.buyerName })}>Log contact</button>}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Documents */}
      <DocumentsSection dealId={deal.id} files={deal.files} onChanged={loadDeal} canEdit={can("editDeals")} canDelete={can("deleteDeals")} />

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
    </div>
  );
}

function CharacteristicsCard({ deal, onSaved }: { deal: DealDetailData; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(deal);
  const abstractLabel = useAbstractLabels(deal.abstractIds);
  useEffect(() => setF(deal), [deal]);

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
      state: f.state, counties: f.counties, basins: f.basins, formations: f.formations,
      assetTypes: f.assetTypes, acreageNma: f.acreageNma, nra: f.nra, abstractIds: f.abstractIds, askPrice: f.askPrice, ourPrice: f.ourPrice, operator: f.operator,
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
          <KV k="NRA" v={num(deal.nra)} /><KV k="Our Price" v={money(deal.ourPrice)} /><KV k="Ask Price (to buyers)" v={money(deal.askPrice)} /><KV k="Operator" v={deal.operator} />
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
          <Fld l="Abstract"><AbstractMultiPicker value={f.abstractIds} counties={f.counties} onChange={setArr("abstractIds")} /></Fld>
        </div>
      )}
    </div>
  );
}

function ContractTimelineCard({ deal, onSaved }: { deal: DealDetailData; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [duc, setDuc] = useState("");
  const [fbb, setFbb] = useState("");
  const [oc, setOc] = useState("");
  const [fc, setFc] = useState("");

  function startEdit() {
    setDuc(toInputDate(deal.dateUnderContract));
    setFbb(toInputDate(deal.findBuyerByDate));
    setOc(toInputDate(deal.originalClosingDate));
    setFc(toInputDate(deal.finalClosingDate));
    setEdit(true);
  }

  async function save() {
    const patch: Record<string, unknown> = {};
    // Only send changed fields. FBB/FC become overrides; DUC/OC are direct.
    if (duc !== toInputDate(deal.dateUnderContract)) patch.dateUnderContract = duc || null;
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
          <Fld l="Under Contract"><input type="date" value={duc} onChange={(e) => setDuc(e.target.value)} /></Fld>
          <Fld l="Find Buyer By"><input type="date" value={fbb} onChange={(e) => setFbb(e.target.value)} /></Fld>
          <Fld l="Orig. Closing"><input type="date" value={oc} onChange={(e) => setOc(e.target.value)} /></Fld>
          <Fld l="Final Closing"><input type="date" value={fc} onChange={(e) => setFc(e.target.value)} /></Fld>
        </div>
      )}
    </div>
  );
}

/** Human file size and a short type label (from extension, else mime subtype). */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function fileType(f: DocFile): string {
  const ext = f.filename.includes(".") ? f.filename.split(".").pop()!.toUpperCase() : "";
  if (ext && ext.length <= 5) return ext;
  return (f.mimeType.split("/")[1] || f.mimeType || "file").toUpperCase();
}
const isPreviewable = (f: DocFile) => f.mimeType === "application/pdf" || f.mimeType.startsWith("image/");

function DocumentsSection({ dealId, files, onChanged, canEdit, canDelete }: { dealId: string; files: DocFile[]; onChanged: () => void; canEdit: boolean; canDelete: boolean }) {
  const [folder, setFolder] = useState(DOC_FOLDERS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceId = useRef<string | null>(null);

  // Folders = the defaults, plus any folder already present that isn't a default.
  const folders = useMemo(() => {
    const present = new Set(files.map((f) => f.folder || "Other"));
    return [...DOC_FOLDERS, ...[...present].filter((p) => !DOC_FOLDERS.includes(p)).sort()];
  }, [files]);
  const countByFolder = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of files) m.set(f.folder || "Other", (m.get(f.folder || "Other") ?? 0) + 1);
    return m;
  }, [files]);
  const inFolder = useMemo(() => files.filter((f) => (f.folder || "Other") === folder), [files, folder]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }
  const upload = (file: File) => run(async () => {
    const form = new FormData();
    form.append("file", file); form.append("dealId", dealId); form.append("folder", folder);
    await api.upload("/files", form);
  });
  const replace = (file: File) => run(async () => {
    const form = new FormData(); form.append("file", file);
    await api.upload(`/files/${replaceId.current}/replace`, form);
  });
  const rename = (f: DocFile) => {
    const filename = window.prompt("Rename document", f.filename);
    if (filename && filename.trim() && filename !== f.filename) run(() => api.patch(`/files/${f.id}`, { filename: filename.trim() }));
  };
  const move = (f: DocFile, toFolder: string) => { if (toFolder !== f.folder) run(() => api.patch(`/files/${f.id}`, { folder: toFolder })); };
  const open = async (id: string, inline: boolean) => {
    const { url } = await api.get<{ url: string }>(`/files/${id}/download${inline ? "?inline=1" : ""}`);
    window.open(url, "_blank");
  };

  const columns: Column<DocFile>[] = [
    {
      key: "filename", header: "Document Name", value: (f) => f.filename.toLowerCase(),
      render: (f) => <span title={f.filename}>{f.filename}{f.versionCount > 0 && <span className="chip-mini" style={{ marginLeft: 6 }} title={`${f.versionCount} previous version(s)`}>v{f.versionCount + 1}</span>}</span>,
    },
    { key: "createdAt", header: "Date Uploaded", type: "date", value: (f) => f.createdAt, render: (f) => fmtDate(f.createdAt) },
    { key: "updatedAt", header: "Date Modified", type: "date", value: (f) => f.updatedAt, render: (f) => fmtDate(f.updatedAt) },
    { key: "uploadedBy", header: "Uploaded By", value: (f) => f.uploadedBy ?? "" , render: (f) => f.uploadedBy ?? "—" },
    { key: "type", header: "File Type", value: (f) => fileType(f) },
    { key: "sizeBytes", header: "File Size", align: "right", value: (f) => f.sizeBytes, render: (f) => humanSize(f.sizeBytes) },
    {
      key: "actions", header: "", value: () => "", align: "right", width: "1%",
      render: (f) => (
        <div className="row" style={{ gap: 4, justifyContent: "flex-end", flexWrap: "nowrap" }}>
          {isPreviewable(f) && <button className="small" onClick={() => open(f.id, true)}>Preview</button>}
          <button className="small" onClick={() => open(f.id, false)}>Download</button>
          {canEdit && <button className="small" onClick={() => rename(f)}>Rename</button>}
          {canEdit && (
            <select value={f.folder || "Other"} title="Move to folder" style={{ width: "auto", padding: "4px 6px" }}
              onChange={(e) => move(f, e.target.value)}>
              {folders.map((fl) => <option key={fl} value={fl}>{fl === (f.folder || "Other") ? fl : `Move → ${fl}`}</option>)}
            </select>
          )}
          {canEdit && <button className="small" onClick={() => { replaceId.current = f.id; replaceRef.current?.click(); }}>Replace</button>}
          {canDelete && <button className="small danger" onClick={() => run(() => api.del(`/files/${f.id}`))}>Delete</button>}
        </div>
      ),
    },
  ];

  return (
    <div className="panel">
      <div className="section-head"><h3>Documents</h3><span className="muted">Organized by folder · sortable</span></div>

      <div className="dm-toolbar" style={{ background: "transparent", border: "none", padding: 0 }}>
        {folders.map((fl) => (
          <span key={fl} className={`chip ${folder === fl ? "active" : ""}`} onClick={() => setFolder(fl)}>
            {fl} <span className="muted" style={{ marginLeft: 4 }}>{countByFolder.get(fl) ?? 0}</span>
          </span>
        ))}
      </div>

      <div className="row" style={{ margin: "12px 0", justifyContent: "space-between" }}>
        <strong>{folder}</strong>
        {canEdit && (
          <label className="chip" style={{ margin: 0 }}>
            {busy ? "Working…" : `Upload to ${folder}`}
            <input ref={uploadRef} type="file" style={{ display: "none" }} disabled={busy}
              onChange={(e) => { if (e.target.files?.[0]) upload(e.target.files[0]); e.target.value = ""; }} />
          </label>
        )}
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      {inFolder.length === 0 ? (
        <p className="muted">No documents in {folder}.</p>
      ) : (
        <SortableTable columns={columns} rows={inFolder} rowKey={(f) => f.id} defaultSort={{ key: "createdAt", dir: "desc" }} />
      )}

      {/* Hidden input used by per-row Replace buttons. */}
      <input ref={replaceRef} type="file" style={{ display: "none" }}
        onChange={(e) => { if (e.target.files?.[0]) replace(e.target.files[0]); e.target.value = ""; }} />
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v || "—"}</span></div>;
}
function Fld({ l, children }: { l: string; children: React.ReactNode }) {
  return <div className="field"><label>{l}</label>{children}</div>;
}
