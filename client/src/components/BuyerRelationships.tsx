import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ConfirmDialog, Modal, Spinner, showToast } from "./ui";
import { CollapsibleSection } from "./CollapsibleSection";
import { ChainSection, ClassBadge, PartyColumn, RelStat, type ChainEntry, type RelParty } from "./relationshipViews";

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
