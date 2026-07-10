import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner } from "./ui";
import { CLASS_COLORS, type GraphNode, type GraphEdge } from "./NetworkGraph";

/**
 * Buyer Profile → Relationships section.
 *
 * Summarises the buyer's transaction network derived from all research data:
 * top grantors it acquired from, top grantees it sold to, frequent co-buyers,
 * acquisition chains it participates in, its behavioural classification, and a
 * network graph of its direct relationships. Every related entity is
 * interactive — clicking navigates to its Buyer Profile when one exists, or
 * offers to create one (with duplicate checking handled server-side).
 */

interface RelParty { norm: string; name: string; count: number; buyerId: string | null }
interface ChainNode { norm: string; name: string; klass: string }
interface ChainHop { fromNorm: string; from: string; toNorm: string; to: string; count: number }
interface ChainEntry {
  chain: { nodes: ChainNode[]; hops: ChainHop[]; length: number; strength: number; totalCount: number; counties: string[] };
  position: number; role: string;
}
interface Network {
  norm: string; name: string; klass: string; classLabel: string;
  acquisitions: number; dispositions: number;
  topGrantors: RelParty[]; topGrantees: RelParty[]; coBuyers: RelParty[];
  chains: ChainEntry[];
  graph: { nodes: (GraphNode & { buyerId?: string | null })[]; edges: GraphEdge[] };
  classLabels: Record<string, string>;
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

  useEffect(() => {
    setLoading(true);
    api.get<{ network: Network | null; reason?: string }>(`/buyers/${buyerId}/relationships`)
      .then((d) => { setNet(d.network); setReason(d.reason ?? null); })
      .catch(() => { setNet(null); setReason("error"); })
      .finally(() => setLoading(false));
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

  const goOrAdd = (p: RelParty) => {
    if (p.buyerId) nav(`/buyers/${p.buyerId}`);
  };

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
  const PartyList = ({ title, empty, parties }: { title: string; empty: string; parties: RelParty[] }) => (
    <div>
      <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>{title}</div>
      {parties.length === 0 ? <p className="muted" style={{ margin: 0 }}>{empty}</p> : (
        <div className="rel-party-list">
          {parties.slice(0, 8).map((p) => (
            <div key={p.norm} className="rel-party-row">
              <button className={`rel-party-name ${p.buyerId ? "link" : ""}`} disabled={!p.buyerId} onClick={() => goOrAdd(p)} title={p.buyerId ? "Open buyer profile" : undefined}>
                {p.name}
              </button>
              <span className="rel-party-meta">
                <span className="rel-count-mini">{p.count}×</span>
                {!p.buyerId && canCreate && (
                  <button className="small" disabled={adding === p.norm} onClick={() => addAsBuyer(p)}>
                    {adding === p.norm ? "Adding…" : "+ Buyer"}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Relationships</h3>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <ClassBadge klass={net.klass} label={net.classLabel} />
          <span className="muted" style={{ fontSize: 12 }}>Acquired {net.acquisitions} · Sold {net.dispositions}</span>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
        Automatically derived from imported public records. Behavior classified from this buyer's transaction flow.
      </p>

      <div className="rel-columns">
        <PartyList title="Top Grantors (acquired from)" empty="No recorded acquisitions." parties={net.topGrantors} />
        <PartyList title="Top Grantees (sold to)" empty="No recorded dispositions." parties={net.topGrantees} />
        <PartyList title="Frequent Co-Buyers" empty="No shared acquisitions found." parties={net.coBuyers} />
      </div>

      {net.chains.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>Acquisition Chains</div>
          <div className="rel-chain-list">
            {net.chains.map((c, i) => (
              <div key={i} className="rel-chain">
                <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  {c.chain.nodes.map((n, j) => (
                    <span key={n.norm} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span className="badge" style={{
                        background: `${CLASS_COLORS[n.klass] ?? "#64748b"}26`, color: CLASS_COLORS[n.klass] ?? "#64748b",
                        outline: j === c.position ? "2px solid var(--accent)" : "none",
                      }}>{n.name}</span>
                      {j < c.chain.nodes.length - 1 && <span className="muted" title={`${c.chain.hops[j]?.count} transactions`}>—{c.chain.hops[j]?.count}→</span>}
                    </span>
                  ))}
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                  This buyer is the <strong>{net.classLabels[c.role] ?? c.role}</strong> at position {c.position + 1} of {c.chain.nodes.length}
                  {c.chain.counties.length > 0 && <> · {c.chain.counties.join(", ")}</>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
