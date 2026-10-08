import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Users } from "lucide-react";
import { CLASS_COLORS, CLASS_FALLBACK_COLOR } from "../lib/entityClasses";

/**
 * Shared presentation for relationship intelligence — used by both the Buyer
 * Profile (BuyerRelationships) and Research → Relationships so the two screens
 * render the same polished layout from one implementation. Acquisition chains
 * live in their own shared component (AcquisitionChain.tsx).
 */

export interface RelParty { norm: string; name: string; count: number; entityType: "company" | "individual"; buyerId: string | null }

/** Class tag: tinted with the class colour, a leading dot, readable text in every theme. */
export function ClassBadge({ klass, label }: { klass: string; label: string }) {
  const c = CLASS_COLORS[klass] ?? CLASS_FALLBACK_COLOR;
  return <span className="class-badge" style={{ "--c": c } as CSSProperties}><i />{label}</span>;
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
