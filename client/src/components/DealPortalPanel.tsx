import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, FileText, Globe, Star, X } from "lucide-react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner } from "./ui";
import { Toggle } from "./Toggle";
import { PhoneInput } from "./PhoneInput";
import { Select } from "./Select";

// A per-deal published contact. `id` is a stable key for React + reordering.
interface DealContact { id: string; name: string; title: string | null; email: string | null; phone: string | null }

interface PortalState {
  id: string;
  publishedToPortal: boolean;
  portalSlug: string | null;
  portalVisibility: "PUBLIC" | "LINK_ONLY";
  portalFeatured: boolean;
  portalSummary: string | null;
  portalAskPrice: number | null;
  askPrice: number | null;
  // Per-deal published contacts — the representatives shown on THIS listing.
  contacts: DealContact[];
  files?: { id: string; filename: string; folder: string; visibleToBuyers: boolean }[];
}

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(36).slice(2, 7)}`);
const blankContact = (): DealContact => ({ id: newId(), name: "", title: "", email: "", phone: "" });

/**
 * "Buyer Portal" admin panel on the deal page: publish/unpublish, public vs
 * link-only visibility, featured flag, buyer-facing summary, per-document
 * approval, and the copyable share link.
 */
export function DealPortalPanel({ dealId }: { dealId: string }) {
  const { can } = useAuth();
  const [p, setP] = useState<PortalState | null>(null);
  const [summary, setSummary] = useState("");
  const [askOverride, setAskOverride] = useState("");
  // Local draft for the per-deal contacts (persisted on blur / structural change).
  const [contacts, setContacts] = useState<DealContact[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Collapsed by default — the portal controls are a secondary, occasional task,
  // so the panel stays out of the way until the user expands it.
  const [open, setOpen] = useState(false);
  // Publish controls need publishOfferings; buyer-visibility of a document is a
  // document action (manageDocuments) — mirrors the server gates.
  const canEdit = can("publishOfferings");
  const canDocs = can("manageDocuments");

  const load = () => api.get<PortalState>(`/deals/${dealId}/portal`).then((d) => {
    setP(d); setSummary(d.portalSummary ?? ""); setAskOverride(d.portalAskPrice != null ? String(d.portalAskPrice) : "");
    // Default to one contact so a new deal always shows a contact row to fill in.
    setContacts(d.contacts.length ? d.contacts : [blankContact()]);
  }).catch(() => {});
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [dealId]);

  async function patch(body: Record<string, unknown>) {
    setErr(null);
    try {
      const d = await api.patch<PortalState>(`/deals/${dealId}/portal`, body);
      setP((prev) => ({ ...prev!, ...d }));
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Failed to update portal settings"); }
  }

  // Persist the contact list (drops rows with no data server-side). Reused by
  // field-blur, add, remove, and reorder so every change saves to this deal only.
  async function saveContacts(next: DealContact[]) {
    await patch({ contacts: next.map((c) => ({ id: c.id, name: c.name, title: c.title, email: c.email, phone: c.phone })) });
  }
  function updateContact(id: string, field: keyof DealContact, value: string) {
    setContacts((cs) => cs.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  }
  function addContact() { const next = [...contacts, blankContact()]; setContacts(next); }
  function removeContact(id: string) { const next = contacts.filter((c) => c.id !== id); const list = next.length ? next : [blankContact()]; setContacts(list); void saveContacts(list); }
  function moveContact(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= contacts.length) return;
    const next = [...contacts];
    [next[idx], next[j]] = [next[j], next[idx]];
    setContacts(next); void saveContacts(next);
  }
  async function toggleDoc(fileId: string, visible: boolean) {
    try {
      await api.patch(`/files/${fileId}`, { visibleToBuyers: visible });
      setP((prev) => prev ? { ...prev, files: prev.files?.map((f) => (f.id === fileId ? { ...f, visibleToBuyers: visible } : f)) } : prev);
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Failed to update document"); }
  }

  if (!p) return null;
  const shareUrl = p.portalSlug ? `${window.location.origin}/offer/${p.portalSlug}` : null;

  const statusLabel = p.publishedToPortal ? (p.portalVisibility === "PUBLIC" ? "Published · Public" : "Published · Link only") : "Not published";

  return (
    <div className={`panel dpp-panel ${open ? "open" : ""}`}>
      <div
        className="dpp-head"
        role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
      >
        <div className="dpp-title">
          <span className="dpp-ico" aria-hidden="true"><Globe size={16} /></span>
          <div>
            <h3 style={{ margin: 0 }}>Buyer Portal</h3>
            <div className="dpp-sub">Only buyer-safe fields are shown — pricing, notes, sellers, and internal activity never appear.</div>
          </div>
        </div>
        <span className="dpp-right">
          <span className={`dpp-status ${p.publishedToPortal ? "live" : ""}`}><span className="dot" />{statusLabel}</span>
          <span className="muted" style={{ fontSize: 12.5 }}>{open ? "Collapse" : "Expand"}</span>
          <span className={`va-chev ${open ? "" : "down"}`}>⌃</span>
        </span>
      </div>

      {open && (
      <>
      {/* Publish controls strip */}
      <div className="dpp-controls">
        <label className="dpp-switchrow" title={canEdit ? undefined : "Requires the publish permission"}>
          <Toggle checked={p.publishedToPortal} disabled={!canEdit} onChange={(v) => patch({ published: v })} />
          <strong>Published</strong>
        </label>
        <span className="dpp-vdiv" />
        <div className="dpp-switchrow">
          <span className="ddx-label">Visibility</span>
          <Select
            disabled={!canEdit || !p.publishedToPortal}
            value={p.portalVisibility}
            onChange={(v) => patch({ visibility: v })}
            width={280}
            ariaLabel="Portal visibility"
            options={[
              { value: "PUBLIC", label: "Public — listed in the marketplace" },
              { value: "LINK_ONLY", label: "Private — shared link only" },
            ]}
          />
        </div>
        <span className="dpp-vdiv" />
        <label className="dpp-switchrow">
          <Toggle checked={p.portalFeatured} disabled={!canEdit || !p.publishedToPortal} onChange={(v) => patch({ featured: v })} />
          <strong style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>Featured <Star size={13} className="dpp-star" aria-hidden="true" /></strong>
        </label>
      </div>

      <div className="dpp-body">
        {err && <Banner kind="error">{err}</Banner>}

        {shareUrl && (
          <div style={{ marginBottom: 16 }}>
            <div className="ddx-label" style={{ marginBottom: 8 }}>Share link</div>
            <div className="dpp-share">
              <span className="dpp-share-ico">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg>
              </span>
              <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
              {p.publishedToPortal && <a className="dpp-preview" href={shareUrl} target="_blank" rel="noreferrer">Preview ↗</a>}
              <button className="dpp-copy" onClick={() => { void navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            </div>
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <span className="ddx-label">Buyer-facing summary</span>
            <span className="muted" style={{ fontSize: 11.5 }}>Shown on the offering page</span>
          </div>
          <textarea rows={3} disabled={!canEdit} value={summary} onChange={(e) => setSummary(e.target.value)} onBlur={() => summary !== (p.portalSummary ?? "") && patch({ summary })} placeholder="Describe the opportunity for buyers…" />
        </div>

        {/* Per-deal contacts — the point(s) of contact differ per listing, so they
            are configured on the deal (not globally). All are shown on the
            offering page when the Contact section below is enabled. */}
        <div style={{ marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <span className="ddx-label">Contacts</span>
            <span className="muted" style={{ fontSize: 11.5 }}>Shown on this listing when filled in</span>
          </div>
          {contacts.map((c, i) => (
            <div key={c.id} className="dpp-contact">
              <div className="dpp-contact-head">
                <span className="dpp-contact-name">
                  <span className="dpp-cnum" aria-hidden="true">{i + 1}</span>
                  {i === 0 ? "Primary contact" : `Contact ${i + 1}`}
                </span>
                {canEdit && (
                  <div className="row" style={{ gap: 6 }}>
                    <button className="dpp-cbtn" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => moveContact(i, -1)}><ArrowUp size={12} /></button>
                    <button className="dpp-cbtn" title="Move down" aria-label="Move down" disabled={i === contacts.length - 1} onClick={() => moveContact(i, 1)}><ArrowDown size={12} /></button>
                    <button className="dpp-cbtn danger" title="Remove contact" aria-label="Remove contact" onClick={() => removeContact(c.id)}><X size={12} /></button>
                  </div>
                )}
              </div>
              <div className="grid-2">
                <div className="field" style={{ marginBottom: 8 }}>
                  <label>Contact person</label>
                  <input disabled={!canEdit} value={c.name}
                    onChange={(e) => updateContact(c.id, "name", e.target.value)}
                    onBlur={() => saveContacts(contacts)} placeholder="e.g. Jane Doe" />
                </div>
                <div className="field" style={{ marginBottom: 8 }}>
                  <label>Job title <span className="muted" style={{ textTransform: "none" }}>(optional)</span></label>
                  <input disabled={!canEdit} value={c.title ?? ""}
                    onChange={(e) => updateContact(c.id, "title", e.target.value)}
                    onBlur={() => saveContacts(contacts)} placeholder="e.g. Land Manager" />
                </div>
                <div className="field" style={{ marginBottom: 8 }}>
                  <label>Phone number</label>
                  <PhoneInput value={c.phone ?? ""} disabled={!canEdit}
                    onChange={(v) => updateContact(c.id, "phone", v)}
                    onBlur={() => saveContacts(contacts)} />
                </div>
                <div className="field" style={{ marginBottom: 8 }}>
                  <label>Email address</label>
                  <input type="email" disabled={!canEdit} value={c.email ?? ""}
                    onChange={(e) => updateContact(c.id, "email", e.target.value)}
                    onBlur={() => saveContacts(contacts)} placeholder="name@company.com" />
                </div>
              </div>
            </div>
          ))}
          {canEdit && <button className="dpp-addcontact" onClick={addContact}>+ Add contact</button>}
        </div>

        {/* The offering auto-displays every section that has data — empty
            fields are simply omitted from the published page. */}

        {/* Asking price — defaults to the deal's Ask Price; overridable for the
            listing only (never changes the deal). */}
        <div className="dpp-price">
          <div style={{ minWidth: 260 }}>
            <div className="ddx-label" style={{ marginBottom: 8 }}>Published asking price</div>
            <input
              type="number" min="0" disabled={!canEdit}
              value={askOverride}
              placeholder={p.askPrice != null ? `Deal ask: $${p.askPrice.toLocaleString()}` : "No deal ask price set"}
              onChange={(e) => setAskOverride(e.target.value)}
              onBlur={() => { const v = askOverride.trim() === "" ? null : Number(askOverride); if (v !== p.portalAskPrice) { setP((prev) => prev ? { ...prev, portalAskPrice: v } : prev); patch({ askPrice: v }); } }}
            />
          </div>
          <div className="dpp-price-note">Leave blank to use the deal's Ask Price <b>({p.askPrice != null ? `$${p.askPrice.toLocaleString()}` : "not set"})</b>. This override doesn't change the deal.</div>
        </div>

        {(p.files?.length ?? 0) > 0 && (
          <div>
            <div className="ddx-label" style={{ marginBottom: 10 }}>Documents visible to buyers</div>
            <div className="dpp-docs">
              {p.files!.map((f) => (
                <label key={f.id} className={`dpp-doc ${f.visibleToBuyers ? "on" : ""}`}>
                  <input type="checkbox" disabled={!canDocs} checked={f.visibleToBuyers} onChange={(e) => toggleDoc(f.id, e.target.checked)} />
                  <span className="dpp-doc-ico" aria-hidden="true"><FileText size={14} /></span>
                  <span className="dpp-doc-name">{f.filename}</span>
                  <span className="dpp-doc-folder">{f.folder}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
