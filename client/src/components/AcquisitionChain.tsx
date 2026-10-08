import { Fragment, useState, type ReactNode } from "react";
import { Info } from "lucide-react";

/**
 * Acquisition chains — the one shared rendering used everywhere a chain
 * appears (Buyer Profile → Chains, Research → Relationships → Acquisition
 * chains, and the Research entity dossier's "Appears in chains"). Styling
 * lives in styles/acquisition-chain.css and is deliberately unscoped, so every
 * screen gets the same squared tags, flush rows, and node flow.
 */

export interface ChainNode { norm: string; name: string; klass: string }
export interface ChainHop { fromNorm: string; from: string; toNorm: string; to: string; count: number }
export interface ChainEntry {
  chain: { nodes: ChainNode[]; hops: ChainHop[]; length: number; strength: number; totalCount: number; counties: string[] };
  position: number; role: string;
}

/**
 * Built to scale: each chain collapses to its endpoints + hop count (one
 * readable line however long the path), expands to the full path on click,
 * and only the strongest few show until "Show all".
 *
 * `focusNorm` highlights one entity through the chain (the buyer on the Buyer
 * Profile). Pass "" for no focus (Research market-wide view). `renderActions`
 * optionally renders an action row in the expanded body of each chain.
 * `framed` draws the card border itself, for hosts that don't sit the list
 * inside a card (the Research dossier modal).
 */
export function AcquisitionChains({ chains, classLabels, focusNorm, renderActions, framed }: {
  chains: ChainEntry[]; classLabels: Record<string, string>; focusNorm: string;
  renderActions?: (entry: ChainEntry, index: number) => ReactNode;
  framed?: boolean;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  if (chains.length === 0) return null;
  const CAP = 5;
  const visible = showAll ? chains : chains.slice(0, CAP);
  const hasFocus = focusNorm !== "";

  // The section header (title, count) is provided by whatever card or
  // section wraps this list.
  return (
    <div className={`chain2-list${framed ? " framed" : ""}`}>
      {visible.map((c, i) => {
        const open = openIdx === i;
        const len = c.chain.nodes.length;
        const first = c.chain.nodes[0], last = c.chain.nodes[len - 1];
        return (
          <div key={i} className={`chain2 ${open ? "open" : ""}`}>
            <button type="button" className="chain2-head" onClick={() => setOpenIdx(open ? null : i)} aria-expanded={open}>
              <span className="chain2-rank">#{i + 1}</span>
              <span className="chain2-endpoints">
                <NodeBadge n={first} />
                <span className="chain2-mid">→ {len - 2 > 0 && <b>{len - 2} more</b>} →</span>
                <NodeBadge n={last} term />
              </span>
              <span className="chain2-meta">
                <span className="chain2-sum"><b>{len}</b> entities · <b>{c.chain.totalCount}</b> tx</span>
                {c.chain.counties.length > 0 && (
                  <span className="chain2-counties">{c.chain.counties.slice(0, 2).join(" · ")}{c.chain.counties.length > 2 ? "…" : ""}</span>
                )}
                <svg className="chain2-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
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
                        <NodeBox n={n} focus={hasFocus && j === c.position} term={j === len - 1} />
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
                          <span className="chain2-line" aria-hidden="true">
                            <i />
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                          </span>
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
            {showAll ? `Show ${CAP} strongest` : `Show all ${chains.length} chains`}
          </button>
          <span className="chain2-showing">
            {showAll ? `Showing all ${chains.length}` : `Showing ${Math.min(CAP, chains.length)} strongest of ${chains.length}`}
          </span>
        </div>
      )}
    </div>
  );
}

/** Marks a chain's last entity (" term"), and one named with an ownership
 *  share such as "FMTX LP (90.00%)" (" term pct") — styling hooks only. */
const termClass = (n: ChainNode, term?: boolean) => (term ? (n.name.includes("%") ? " term pct" : " term") : "");

/** Endpoint tag in a chain's summary row — neutral, the terminus amber/green. */
function NodeBadge({ n, term }: { n: ChainNode; term?: boolean }) {
  return <span className={`chain2-pill${termClass(n, term)}`} title={n.name}>{n.name}</span>;
}

/** Node box in the expanded flow — neutral card, accent ring on the focus buyer. */
function NodeBox({ n, focus, term }: { n: ChainNode; focus: boolean; term?: boolean }) {
  return <span className={`chain2-box ${focus ? "focus" : ""}${termClass(n, term)}`} title={n.name}>{n.name}</span>;
}
