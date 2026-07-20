import { Fragment, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Info, Users } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ConfirmDialog, Modal, Spinner, showToast } from "./ui";
import { CollapsibleSection } from "./CollapsibleSection";
import { CLASS_COLORS } from "../lib/entityClasses";

/**
 * Buyer Profile → Relationships section.
 *
 * The buyer's transaction network derived from all research data, organized for
 * scanning rather than spelunking:
 *  - headline stats + behavioural classification
 *  - alias suggestions (similar research names) that the USER confirms or
 *    dismisses — nothing ever merges automatically
 *  - per-alias attribution so a merged profile keeps its history readable
 *  - Acquired From / Sold To / Co-Buyers — business entities ONLY; individual
 *    people are excluded from the relationship analysis entirely
 *  - acquisition chains as compact expandable rows (endpoints + hop count
 *    collapsed; full path on demand; progressive "show all")
 */

interface RelParty { norm: string; name: string; count: number; entityType: "company" | "individual"; buyerId: string | null }
interface ChainNode { norm: string; name: string; klass: string }
interface ChainHop { fromNorm: string; from: string; toNorm: string; to: string; count: number }
interface ChainEntry {
  chain: { nodes: ChainNode[]; hops: ChainHop[]; length: number; strength: number; totalCount: number; counties: string[] };
  position: number; role: string;
}
interface AliasActivity { norm: string; name: string; acquisitions: number; dispositions: number }
interface Network {
  norm: string; name: string; klass: string; classLabel: string;
  acquisitions: number; dispositions: number;
  topGrantors: RelParty[]; topGrantees: RelParty[]; coBuyers: RelParty[];
  chains: ChainEntry[];
  classLabels: Record<string, string>;
  aliasBreakdown: AliasActivity[];
}
interface AliasSuggestion {
  norm: string; name: string; confidence: number; txCount: number;
  asGrantee: number; asGrantor: number; buyerId: string | null; buyerName: string | null;
}

function ClassBadge({ klass, label }: { klass: string; label: string }) {
  const c = CLASS_COLORS[klass] ?? "#64748b";
  return <span className="badge" style={{ background: `${c}26`, color: c }}>{label}</span>;
}

export function BuyerRelationships({ buyerId }: { buyerId: string }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const [net, setNet] = useState<Network | null>(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [suggestions, setSuggestions] = useState<AliasSuggestion[]>([]);
  const [reviewing, setReviewing] = useState<AliasSuggestion | null>(null);
  const [confirmMerge, setConfirmMerge] = useState<AliasSuggestion | null>(null);
  const [aliasBusy, setAliasBusy] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get<{ network: Network | null; reason?: string }>(`/buyers/${buyerId}/relationships`)
      .then((d) => { setNet(d.network); setReason(d.reason ?? null); })
      .catch(() => { setNet(null); setReason("error"); })
      .finally(() => setLoading(false));
    api.get<{ suggestions: AliasSuggestion[] }>(`/buyers/${buyerId}/alias-suggestions`)
      .then((d) => setSuggestions(d.suggestions))
      .catch(() => setSuggestions([]));
  }, [buyerId, reload]);

  // Create a CRM buyer for a related entity, then refresh so the link appears.
  async function addAsBuyer(p: RelParty) {
    setAdding(p.norm);
    try {
      const { items } = await api.post<{ items: { key: string; outcome: string; existing?: { id: string } }[] }>("/research/buyers/preview", { keys: [p.norm] });
      const it = items[0];
      const decision = it
        ? { key: p.norm, action: it.outcome === "exact" ? "merge" as const : "create" as const, mergeIntoBuyerId: it.existing?.id }
        : { key: p.norm, action: "create" as const };
      await api.post("/research/buyers/commit", { decisions: [decision] });
      setReload((r) => r + 1);
    } catch { /* leave the button; user can retry */ }
    finally { setAdding(null); }
  }

  async function confirmAlias(s: AliasSuggestion) {
    setAliasBusy(true);
    try {
      await api.post(`/buyers/${buyerId}/aliases`, { name: s.name });
      showToast(`"${s.name}" added as an alias — its activity now counts toward this buyer.`);
      setReviewing(null);
      setReload((r) => r + 1);
    } finally { setAliasBusy(false); }
  }
  async function dismissAlias(s: AliasSuggestion) {
    setAliasBusy(true);
    try {
      await api.post(`/buyers/${buyerId}/alias-dismissals`, { norm: s.norm });
      setSuggestions((prev) => prev.filter((x) => x.norm !== s.norm));
      setReviewing(null);
    } finally { setAliasBusy(false); }
  }
  async function mergeBuyer(s: AliasSuggestion) {
    setAliasBusy(true);
    try {
      await api.post(`/buyers/${buyerId}/merge`, { sourceBuyerId: s.buyerId });
      showToast(`Merged "${s.buyerName}" into this buyer — all history preserved under its alias.`);
      setConfirmMerge(null); setReviewing(null);
      setReload((r) => r + 1);
    } finally { setAliasBusy(false); }
  }

  // Collapsed by default like the app's other collapsible sections; loading and
  // empty states live inside the section body so the header never jumps around.
  if (loading) {
    return (
      <CollapsibleSection title="Relationships" sub="Transaction network from research data">
        <Spinner />
      </CollapsibleSection>
    );
  }
  if (!net) {
    return (
      <CollapsibleSection title="Relationships" sub="Transaction network from research data">
        <p className="muted" style={{ margin: 0 }}>
          {reason === "no-activity" || reason === "no-entity-key"
            ? "No transaction relationships found for this buyer in the research data yet. As deed and assignment records are imported, this buyer's grantor/grantee network will appear here automatically."
            : "Relationship analysis is unavailable."}
        </p>
      </CollapsibleSection>
    );
  }

  const canCreate = can("createBuyers");
  const canEdit = can("editBuyers");
  const canMerge = can("deleteBuyers");

  return (
    <>
    <CollapsibleSection
      title="Relationships"
      sub={`${net.acquisitions} acquisitions · ${net.dispositions} dispositions · derived from research records`}
      right={<ClassBadge klass={net.klass} label={net.classLabel} />}
    >
      {/* Stats strip — six figures separated by hairlines (reference layout). */}
      <div className="rel2-stats">
        <RelStat n={net.acquisitions} l="Acquisitions" />
        <RelStat n={net.dispositions} l="Dispositions" />
        <RelStat n={net.topGrantors.length} l="Sources" />
        <RelStat n={net.topGrantees.length} l="Buyers sold to" />
        <RelStat n={net.coBuyers.length} l="Co-buyers" />
        <RelStat n={net.chains.length} l="Chains" />
      </div>

      {/* Provenance note + per-alias attribution share one hairline row. */}
      <div className="rel2-prov">
        <span className="rel2-prov-note">
          <Info size={13} aria-hidden="true" />
          Automatically derived from imported public records. Behavior classified from this buyer's transaction flow.
        </span>
        {net.aliasBreakdown.length > 1 && (
          <span className="rel2-alias-wrap">
            <span className="rel2-label">Activity recorded under</span>
            {net.aliasBreakdown.map((a) => (
              <span key={a.norm} className="rel2-alias-chip" title={`${a.acquisitions} acquisitions · ${a.dispositions} dispositions as "${a.name}"`}>
                {a.name} <span className="rel2-alias-count">{a.acquisitions + a.dispositions}×</span>
              </span>
            ))}
          </span>
        )}
      </div>

      {/* Possible aliases — user reviews and confirms; never merged automatically. */}
      {canEdit && suggestions.length > 0 && (
        <div className="rel-alias-callout">
          <div className="rel-alias-head">
            <strong>Possible aliases detected</strong>
            <span className="muted" style={{ fontSize: 12 }}>Similar names in the research data — review each before it counts toward this buyer.</span>
          </div>
          {suggestions.map((s) => (
            <div key={s.norm} className="rel-alias-row">
              <span className="rel-alias-name">{s.name}</span>
              <span className="muted rel-alias-meta">
                {Math.round(s.confidence * 100)}% match · {s.txCount} transaction{s.txCount === 1 ? "" : "s"}
                {s.buyerId && <> · existing buyer</>}
              </span>
              <button className="small" onClick={() => setReviewing(s)}>Review</button>
            </div>
          ))}
        </div>
      )}

      <div className="rel2-cols">
        <PartyColumn title="Acquired From" tone="up" empty="No recorded acquisitions." parties={net.topGrantors}
          canCreate={canCreate} adding={adding} onAdd={addAsBuyer} onOpen={(p) => p.buyerId && nav(`/buyers/${p.buyerId}`)} />
        <PartyColumn title="Sold To" tone="down" empty="No recorded dispositions." parties={net.topGrantees}
          canCreate={canCreate} adding={adding} onAdd={addAsBuyer} onOpen={(p) => p.buyerId && nav(`/buyers/${p.buyerId}`)} />
        <PartyColumn title="Frequent Co-Buyers" tone="co" empty="No shared acquisitions found." parties={net.coBuyers}
          canCreate={canCreate} adding={adding} onAdd={addAsBuyer} onOpen={(p) => p.buyerId && nav(`/buyers/${p.buyerId}`)} />
      </div>
    </CollapsibleSection>

    {/* Acquisition Chains — its own dedicated section, independent from
        Relationships, collapsed by default like the other profile sections. */}
    {net.chains.length > 0 && (
      <CollapsibleSection
        title="Acquisition Chains"
        sub={`${net.chains.length} path${net.chains.length === 1 ? "" : "s"} through the transaction network, strongest first`}
      >
        <ChainSection chains={net.chains} classLabels={net.classLabels} focusNorm={net.norm} />
      </CollapsibleSection>
    )}

    <>
      {reviewing && !confirmMerge && (
        <Modal title="Review possible alias" onClose={() => setReviewing(null)}
          footer={<>
            <button disabled={aliasBusy} onClick={() => dismissAlias(reviewing)}>Not the same — dismiss</button>
            {reviewing.buyerId
              ? canMerge && <button className="primary" disabled={aliasBusy} onClick={() => setConfirmMerge(reviewing)}>Merge profiles…</button>
              : <button className="primary" disabled={aliasBusy} onClick={() => confirmAlias(reviewing)}>{aliasBusy ? "Confirming…" : "Confirm alias"}</button>}
          </>}>
          <p style={{ marginTop: 0 }}>
            <strong>{reviewing.name}</strong> looks like it may be the same entity as this buyer
            (<strong>{Math.round(reviewing.confidence * 100)}%</strong> name similarity).
          </p>
          <div className="dd-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="kv"><span className="k">As buyer (grantee)</span><span className="v">{reviewing.asGrantee} transaction{reviewing.asGrantee === 1 ? "" : "s"}</span></div>
            <div className="kv"><span className="k">As seller (grantor)</span><span className="v">{reviewing.asGrantor} transaction{reviewing.asGrantor === 1 ? "" : "s"}</span></div>
          </div>
          {reviewing.buyerId ? (
            <p className="muted" style={{ fontSize: 13 }}>
              This name already has its own buyer profile (<strong>{reviewing.buyerName}</strong>). Merging folds that
              profile into this one — every transaction, chain, offer, document, and note is preserved, attributed to
              the alias it happened under.
            </p>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>
              Confirming records "{reviewing.name}" as an alias of this buyer: its research activity (acquisitions,
              dispositions, chains, partners) is folded into this profile while each transaction keeps the name it was
              recorded under. This does not change the research records themselves.
            </p>
          )}
        </Modal>
      )}
      {confirmMerge && (
        <ConfirmDialog
          title={`Merge "${confirmMerge.buyerName}" into this buyer?`}
          confirmLabel={aliasBusy ? "Merging…" : "Merge profiles"}
          busy={aliasBusy}
          onCancel={() => setConfirmMerge(null)}
          onConfirm={() => mergeBuyer(confirmMerge)}
          message={
            <p style={{ marginTop: 0 }}>
              All of <strong>{confirmMerge.buyerName}</strong>'s history — deal activity, timelines, offers, documents,
              tags, and research insights — moves to this profile, and its name becomes an alias here so historical
              transactions stay attributed to it. The separate profile is then removed. This cannot be undone.
            </p>
          }
        />
      )}
    </>
    </>
  );
}

function RelStat({ n, l }: { n: number; l: string }) {
  return (
    <div className="rel2-stat">
      <div className={`rel2-stat-n ${n === 0 ? "zero" : ""}`}>{n}</div>
      <div className="rel2-stat-l">{l}</div>
    </div>
  );
}

/**
 * A ranked counterparty column (reference design: icon-led uppercase heading,
 * hairline-divided rows with a mini distribution bar, mono count, and the
 * "+ Buyer" action pill). Business entities only — the server excludes
 * individual people from the relationship analysis, and there is deliberately
 * no way to reveal them here.
 */
function PartyColumn({ title, tone, empty, parties, canCreate, adding, onAdd, onOpen }: {
  title: string; tone: "up" | "down" | "co"; empty: string; parties: RelParty[];
  canCreate: boolean; adding: string | null; onAdd: (p: RelParty) => void; onOpen: (p: RelParty) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  // Defense in depth: even if the API ever sends individuals, never show them.
  const companies = useMemo(() => parties.filter((p) => p.entityType !== "individual"), [parties]);
  const max = Math.max(1, ...companies.map((p) => p.count));
  const CAP = 8;
  const icon = tone === "up" ? <ArrowUp size={13} className="rel2-ic-up" aria-hidden="true" />
    : tone === "down" ? <ArrowDown size={13} className="rel2-ic-down" aria-hidden="true" />
      : <Users size={13} className="rel2-ic-co" aria-hidden="true" />;

  const Row = ({ p }: { p: RelParty }) => (
    <div className="rel2-row">
      <button className={`rel2-name ${p.buyerId ? "link" : ""}`} disabled={!p.buyerId} onClick={() => onOpen(p)} title={p.buyerId ? "Open buyer profile" : p.name}>
        {p.name}
      </button>
      <span className="rel2-bar" aria-hidden="true"><span style={{ width: `${Math.max(8, (p.count / max) * 100)}%` }} /></span>
      <span className="rel2-count">{p.count}×</span>
      {!p.buyerId && canCreate && (
        <button className="rel2-add" disabled={adding === p.norm} onClick={() => onAdd(p)}>
          {adding === p.norm ? "Adding…" : "+ Buyer"}
        </button>
      )}
    </div>
  );

  const visible = showAll ? companies : companies.slice(0, CAP);
  return (
    <div className="rel2-col">
      <div className="rel2-col-head">{icon}<span className="rel2-label">{title}</span></div>
      {companies.length === 0 ? (
        <div className="rel2-empty"><Users size={20} aria-hidden="true" /><span>{empty}</span></div>
      ) : (
        <div className="rel2-list">
          {visible.map((p) => <Row key={p.norm} p={p} />)}
          {companies.length > CAP && (
            <button className="link-btn" style={{ marginTop: 6 }} onClick={() => setShowAll((s) => !s)}>
              {showAll ? "Show fewer" : `Show all ${companies.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Acquisition chains, built to scale: each chain collapses to its endpoints +
 * hop count (one readable line however long the path), expands to the full
 * path on click, and only the strongest few show until "Show all".
 */
function ChainSection({ chains, classLabels, focusNorm }: { chains: ChainEntry[]; classLabels: Record<string, string>; focusNorm: string }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  if (chains.length === 0) return null;
  const CAP = 5;
  const visible = showAll ? chains : chains.slice(0, CAP);

  // The section header (title, count) is provided by the CollapsibleSection
  // wrapping this list on the Buyer Profile.
  return (
    <div className="chain2-list">
      {visible.map((c, i) => {
        const open = openIdx === i;
        const len = c.chain.nodes.length;
        const first = c.chain.nodes[0], last = c.chain.nodes[len - 1];
        return (
          <div key={i} className={`chain2 ${open ? "open" : ""}`}>
            <button type="button" className="chain2-head" onClick={() => setOpenIdx(open ? null : i)} aria-expanded={open}>
              <span className={`chain2-rank ${open ? "hot" : ""}`}>#{i + 1}</span>
              <span className="chain2-endpoints">
                <NodeBadge n={first} focus={first.norm === focusNorm} />
                <span className="chain2-mid">→ {len - 2 > 0 && <b>{len - 2} more</b>} →</span>
                <NodeBadge n={last} focus={last.norm === focusNorm} />
              </span>
              <span className="chain2-meta">
                <span className="chain2-sum"><b>{len}</b> entities · <b>{c.chain.totalCount}</b> tx</span>
                {c.chain.counties.length > 0 && (
                  <span className="chain2-counties">{c.chain.counties.slice(0, 2).join(" · ")}{c.chain.counties.length > 2 ? "…" : ""}</span>
                )}
                <span className={`va-chev ${open ? "" : "down"}`}>⌃</span>
              </span>
            </button>
            {open && (
              <div className="chain2-body">
                {/* Horizontal node flow: every entity a labeled box, dashed
                    tx-count arrows between hops, the focus buyer ringed. */}
                <div className="chain2-flow">
                  {c.chain.nodes.map((n, j) => (
                    <Fragment key={n.norm}>
                      <div className="chain2-node">
                        <NodeBox n={n} focus={j === c.position} />
                        <span className={`chain2-cap ${j === c.position ? "focus" : ""}`}>
                          {j === c.position ? `This buyer · ${j + 1} of ${len}`
                            : j === 0 ? "Origin"
                              : j === len - 1 ? "Terminus"
                                : `${j + 1} of ${len}`}
                        </span>
                      </div>
                      {j < len - 1 && (
                        <div className="chain2-arrow" title={`${c.chain.hops[j]?.count ?? 0} transactions`}>
                          <span>{c.chain.hops[j]?.count ?? 0} tx</span>
                          <svg width="52" height="10" viewBox="0 0 52 10" fill="none" aria-hidden="true">
                            <line x1="0" y1="5" x2="46" y2="5" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="3 3" />
                            <path d="M46 1.5L51 5l-5 3.5z" fill="var(--accent)" />
                          </svg>
                        </div>
                      )}
                    </Fragment>
                  ))}
                </div>
                <div className="chain2-info">
                  <Info size={13} aria-hidden="true" />
                  <span>
                    This buyer is the <strong>{classLabels[c.role] ?? c.role}</strong> at position <b>{c.position + 1} of {len}</b>
                    {c.chain.counties.length > 0 && <> · {c.chain.counties.join(", ")}</>}
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {chains.length > CAP && (
        <div className="chain2-foot">
          <button className="link-btn" onClick={() => { setShowAll((s) => !s); setOpenIdx(null); }}>
            {showAll ? "Show strongest only" : `Show all ${chains.length} chains`}
          </button>
          <span className="muted" style={{ fontSize: 11.5 }}>
            {showAll ? `Showing all ${chains.length}` : `Showing ${Math.min(CAP, chains.length)} strongest of ${chains.length}`}
          </span>
        </div>
      )}
    </div>
  );
}

/** Endpoint pill in a chain's summary row — tinted by the entity's class. */
function NodeBadge({ n, focus }: { n: ChainNode; focus: boolean }) {
  const c = CLASS_COLORS[n.klass] ?? "#64748b";
  return (
    <span className={`chain2-pill ${focus ? "focus" : ""}`}
      style={focus ? undefined : { background: `${c}1f`, borderColor: `${c}55`, color: c }}>
      {n.name}
    </span>
  );
}

/** Node box in the expanded flow — neutral card, accent ring on the focus buyer. */
function NodeBox({ n, focus }: { n: ChainNode; focus: boolean }) {
  const c = CLASS_COLORS[n.klass] ?? "#64748b";
  return (
    <span className={`chain2-box ${focus ? "focus" : ""}`} style={focus ? undefined : { borderColor: `${c}55` }} title={n.name}>
      {n.name}
    </span>
  );
}
