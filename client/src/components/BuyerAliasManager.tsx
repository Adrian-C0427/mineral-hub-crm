import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { fmtDate } from "../lib/format";
import { ConfirmDialog, Modal, showToast } from "./ui";
import { CollapsibleSection } from "./CollapsibleSection";

/**
 * Buyer Profile → Aliases & merges.
 *
 * The canonical buyer is stated explicitly; every alias renders as its own
 * chip (removable). "Merge / add alias" opens a search: pick another CRM
 * buyer to MERGE it into this one (all its data combines here, its names
 * become aliases), or add any typed name as an alias outright — no name
 * similarity required, the user is intentionally associating them. Every
 * association is audited (who, what, when), and administrators can undo an
 * incorrect merge from the history list.
 */

interface BuyerRow { id: string; companyName: string }
interface HistoryEvent {
  id: string; eventType: string; summary: string;
  actorName: string | null; createdAt: string; undoable: boolean;
}

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
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [removeAlias, setRemoveAlias] = useState<string | null>(null);
  const [undoEvent, setUndoEvent] = useState<HistoryEvent | null>(null);
  const [busy, setBusy] = useState(false);

  const loadHistory = () => {
    api.get<{ events: HistoryEvent[] }>(`/buyers/${buyerId}/merge-history`)
      .then((d) => setHistory(d.events)).catch(() => setHistory([]));
  };
  useEffect(loadHistory, [buyerId]);

  async function doRemoveAlias(name: string) {
    setBusy(true);
    try {
      await api.del(`/buyers/${buyerId}/aliases`, { name });
      showToast(`Alias "${name}" removed.`);
      setRemoveAlias(null); loadHistory(); onChanged();
    } finally { setBusy(false); }
  }

  async function doUndo(e: HistoryEvent) {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; restoredBuyer: { companyName: string } }>(`/buyers/merge-undo/${e.id}`, {});
      showToast(`Merge undone — "${r.restoredBuyer.companyName}" restored as its own profile.`);
      setUndoEvent(null); loadHistory(); onChanged();
    } finally { setBusy(false); }
  }

  return (
    <CollapsibleSection
      title="Aliases & merges"
      sub={aliases.length ? `${aliases.length} alias${aliases.length === 1 ? "" : "es"} recorded` : "No aliases recorded yet"}
      right={canEdit ? (
        <button type="button" className="small" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
          Merge / add alias
        </button>
      ) : undefined}
    >
      {/* Canonical vs aliases — unambiguous. */}
      <div className="alias-canon-row">
        <span className="alias-canon-label">Canonical buyer</span>
        <span className="vchip alias-canon-chip">{companyName}</span>
      </div>
      <div className="alias-canon-row" style={{ alignItems: "flex-start" }}>
        <span className="alias-canon-label">Aliases</span>
        {aliases.length === 0
          ? <span className="muted" style={{ fontSize: 13 }}>None — activity is attributed to the canonical name only.</span>
          : (
            <span className="vchips">
              {aliases.map((a) => (
                <span className="vchip" key={a}>
                  {a}
                  {canEdit && (
                    <button type="button" className="alias-chip-x" aria-label={`Remove alias ${a}`}
                      onClick={() => setRemoveAlias(a)}>×</button>
                  )}
                </span>
              ))}
            </span>
          )}
      </div>

      {history.length > 0 && (
        <div className="alias-history">
          <div className="ddx-label" style={{ marginBottom: 6 }}>Audit trail</div>
          {history.map((e) => (
            <div className="alias-history-row" key={e.id}>
              <span className="alias-history-text">
                {e.summary}
                <span className="muted"> — {e.actorName ?? "system"}, {fmtDate(e.createdAt)}</span>
              </span>
              {e.undoable && canMerge && (
                <button type="button" className="small" onClick={() => setUndoEvent(e)}>Undo merge</button>
              )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <MergeSearchModal
          buyerId={buyerId}
          companyName={companyName}
          onClose={() => setOpen(false)}
          onDone={() => { setOpen(false); loadHistory(); onChanged(); }}
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
      {undoEvent && (
        <ConfirmDialog
          title="Undo this merge?"
          message={<>The absorbed buyer profile will be restored (identity, contact info, buy box, owners, tags) and the aliases this merge added will be removed from <strong>{companyName}</strong>. Deals, offers, messages, and documents that moved during the merge remain on this buyer — nothing is deleted.</>}
          confirmLabel="Undo merge"
          busy={busy}
          onCancel={() => setUndoEvent(null)}
          onConfirm={() => doUndo(undoEvent)}
        />
      )}
    </CollapsibleSection>
  );
}

/** Search-driven merge/alias picker with an explicit confirm step. */
function MergeSearchModal({ buyerId, companyName, onClose, onDone, canMerge }: {
  buyerId: string; companyName: string; onClose: () => void; onDone: () => void; canMerge: boolean;
}) {
  const [buyers, setBuyers] = useState<BuyerRow[]>([]);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<{ kind: "merge"; buyer: BuyerRow } | { kind: "alias"; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<BuyerRow[]>("/buyers").then((rows) => setBuyers(rows.filter((b) => b.id !== buyerId))).catch(() => setBuyers([]));
  }, [buyerId]);

  // Plain substring match — intentionally NOT similarity-gated: the user may
  // associate completely different names on purpose.
  const matches = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return buyers.filter((b) => b.companyName.toLowerCase().includes(term)).slice(0, 8);
  }, [buyers, q]);
  const typed = q.trim();

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
            Search for a buyer to merge into <strong>{companyName}</strong>, or add any name as an
            alias. Names do not need to be similar — this is an intentional association.
          </p>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search buyer names…"
            aria-label="Search buyer names"
          />
          <div className="alias-search-results">
            {matches.map((b) => (
              <button type="button" className="alias-search-row" key={b.id}
                disabled={!canMerge}
                title={canMerge ? undefined : "Merging requires the delete-buyers permission"}
                onClick={() => setPick({ kind: "merge", buyer: b })}>
                <span>{b.companyName}</span>
                <span className="alias-search-kind">CRM buyer — merge</span>
              </button>
            ))}
            {typed.length > 1 && (
              <button type="button" className="alias-search-row" onClick={() => setPick({ kind: "alias", name: typed })}>
                <span>Add “{typed}” as an alias</span>
                <span className="alias-search-kind">alias only</span>
              </button>
            )}
            {typed.length > 1 && matches.length === 0 && (
              <p className="muted" style={{ fontSize: 12.5, margin: "6px 2px 0" }}>No CRM buyers match — you can still add the typed name as an alias.</p>
            )}
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
                records stay attributed correctly. This is recorded in the audit trail and an
                administrator can undo it.
              </span>
            </p>
          ) : (
            <p style={{ marginTop: 0, fontSize: 13.5, lineHeight: 1.55 }}>
              Add <strong>{pick.name}</strong> as an alias of <strong>{companyName}</strong>?<br />
              <span className="muted">
                Research activity recorded under that name will count toward this buyer. Recorded in the
                audit trail; removable at any time.
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
