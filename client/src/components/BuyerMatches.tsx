import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { ProgressBar, Tag } from "./kit";
import { ChipList, OverflowMenu, Spinner, showToast } from "./ui";
import { fmtDate } from "../lib/format";
import type { MatchComponent, MatchConfidence, MatchCriterion, MatchOverrideKind, MatchRec } from "../types";

/**
 * Buyer matches for one deal (Deal Profile and the Mineral Asset Sell tab).
 *
 * Every buyer, ranked by the server's match score, each card showing the score
 * ring, the confidence in it, the three strongest facts behind it, the hard
 * conflicts that make a buyer ineligible, and — on demand — the full
 * breakdown by factor. Sorting and filters rearrange the list; manual overrides
 * (pin / exclude / flag) are stored per deal and shown as badges, never mixed
 * into the score. Selection, "Send deal by email", "Mark as contacted" and
 * the CSV export are the parent's — this component only drives them.
 */

type SortKey = "score" | "confidence" | "proximity" | "exactAbstract" | "sameCounty" | "recent" | "buyBox" | "relationship";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "score", label: "Match score" },
  { key: "confidence", label: "Confidence" },
  { key: "proximity", label: "Nearest acquisition" },
  { key: "exactAbstract", label: "Same abstract" },
  { key: "sameCounty", label: "Same county activity" },
  { key: "recent", label: "Recent activity" },
  { key: "buyBox", label: "Buy box fit" },
  { key: "relationship", label: "Relationship" },
];

const CONF_LABEL: Record<MatchConfidence, string> = { HIGH: "High confidence", MEDIUM: "Medium confidence", LOW: "Low confidence", INSUFFICIENT: "Insufficient data" };
const CONF_TONE: Record<MatchConfidence, "success" | "neutral" | "warn"> = { HIGH: "success", MEDIUM: "neutral", LOW: "warn", INSUFFICIENT: "neutral" };
const CONF_TIP = "How complete the evidence behind this score is — not how interested the buyer is. High: verified acquisitions, a filled-in buy box and CRM history. Low: little recorded activity or an incomplete profile.";
const OVERRIDE_LABEL: Record<MatchOverrideKind, string> = { PRIORITIZE: "Pinned", EXCLUDE: "Excluded", FLAG: "Flagged" };
const OVERRIDE_TONE: Record<MatchOverrideKind, "accent" | "neutral" | "warn"> = { PRIORITIZE: "accent", EXCLUDE: "neutral", FLAG: "warn" };

const comp = (m: MatchRec, key: MatchComponent["key"]) => m.components.find((c) => c.key === key)?.score ?? null;
const desc = (a: number | null, b: number | null) => (a == null) !== (b == null) ? (a == null ? 1 : -1) : (b ?? 0) - (a ?? 0);
const asc = (a: number | null, b: number | null) => (a == null) !== (b == null) ? (a == null ? 1 : -1) : (a ?? 0) - (b ?? 0);

function sortMatches(list: MatchRec[], key: SortKey): MatchRec[] {
  const byRank = (a: MatchRec, b: MatchRec) => a.rank - b.rank;
  const out = [...list];
  switch (key) {
    case "score": return out.sort(byRank);
    case "confidence": return out.sort((a, b) => b.confidenceScore - a.confidenceScore || byRank(a, b));
    case "proximity": return out.sort((a, b) => asc(a.facts.nearestAcquisitionMiles, b.facts.nearestAcquisitionMiles) || byRank(a, b));
    case "exactAbstract": return out.sort((a, b) => b.facts.sameAbstract - a.facts.sameAbstract || b.facts.adjacentAbstract - a.facts.adjacentAbstract || byRank(a, b));
    case "sameCounty": return out.sort((a, b) => b.facts.sameCounty - a.facts.sameCounty || byRank(a, b));
    case "recent": return out.sort((a, b) => b.facts.last12m - a.facts.last12m || (b.facts.lastAcquisitionDate ?? "").localeCompare(a.facts.lastAcquisitionDate ?? "") || byRank(a, b));
    case "buyBox": return out.sort((a, b) => desc(comp(a, "buyBox"), comp(b, "buyBox")) || byRank(a, b));
    case "relationship": return out.sort((a, b) => desc(comp(a, "relationship"), comp(b, "relationship")) || byRank(a, b));
  }
}

const miles = (n: number | null) => (n == null ? null : n < 0.05 ? "on the tract" : `${n < 10 ? n.toFixed(1) : Math.round(n)} mi`);
const tone = (score: number | null): "success" | "warn" | "accent" | "danger" => (score == null ? "accent" : score >= 70 ? "success" : score >= 45 ? "accent" : score >= 25 ? "warn" : "danger");

export function BuyerMatches({ dealId, matches, canEdit, selected, onSelectedChange, onSendEmail, onMarkContacted, onExport, onLogContact, onChanged }: {
  dealId: string;
  matches: MatchRec[] | null;
  canEdit: boolean;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  onSendEmail: () => void;
  onMarkContacted: () => void;
  onExport?: () => void;
  onLogContact?: (buyer: { id: string; name: string }) => void;
  /** An override was saved or cleared — the parent reloads the matches. */
  onChanged: () => void;
}) {
  const [sort, setSort] = useState<SortKey>("score");
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const [exactOnly, setExactOnly] = useState(false);
  const [countyOnly, setCountyOnly] = useState(false);
  const [recentOnly, setRecentOnly] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const view = useMemo(() => {
    if (!matches) return [];
    const kept = matches.filter((m) =>
      (showExcluded || m.override?.kind !== "EXCLUDE")
      && (!eligibleOnly || m.eligible)
      && (!exactOnly || m.facts.sameAbstract > 0)
      && (!countyOnly || m.facts.sameCounty > 0)
      && (!recentOnly || m.facts.last12m > 0));
    return sortMatches(kept, sort);
  }, [matches, sort, eligibleOnly, exactOnly, countyOnly, recentOnly, showExcluded]);

  if (!matches) return <Spinner />;
  if (matches.length === 0) return <p className="muted mr-none">No buyers in the system yet.</p>;

  const excludedCount = matches.filter((m) => m.override?.kind === "EXCLUDE").length;
  const shown = showAll ? view : view.slice(0, 6);
  const allSelected = view.length > 0 && view.every((m) => selected.has(m.buyerId));
  const toggle = (id: string) => { const n = new Set(selected); n.has(id) ? n.delete(id) : n.add(id); onSelectedChange(n); };
  const toggleOpen = (id: string) => setOpen((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function setOverride(m: MatchRec, kind: MatchOverrideKind | null) {
    setBusy(m.buyerId);
    try {
      // A null kind clears the override (one route, so the demo workspace can clear its own marks too).
      await api.put(`/deals/${dealId}/matches/${m.buyerId}/override`, { kind });
      showToast(kind ? `${m.companyName || m.buyerName} ${kind === "PRIORITIZE" ? "pinned to the top" : kind === "EXCLUDE" ? "excluded from this deal" : "flagged"}` : "Override cleared");
      onChanged();
    } catch {
      showToast("Could not save the override", "error");
    } finally { setBusy(null); }
  }

  return (
    <>
      <div className="mr-bulk bm-bar">
        {canEdit && (
          <>
            <label className="mr-selall">
              <input type="checkbox" checked={allSelected} onChange={() => onSelectedChange(allSelected ? new Set() : new Set(view.map((m) => m.buyerId)))} /> Select all
            </label>
            <span className="mr-selcount">{selected.size} selected</span>
            <button className="small primary" disabled={selected.size === 0} onClick={onSendEmail}>Send deal by email</button>
            <button className="small" disabled={selected.size === 0} onClick={onMarkContacted}>Mark as contacted</button>
            {onExport && <button className="small" disabled={selected.size === 0} onClick={onExport}>Export selected (CSV)</button>}
            {selected.size > 0 && <button className="link-btn mr-deselect" onClick={() => onSelectedChange(new Set())}>Deselect all</button>}
          </>
        )}
        <label className="bm-sort">
          <span>Sort by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort buyers by">
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
      </div>
      <div className="bm-filters">
        <label><input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} /> Eligible only</label>
        <label><input type="checkbox" checked={exactOnly} onChange={(e) => setExactOnly(e.target.checked)} /> Bought in this abstract</label>
        <label><input type="checkbox" checked={countyOnly} onChange={(e) => setCountyOnly(e.target.checked)} /> Active in this county</label>
        <label><input type="checkbox" checked={recentOnly} onChange={(e) => setRecentOnly(e.target.checked)} /> Bought in the last 12 months</label>
        {excludedCount > 0 && <label><input type="checkbox" checked={showExcluded} onChange={(e) => setShowExcluded(e.target.checked)} /> Show excluded ({excludedCount})</label>}
        <span className="bm-count">{view.length === matches.length ? `${matches.length} buyers` : `${view.length} of ${matches.length} buyers`}</span>
      </div>
      <div className="mr-list">
        {shown.length === 0 && <p className="muted bm-empty">No buyers match these filters.</p>}
        {shown.map((m) => {
          const ring = 2 * Math.PI * 14;
          const score = m.score;
          const ringTone = score == null ? "low" : score >= 70 ? "success" : score >= 45 ? "warn" : "low";
          const expanded = open.has(m.buyerId);
          const name = m.companyName || m.buyerName;
          const hard = m.hardConflicts;
          return (
            <div className={`match-card bm-card ${selected.has(m.buyerId) ? "match-selected" : ""} ${!m.eligible ? "bm-ineligible" : ""} ${m.override?.kind === "EXCLUDE" ? "bm-excluded" : ""}`} key={m.buyerId}>
              {canEdit && <input type="checkbox" checked={selected.has(m.buyerId)} onChange={() => toggle(m.buyerId)} aria-label={`Select ${name}`} />}
              <span className="match-rank">#{m.rank}</span>
              <span className={`mr-ring ${ringTone}`} aria-label={score == null ? "No match score — insufficient data" : `${score} match score`} title={score == null ? "Insufficient data to score this buyer" : `Match score ${score} of 100`}>
                <svg width="36" height="36" viewBox="0 0 36 36">
                  <circle cx="18" cy="18" r="14" fill="none" className="mr-ring-track" strokeWidth="3" />
                  {score != null && <circle cx="18" cy="18" r="14" fill="none" className="mr-ring-val" strokeWidth="3" strokeLinecap="round"
                    strokeDasharray={`${((ring * score) / 100).toFixed(1)} ${ring.toFixed(1)}`} transform="rotate(-90 18 18)" />}
                </svg>
                <span className="mr-ring-n">{score ?? "—"}</span>
              </span>
              <div className="mr-main">
                <div className="mr-title">
                  <Link to={`/buyers/${m.buyerId}`} className="match-name subtle-link" title={name}>{name}</Link>
                  <Tag tone={CONF_TONE[m.confidence]} dot title={CONF_TIP}>{CONF_LABEL[m.confidence]}</Tag>
                  {!m.eligible && <Tag tone="danger" title={hard.join("\n")}>Doesn't meet {hard.length === 1 ? "a requirement" : `${hard.length} requirements`}</Tag>}
                  {m.override && <Tag tone={OVERRIDE_TONE[m.override.kind]} title={[m.override.by?.name && `by ${m.override.by.name}`, m.override.note].filter(Boolean).join(" — ") || undefined}>{OVERRIDE_LABEL[m.override.kind]}</Tag>}
                  {m.lastContactDate && <span className="mr-contacted">Contacted</span>}
                </div>
                {(hard.length > 0 || m.highlights.length > 0) && (
                  <ul className="bm-why">
                    {hard.map((h) => <li key={h} className="bm-why-hard">{h}</li>)}
                    {m.highlights.filter((h) => !hard.includes(h)).map((h) => <li key={h}>{h}</li>)}
                  </ul>
                )}
                <div className="mr-meta bm-facts">
                  <span title="Distance from this deal's tract to the buyer's closest recorded acquisition">Nearest acquisition: <b>{miles(m.facts.nearestAcquisitionMiles) ?? (m.facts.sameCounty ? "same county" : m.facts.totalAcquisitions ? "none nearby" : "none recorded")}</b>{m.facts.nearestAcquisitionDate && ` (${fmtDate(m.facts.nearestAcquisitionDate)})`}</span>
                  <span>Last acquisition: <b>{m.facts.lastAcquisitionDate ? fmtDate(m.facts.lastAcquisitionDate) : "—"}</b></span>
                  <span>Closed together: <b>{m.previousDealsClosed}</b></span>
                  <span>Last contact: <b>{m.lastContactDate ? fmtDate(m.lastContactDate) : "never"}</b>{m.stale && m.lastContactDate && <span className="stale-flag" title="No contact in a while — worth a follow-up"> · stale</span>}</span>
                  <span>Owner(s): {m.owners.length ? <ChipList items={m.owners} max={3} /> : "—"}</span>
                </div>
                <button className="link-btn bm-toggle" onClick={() => toggleOpen(m.buyerId)} aria-expanded={expanded}>{expanded ? "Hide breakdown" : "Score breakdown"}</button>
                {expanded && <Breakdown m={m} />}
              </div>
              <div className="bm-actions">
                {canEdit && onLogContact && <button className="small match-log" onClick={() => onLogContact({ id: m.buyerId, name: m.buyerName })}>Log contact</button>}
                {canEdit && (
                  <OverflowMenu ariaLabel={`Overrides for ${name}`} items={[
                    ...(m.override?.kind !== "PRIORITIZE" ? [{ label: "Pin to the top for this deal", onClick: () => setOverride(m, "PRIORITIZE") }] : []),
                    ...(m.override?.kind !== "FLAG" ? [{ label: "Flag for review", onClick: () => setOverride(m, "FLAG") }] : []),
                    ...(m.override?.kind !== "EXCLUDE" ? [{ label: "Exclude from this deal", danger: true, onClick: () => setOverride(m, "EXCLUDE") }] : []),
                    ...(m.override ? [{ label: `Clear "${OVERRIDE_LABEL[m.override.kind]}"`, onClick: () => setOverride(m, null) }] : []),
                  ]} />
                )}
                {busy === m.buyerId && <Spinner label="" />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mr-foot">
        <span className="mr-legend">Scores combine where the buyer has bought (Research deeds), their stated buy box, how active they are, our history with them and how this deal compares with what they buy.</span>
        {view.length > 6 && (
          <button className="small mr-more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show top 6" : `Show all ${view.length} buyers`}
          </button>
        )}
      </div>
    </>
  );
}

const TIER_LABEL: Record<string, string> = {
  sameAbstract: "same abstract", adjacentAbstract: "adjacent abstract", within2mi: "within 2 mi", within5mi: "within 5 mi", within10mi: "within 10 mi",
  within25mi: "within 25 mi", sameCounty: "same county", neighborCounty: "neighbouring county",
};

function Breakdown({ m }: { m: MatchRec }) {
  const specified = m.criteria.filter((c) => c.specified);
  return (
    <div className="bm-breakdown">
      <div className="bm-components">
        {m.components.map((c) => (
          <div key={c.key} className="bm-comp">
            <div className="bm-comp-head">
              <span className="bm-comp-label">{c.label}</span>
              <span className="bm-comp-weight" title="Weight of this factor in the overall score">{c.weight}%</span>
              <span className={`bm-comp-score ${c.score == null ? "muted" : ""}`}>{c.score == null ? "No data" : c.score}</span>
            </div>
            <ProgressBar value={(c.score ?? 0) / 100} tone={c.score == null ? "accent" : tone(c.score)} />
            <ul className="bm-reasons">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
        ))}
      </div>
      {specified.length > 0 && (
        <div className="bm-criteria">
          <div className="bm-sub">Buy box, criterion by criterion</div>
          <ul>{specified.map((c) => <li key={c.key} className={critClass(c)}><b>{c.label}</b>{c.strict && <Tag tone="neutral">required</Tag>} — {c.detail}</li>)}</ul>
        </div>
      )}
      {m.facts.recentNearby.length > 0 && (
        <div className="bm-nearby">
          <div className="bm-sub">Closest recorded acquisitions</div>
          <ul>{m.facts.recentNearby.map((a) => <li key={a.docId}>{fmtDate(a.date)} · {a.county} County · {TIER_LABEL[a.tier] ?? a.tier}{a.miles != null && a.miles > 0.05 ? ` · ${miles(a.miles)}` : ""}</li>)}</ul>
        </div>
      )}
      <div className="bm-sub bm-facts-row">
        <span>{m.facts.totalAcquisitions} recorded acquisitions</span>
        <span>{m.facts.last12m} in the last 12 months</span>
        <span>{m.facts.last90d} in the last 90 days</span>
        <span>{m.facts.sameAbstract} in this abstract</span>
        <span>{m.facts.adjacentAbstract} adjacent</span>
        <span>{m.facts.within10mi} within 10 mi</span>
        <span>{m.facts.sameCounty} in this county</span>
        <span>{m.facts.neighborCounty} in neighbouring counties</span>
      </div>
    </div>
  );
}

function critClass(c: MatchCriterion): string {
  if (c.result == null) return "bm-crit-unknown";
  if (c.result === 1) return "bm-crit-yes";
  if (c.result === 0) return c.strict ? "bm-crit-hard" : "bm-crit-no";
  return "bm-crit-near";
}
