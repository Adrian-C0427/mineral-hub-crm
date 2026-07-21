import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Info, Users } from "lucide-react";
import { CLASS_COLORS } from "../lib/entityClasses";

/**
 * Shared presentation for relationship intelligence — used by both the Buyer
 * Profile (BuyerRelationships) and Research → Relationships so the two screens
 * render the same polished layout from one implementation.
 */

export interface RelParty { norm: string; name: string; count: number; entityType: "company" | "individual"; buyerId: string | null }
export interface ChainNode { norm: string; name: string; klass: string }
export interface ChainHop { fromNorm: string; from: string; toNorm: string; to: string; count: number }
export interface ChainEntry {
  chain: { nodes: ChainNode[]; hops: ChainHop[]; length: number; strength: number; totalCount: number; counties: string[] };
  position: number; role: string;
}

export function ClassBadge({ klass, label }: { klass: string; label: string }) {
  const c = CLASS_COLORS[klass] ?? "#64748b";
  return <span className="badge" style={{ background: `${c}26`, color: c }}>{label}</span>;
}

export function RelStat({ n, l }: { n: number; l: string }) {
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
export function PartyColumn({ title, tone, empty, parties, canCreate, adding, onAdd, onOpen, alwaysOpenable, openTitle, renderExtra }: {
  title: string; tone: "up" | "down" | "co"; empty: string; parties: RelParty[];
  canCreate: boolean; adding: string | null; onAdd: (p: RelParty) => void; onOpen: (p: RelParty) => void;
  /** Research usage: rows are openable dossiers even without a CRM buyer link. */
  alwaysOpenable?: boolean; openTitle?: string;
  /** Optional extra affordance per row (e.g. Research's "deeds" drill button). */
  renderExtra?: (p: RelParty) => ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  // Defense in depth: even if the API ever sends individuals, never show them.
  const companies = useMemo(() => parties.filter((p) => p.entityType !== "individual"), [parties]);
  const max = Math.max(1, ...companies.map((p) => p.count));
  const CAP = 8;
  const icon = tone === "up" ? <ArrowUp size={13} className="rel2-ic-up" aria-hidden="true" />
    : tone === "down" ? <ArrowDown size={13} className="rel2-ic-down" aria-hidden="true" />
      : <Users size={13} className="rel2-ic-co" aria-hidden="true" />;

  const Row = ({ p }: { p: RelParty }) => {
    const openable = alwaysOpenable || !!p.buyerId;
    return (
      <div className="rel2-row">
        <button className={`rel2-name ${openable ? "link" : ""}`} disabled={!openable} onClick={() => onOpen(p)}
          title={openable ? (openTitle ?? "Open buyer profile") : p.name}>
          {p.name}
        </button>
        <span className="rel2-bar" aria-hidden="true"><span style={{ width: `${Math.max(8, (p.count / max) * 100)}%` }} /></span>
        <span className="rel2-count">{p.count}×</span>
        {!p.buyerId && canCreate && (
          <button className="rel2-add" disabled={adding === p.norm} onClick={() => onAdd(p)}>
            {adding === p.norm ? "Adding…" : "+ Buyer"}
          </button>
        )}
        {renderExtra?.(p)}
      </div>
    );
  };

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
 *
 * `focusNorm` highlights one entity through the chain (the buyer on the Buyer
 * Profile). Pass "" for no focus (Research market-wide view). `renderActions`
 * optionally renders an action row in the expanded body of each chain.
 */
export function ChainSection({ chains, classLabels, focusNorm, renderActions }: {
  chains: ChainEntry[]; classLabels: Record<string, string>; focusNorm: string;
  renderActions?: (entry: ChainEntry, index: number) => ReactNode;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  if (chains.length === 0) return null;
  const CAP = 5;
  const visible = showAll ? chains : chains.slice(0, CAP);
  const hasFocus = focusNorm !== "";

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
                <NodeBadge n={first} focus={hasFocus && first.norm === focusNorm} />
                <span className="chain2-mid">→ {len - 2 > 0 && <b>{len - 2} more</b>} →</span>
                <NodeBadge n={last} focus={hasFocus && last.norm === focusNorm} />
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
                        <NodeBox n={n} focus={hasFocus && j === c.position} />
                        <span className={`chain2-cap ${hasFocus && j === c.position ? "focus" : ""}`}>
                          {hasFocus && j === c.position ? `This buyer · ${j + 1} of ${len}`
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
                {hasFocus && (
                  <div className="chain2-info">
                    <Info size={13} aria-hidden="true" />
                    <span>
                      This buyer is the <strong>{classLabels[c.role] ?? c.role}</strong> at position <b>{c.position + 1} of {len}</b>
                      {c.chain.counties.length > 0 && <> · {c.chain.counties.join(", ")}</>}
                    </span>
                  </div>
                )}
                {renderActions && <div className="chain2-actions">{renderActions(c, i)}</div>}
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
export function NodeBadge({ n, focus }: { n: ChainNode; focus: boolean }) {
  const c = CLASS_COLORS[n.klass] ?? "#64748b";
  return (
    <span className={`chain2-pill ${focus ? "focus" : ""}`}
      style={focus ? undefined : { background: `${c}1f`, borderColor: `${c}55`, color: c }}>
      {n.name}
    </span>
  );
}

/** Node box in the expanded flow — neutral card, accent ring on the focus buyer. */
export function NodeBox({ n, focus }: { n: ChainNode; focus: boolean }) {
  const c = CLASS_COLORS[n.klass] ?? "#64748b";
  return (
    <span className={`chain2-box ${focus ? "focus" : ""}`} style={focus ? undefined : { borderColor: `${c}55` }} title={n.name}>
      {n.name}
    </span>
  );
}
