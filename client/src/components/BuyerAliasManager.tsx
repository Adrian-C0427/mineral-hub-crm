import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ConfirmDialog, Modal, showToast } from "./ui";
import { CollapsibleSection } from "./CollapsibleSection";

/**
 * Buyer Profile → Aliases & merges.
 *
 * The canonical buyer is stated explicitly; every alias renders as its own
 * chip (removable). "Merge / add alias" opens a search: pick another CRM
 * buyer to MERGE it into this one (all its data combines here, its names
 * become aliases), or add any typed name as an alias outright — no name
 * similarity required, the user is intentionally associating them. (The
 * server still records every association; nothing of that is shown here.)
 */

interface BuyerRow { id: string; companyName: string }

export function BuyerAliasManager({ buyerId, companyName, aliases, onChanged }: {
  buyerId: string;
  companyName: string;
  aliases: string[];
  /** Reload the profile after any alias/merge change. */
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const canEdit = can("editBuyers");
  const canMerge = can("deleteBuyers");

  const [open, setOpen] = useState(false);
  const [removeAlias, setRemoveAlias] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function doRemoveAlias(name: string) {
    setBusy(true);
    try {
      await api.del(`/buyers/${buyerId}/aliases`, { name });
      showToast(`Alias "${name}" removed.`);
      setRemoveAlias(null); onChanged();
    } finally { setBusy(false); }
  }

  return (
    <CollapsibleSection
      title="Aliases & merges"
      sub={aliases.length ? `${aliases.length} alias${aliases.length === 1 ? "" : "es"} recorded` : "No aliases recorded yet"}
      defaultOpen
      right={canEdit ? (
        <button type="button" className="small" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          Merge / add alias
        </button>
      ) : undefined}
    >
      {/* Canonical vs aliases — unambiguous. */}
      <div className="alias-grid">
        <span className="alias-canon-label">Canonical buyer</span>
        <span><span className="vchip alias-canon-chip">{companyName}</span></span>
        <span className="alias-canon-label">Aliases</span>
        {aliases.length === 0
          ? <span className="alias-none">None — activity is attributed to the canonical name only.</span>
          : (
            <span className="vchips">
              {aliases.map((a) => (
                <span className="vchip alias-chip" key={a}>
                  {a}
                  {canEdit && (
                    <button type="button" className="alias-chip-x" aria-label={`Remove alias ${a}`}
                      onClick={() => setRemoveAlias(a)}>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  )}
                </span>
              ))}
            </span>
          )}
      </div>

      {open && (
        <MergeSearchModal
          buyerId={buyerId}
          companyName={companyName}
          onClose={() => setOpen(false)}
          onDone={() => { setOpen(false); onChanged(); }}
          canMerge={canMerge}
        />
      )}
      {removeAlias && (
        <ConfirmDialog
          title="Remove alias?"
          message={<>Remove <strong>{removeAlias}</strong> as an alias of <strong>{companyName}</strong>? Research activity recorded under that name will no longer count toward this buyer.</>}
          confirmLabel="Remove alias"
          busy={busy}
          onCancel={() => setRemoveAlias(null)}
          onConfirm={() => doRemoveAlias(removeAlias)}
        />
      )}
    </CollapsibleSection>
  );
}

/** A grantor/grantee name from the org's transaction records (one party, never a group). */
interface AliasHit { norm: string; name: string; txCount: number; asGrantee: number; asGrantor: number; buyerId: string | null; buyerName: string | null }

/**
 * Search-driven merge/alias picker with an explicit confirm step. Results are
 * individual grantor and grantee names from the transaction records only — a
 * multi-party deed ("A; B") offers A and B separately, never "A & B" — so an
 * alias always maps to real transaction history. A name another CRM buyer
 * already claims becomes a profile merge instead of a plain alias.
 */
function MergeSearchModal({ buyerId, companyName, onClose, onDone, canMerge }: {
  buyerId: string; companyName: string; onClose: () => void; onDone: () => void; canMerge: boolean;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<AliasHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [pick, setPick] = useState<{ kind: "merge"; buyer: BuyerRow } | { kind: "alias"; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const typed = q.trim();
  useEffect(() => {
    if (typed.length < 2) { setHits([]); return; }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      api.get<{ results: AliasHit[] }>(`/buyers/${buyerId}/alias-search?q=${encodeURIComponent(typed)}`)
        .then((r) => { if (live) setHits(r.results); })
        .catch(() => { if (live) setHits([]); })
        .finally(() => { if (live) setSearching(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [buyerId, typed]);

  async function save() {
    if (!pick) return;
    setBusy(true); setErr(null);
    try {
      if (pick.kind === "merge") {
        await api.post(`/buyers/${buyerId}/merge`, { sourceBuyerId: pick.buyer.id });
        showToast(`Merged "${pick.buyer.companyName}" into ${companyName} — all data combined, name kept as an alias.`);
      } else {
        await api.post(`/buyers/${buyerId}/aliases`, { name: pick.name });
        showToast(`"${pick.name}" added as an alias of ${companyName}.`);
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Merge / add alias" onClose={onClose}>
      {!pick ? (
        <>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Search the grantor and grantee names in your transaction records. Pick the name that is
            <strong> {companyName}</strong> under another spelling: its recorded history then counts
            toward this buyer. Names do not need to be similar — this is an intentional association.
          </p>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search recorded grantor / grantee names…"
            aria-label="Search recorded names"
          />
          <div className="alias-search-results">
            {hits.map((h) => {
              const sides = [h.asGrantee ? `${h.asGrantee} as buyer` : null, h.asGrantor ? `${h.asGrantor} as seller` : null].filter(Boolean).join(" · ");
              return h.buyerId ? (
                <button type="button" className="alias-search-row" key={h.norm}
                  disabled={!canMerge}
                  title={canMerge ? undefined : "Merging requires the delete-buyers permission"}
                  onClick={() => setPick({ kind: "merge", buyer: { id: h.buyerId!, companyName: h.buyerName ?? h.name } as BuyerRow })}>
                  <span>{h.name}<span className="muted" style={{ fontSize: 12 }}> · {sides}</span></span>
                  <span className="alias-search-kind">already the buyer “{h.buyerName}” — merge profiles</span>
                </button>
              ) : (
                <button type="button" className="alias-search-row" key={h.norm} onClick={() => setPick({ kind: "alias", name: h.name })}>
                  <span>{h.name}<span className="muted" style={{ fontSize: 12 }}> · {sides}</span></span>
                  <span className="alias-search-kind">add as alias</span>
                </button>
              );
            })}
            {typed.length >= 2 && !searching && hits.length === 0 && (
              <p className="muted" style={{ fontSize: 12.5, margin: "6px 2px 0" }}>No recorded grantor or grantee matches “{typed}”.</p>
            )}
            {searching && <p className="muted" style={{ fontSize: 12.5, margin: "6px 2px 0" }}>Searching…</p>}
          </div>
        </>
      ) : (
        <>
          {pick.kind === "merge" ? (
            <p style={{ marginTop: 0, fontSize: 13.5, lineHeight: 1.55 }}>
              Merge <strong>{pick.buyer.companyName}</strong> into <strong>{companyName}</strong>?<br />
              <span className="muted">
                {companyName} stays the canonical buyer. Everything from {pick.buyer.companyName} — deals,
                offers, messages, documents, notes, buy box, owners, tags, and research history — is
                combined here (duplicates collapse to one), and its name becomes an alias so historical
                records stay attributed correctly.
              </span>
            </p>
          ) : (
            <p style={{ marginTop: 0, fontSize: 13.5, lineHeight: 1.55 }}>
              Add <strong>{pick.name}</strong> as an alias of <strong>{companyName}</strong>?<br />
              <span className="muted">
                Research activity recorded under that name will count toward this buyer. Removable at any time.
              </span>
            </p>
          )}
          {err && <p className="error-text" style={{ fontSize: 13 }}>{err}</p>}
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            <button type="button" className="small" onClick={() => setPick(null)} disabled={busy}>Back</button>
            <button type="button" className="primary" onClick={save} disabled={busy}>
              {busy ? "Saving…" : pick.kind === "merge" ? "Confirm merge" : "Add alias"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
