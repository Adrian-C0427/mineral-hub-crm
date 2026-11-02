import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { api } from "../api/client";
import type { RecordRef, RecordType } from "../lib/cloud";

export interface RecordHit extends RecordRef { name: string; detail: string | null }

const TYPE_LABEL: Record<RecordType, string> = { deal: "Deal", opportunity: "Opportunity", contact: "Contact", buyer: "Buyer" };

/**
 * Find a deal (or mineral asset), opportunity, contact or buyer to link an
 * email or drive file to. Searches only records the member's role can see
 * (server: routes/recordSearch.ts).
 */
export function RecordPicker({ onPick, exclude = [] }: { onPick: (r: RecordHit) => void; exclude?: readonly RecordRef[] }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<RecordHit[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); return; }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api.get<RecordHit[]>(`/records/search?q=${encodeURIComponent(term)}`)
        .then((h) => { if (live) setHits(h); })
        .catch(() => { if (live) setHits([]); })
        .finally(() => { if (live) setLoading(false); });
    }, 220);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const skip = new Set(exclude.map((r) => `${r.type}:${r.id}`));
  const shown = hits.filter((h) => !skip.has(`${h.type}:${h.id}`));
  return (
    <div className="rp">
      <label className="rp-search">
        <Search size={14} aria-hidden="true" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search deals, assets, opportunities, contacts, buyers…" aria-label="Search records" />
      </label>
      <div className="rp-list" role="listbox">
        {shown.map((h) => (
          <button key={`${h.type}:${h.id}`} type="button" role="option" aria-selected="false" className="rp-hit" onClick={() => onPick(h)}>
            <span className={`rp-type t-${h.type}`}>{TYPE_LABEL[h.type]}</span>
            <span className="rp-name">{h.name}</span>
            {h.detail && <span className="rp-detail">{h.detail}</span>}
          </button>
        ))}
        {q.trim().length >= 2 && !loading && shown.length === 0 && <div className="rp-empty">No matching records.</div>}
        {q.trim().length < 2 && <div className="rp-empty">Type at least two letters.</div>}
      </div>
    </div>
  );
}
