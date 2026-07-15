import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ConfirmDialog, Modal, Spinner, showToast } from "./ui";
import { NetworkGraph, CLASS_COLORS, type GraphNode, type GraphEdge } from "./NetworkGraph";

/**
 * Buyer Profile → Relationships section.
 *
 * The buyer's transaction network derived from all research data, organized for
 * scanning rather than spelunking:
 *  - headline stats + behavioural classification
 *  - alias suggestions (similar research names) that the USER confirms or
 *    dismisses — nothing ever merges automatically
 *  - per-alias attribution so a merged profile keeps its history readable
 *  - Acquired From / Sold To with business entities ranked first and
 *    individual sellers tucked behind a disclosure
 *  - acquisition chains as compact expandable rows (endpoints + hop count
 *    collapsed; full path on demand; progressive "show all")
 *  - an optional interactive network map of the direct neighbourhood
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
  graph: { nodes: (GraphNode & { buyerId?: string | null })[]; edges: GraphEdge[] };
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
  const [showGraph, setShowGraph] = useState(false);

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

  if (loading) return <div className="panel"><h3>Relationships</h3><Spinner /></div>;
  if (!net) {
    return (
      <div className="panel">
        <h3>Relationships</h3>
        <p className="muted" style={{ marginBottom: 0 }}>
          {reason === "no-activity" || reason === "no-entity-key"
            ? "No transaction relationships found for this buyer in the research data yet. As deed and assignment records are imported, this buyer's grantor/grantee network will appear here automatically."
            : "Relationship analysis is unavailable."}
        </p>
      </div>
    );
  }

  const canCreate = can("createBuyers");
  const canEdit = can("editBuyers");
  const canMerge = can("deleteBuyers");

  return (
    <div className="panel">
      {/* Headline: who this buyer is in the network, at a glance. */}
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Relationships</h3>
        <ClassBadge klass={net.klass} label={net.classLabel} />
      </div>
      <div className="rel-stats">
        <RelStat n={net.acquisitions} l="Acquisitions" />
        <RelStat n={net.dispositions} l="Dispositions" />
        <RelStat n={net.topGrantors.length} l="Sources" />
        <RelStat n={net.topGrantees.length} l="Buyers sold to" />
        <RelStat n={net.coBuyers.length} l="Co-buyers" />
        <RelStat n={net.chains.length} l="Chains" />
      </div>
      <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
        Automatically derived from imported public records. Behavior classified from this buyer's transaction flow.
      </p>

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

      {/* Per-alias attribution: which historical name did what. */}
      {net.aliasBreakdown.length > 1 && (
        <div className="rel-alias-attr">
          <span className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em" }}>Activity recorded under</span>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {net.aliasBreakdown.map((a) => (
              <span key={a.norm} className="chip-mini rel-alias-chip" title={`${a.acquisitions} acquisitions · ${a.dispositions} dispositions as "${a.name}"`}>
                {a.name} <span className="muted">{a.acquisitions + a.dispositions}×</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="rel-columns">
        <PartyColumn title="Acquired From" empty="No recorded acquisitions." parties={net.topGrantors}
          grouped canCreate={canCreate} adding={adding} onAdd={addAsBuyer} onOpen={(p) => p.buyerId && nav(`/buyers/${p.buyerId}`)} />
        <PartyColumn title="Sold To" empty="No recorded dispositions." parties={net.topGrantees}
          grouped canCreate={canCreate} adding={adding} onAdd={addAsBuyer} onOpen={(p) => p.buyerId && nav(`/buyers/${p.buyerId}`)} />
        <PartyColumn title="Frequent Co-Buyers" empty="No shared acquisitions found." parties={net.coBuyers}
          canCreate={canCreate} adding={adding} onAdd={addAsBuyer} onOpen={(p) => p.buyerId && nav(`/buyers/${p.buyerId}`)} />
      </div>

      <ChainSection chains={net.chains} classLabels={net.classLabels} focusNorm={net.norm} />

      {/* Interactive neighbourhood map — heavier, so opt-in. */}
      {net.graph.nodes.length > 1 && (
        <div style={{ marginTop: 14 }}>
          <button className="small" onClick={() => setShowGraph((s) => !s)} aria-expanded={showGraph}>
            {showGraph ? "Hide network map" : "Show network map"}
          </button>
          {showGraph && (
            <NetworkGraph
              nodes={net.graph.nodes} edges={net.graph.edges} focusNorm={net.norm} height={380}
              onNodeClick={(n) => { const b = (n as GraphNode & { buyerId?: string | null }).buyerId; if (b) nav(`/buyers/${b}`); }}
            />
          )}
        </div>
      )}

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
    </div>
  );
}

function RelStat({ n, l }: { n: number; l: string }) {
  return <span className="rel-stat"><strong>{n}</strong> {l}</span>;
}

/**
 * A ranked counterparty column. With `grouped`, business entities lead (the
 * point is company-to-company activity) and individual sellers collapse behind
 * a disclosure so they never dominate the list.
 */
function PartyColumn({ title, empty, parties, grouped = false, canCreate, adding, onAdd, onOpen }: {
  title: string; empty: string; parties: RelParty[]; grouped?: boolean;
  canCreate: boolean; adding: string | null; onAdd: (p: RelParty) => void; onOpen: (p: RelParty) => void;
}) {
  const [showIndividuals, setShowIndividuals] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const companies = useMemo(() => (grouped ? parties.filter((p) => p.entityType === "company") : parties), [parties, grouped]);
  const individuals = useMemo(() => (grouped ? parties.filter((p) => p.entityType === "individual") : []), [parties, grouped]);
  const max = Math.max(1, ...parties.map((p) => p.count));
  const CAP = 8;

  const Row = ({ p }: { p: RelParty }) => (
    <div className="rel-party-row">
      <button className={`rel-party-name ${p.buyerId ? "link" : ""}`} disabled={!p.buyerId} onClick={() => onOpen(p)} title={p.buyerId ? "Open buyer profile" : p.name}>
        {p.name}
      </button>
      <span className="rel-party-meta">
        <span className="rel-bar" aria-hidden="true"><span style={{ width: `${Math.max(8, (p.count / max) * 100)}%` }} /></span>
        <span className="rel-count-mini">{p.count}×</span>
        {!p.buyerId && canCreate && (
          <button className="small" disabled={adding === p.norm} onClick={() => onAdd(p)}>
            {adding === p.norm ? "Adding…" : "+ Buyer"}
          </button>
        )}
      </span>
    </div>
  );

  const visible = showAll ? companies : companies.slice(0, CAP);
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>{title}</div>
      {parties.length === 0 ? <p className="muted" style={{ margin: 0 }}>{empty}</p> : (
        <div className="rel-party-list">
          {visible.map((p) => <Row key={p.norm} p={p} />)}
          {companies.length > CAP && (
            <button className="link-btn" onClick={() => setShowAll((s) => !s)}>
              {showAll ? "Show fewer" : `Show all ${companies.length}`}
            </button>
          )}
          {individuals.length > 0 && (
            <>
              <button className="link-btn rel-indiv-toggle" onClick={() => setShowIndividuals((s) => !s)} aria-expanded={showIndividuals}>
                {showIndividuals ? "▾" : "▸"} {individuals.length} individual seller{individuals.length === 1 ? "" : "s"}
              </button>
              {showIndividuals && individuals.slice(0, 20).map((p) => <Row key={p.norm} p={p} />)}
            </>
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

  return (
    <div style={{ marginTop: 14 }}>
      <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>
        Acquisition Chains <span style={{ textTransform: "none", letterSpacing: 0 }}>· {chains.length} path{chains.length === 1 ? "" : "s"}, strongest first</span>
      </div>
      <div className="rel-chain-list">
        {visible.map((c, i) => {
          const open = openIdx === i;
          const first = c.chain.nodes[0], last = c.chain.nodes[c.chain.nodes.length - 1];
          return (
            <div key={i} className={`rel-chain ${open ? "open" : ""}`}>
              <button type="button" className="rel-chain-head" onClick={() => setOpenIdx(open ? null : i)} aria-expanded={open}>
                <span className="rel-chain-endpoints">
                  <NodeBadge n={first} focus={first.norm === focusNorm} />
                  <span className="muted rel-chain-mid">→ {c.chain.nodes.length - 2 > 0 ? `${c.chain.nodes.length - 2} more` : ""} →</span>
                  <NodeBadge n={last} focus={last.norm === focusNorm} />
                </span>
                <span className="muted rel-chain-sum">
                  {c.chain.nodes.length} entities · {c.chain.totalCount} tx
                  {c.chain.counties.length > 0 && <> · {c.chain.counties.slice(0, 2).join(", ")}{c.chain.counties.length > 2 ? "…" : ""}</>}
                </span>
                <span className={`va-chev ${open ? "" : "down"}`}>⌃</span>
              </button>
              {open && (
                <div className="rel-chain-body">
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {c.chain.nodes.map((n, j) => (
                      <span key={n.norm} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <NodeBadge n={n} focus={j === c.position} />
                        {j < c.chain.nodes.length - 1 && <span className="muted" title={`${c.chain.hops[j]?.count} transactions`}>—{c.chain.hops[j]?.count}→</span>}
                      </span>
                    ))}
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 5 }}>
                    This buyer is the <strong>{classLabels[c.role] ?? c.role}</strong> at position {c.position + 1} of {c.chain.nodes.length}
                    {c.chain.counties.length > 0 && <> · {c.chain.counties.join(", ")}</>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {chains.length > CAP && (
        <button className="link-btn" style={{ marginTop: 6 }} onClick={() => { setShowAll((s) => !s); setOpenIdx(null); }}>
          {showAll ? "Show strongest only" : `Show all ${chains.length} chains`}
        </button>
      )}
    </div>
  );
}

function NodeBadge({ n, focus }: { n: ChainNode; focus: boolean }) {
  const c = CLASS_COLORS[n.klass] ?? "#64748b";
  return (
    <span className="badge" style={{ background: `${c}26`, color: c, outline: focus ? "2px solid var(--accent)" : "none" }}>
      {n.name}
    </span>
  );
}
