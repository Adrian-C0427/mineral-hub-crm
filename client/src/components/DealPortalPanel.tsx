import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner } from "./ui";
import { Toggle } from "./Toggle";
import { PhoneInput } from "./PhoneInput";

type SectionKey = "contact" | "company" | "description" | "documents" | "map" | "wells" | "tracts" | "production" | "attachments" | "notes" | "askPrice";
type Sections = Record<SectionKey, boolean>;

interface PortalState {
  id: string;
  publishedToPortal: boolean;
  portalSlug: string | null;
  portalVisibility: "PUBLIC" | "LINK_ONLY";
  portalFeatured: boolean;
  portalSummary: string | null;
  portalSections: Sections;
  portalAskPrice: number | null;
  askPrice: number | null;
  // Per-deal published contact — the representative shown on THIS listing.
  portalContactName: string | null;
  portalContactTitle: string | null;
  portalContactEmail: string | null;
  portalContactPhone: string | null;
  files?: { id: string; filename: string; folder: string; visibleToBuyers: boolean }[];
}

// Ordered for display; labels are buyer-facing section names.
const SECTION_LABELS: [SectionKey, string][] = [
  ["contact", "Contact information"], ["company", "Company information"],
  ["description", "Deal description"], ["askPrice", "Asking price"],
  ["map", "Map"], ["wells", "Wells"], ["tracts", "Tracts"],
  ["production", "Production information"], ["documents", "Documents"],
  ["attachments", "Attachments"], ["notes", "Notes"],
];

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
  // Local draft for the per-deal contact card (persisted on blur).
  const [contact, setContact] = useState({ name: "", title: "", email: "", phone: "" });
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
    setContact({ name: d.portalContactName ?? "", title: d.portalContactTitle ?? "", email: d.portalContactEmail ?? "", phone: d.portalContactPhone ?? "" });
  }).catch(() => {});
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [dealId]);

  async function patch(body: Record<string, unknown>) {
    setErr(null);
    try {
      const d = await api.patch<PortalState>(`/deals/${dealId}/portal`, body);
      setP((prev) => ({ ...prev!, ...d }));
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Failed to update portal settings"); }
  }
  async function toggleDoc(fileId: string, visible: boolean) {
    try {
      await api.patch(`/files/${fileId}`, { visibleToBuyers: visible });
      setP((prev) => prev ? { ...prev, files: prev.files?.map((f) => (f.id === fileId ? { ...f, visibleToBuyers: visible } : f)) } : prev);
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Failed to update document"); }
  }

  if (!p) return null;
  const shareUrl = p.portalSlug ? `${window.location.origin}/offer/${p.portalSlug}` : null;
  const visibleCount = SECTION_LABELS.filter(([key]) => p.portalSections[key]).length;

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
          <div>
            <h3 style={{ margin: 0 }}>Buyer Portal</h3>
            <div className="dpp-sub">Only buyer-safe fields are shown — pricing, notes, sellers, and internal activity never appear.</div>
          </div>
        </div>
        <span className="dpp-right">
          <span className={`dpp-status ${p.publishedToPortal ? "live" : ""}`}><span className="dot" />{statusLabel}</span>
          {!open && <span className="muted" style={{ fontSize: 12 }}>{visibleCount} of {SECTION_LABELS.length} sections</span>}
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
          <select
            disabled={!canEdit || !p.publishedToPortal}
            value={p.portalVisibility}
            onChange={(e) => patch({ visibility: e.target.value })}
            style={{ width: "auto" }}
          >
            <option value="PUBLIC">Public — listed in the marketplace</option>
            <option value="LINK_ONLY">Private — shared link only</option>
          </select>
        </div>
        <span className="dpp-vdiv" />
        <label className="dpp-switchrow">
          <Toggle checked={p.portalFeatured} disabled={!canEdit || !p.publishedToPortal} onChange={(v) => patch({ featured: v })} />
          <strong>Featured</strong>
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

        {/* Per-deal contact settings — the point of contact differs per listing,
            so it is configured on the deal (not globally). Shown on the offering
            page only when the Contact section below is enabled. */}
        <div style={{ marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <span className="ddx-label">Contact settings</span>
            <span className="muted" style={{ fontSize: 11.5 }}>{p.portalSections.contact ? "Shown on this listing" : "Enable the Contact section to show"}</span>
          </div>
          <div className="grid-2">
            <div className="field" style={{ marginBottom: 8 }}>
              <label>Contact person</label>
              <input disabled={!canEdit} value={contact.name}
                onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))}
                onBlur={() => contact.name !== (p.portalContactName ?? "") && patch({ contactName: contact.name })}
                placeholder="e.g. Jane Doe" />
            </div>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>Job title <span className="muted" style={{ textTransform: "none" }}>(optional)</span></label>
              <input disabled={!canEdit} value={contact.title}
                onChange={(e) => setContact((c) => ({ ...c, title: e.target.value }))}
                onBlur={() => contact.title !== (p.portalContactTitle ?? "") && patch({ contactTitle: contact.title })}
                placeholder="e.g. Land Manager" />
            </div>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>Phone number</label>
              <PhoneInput value={contact.phone} disabled={!canEdit}
                onChange={(v) => setContact((c) => ({ ...c, phone: v }))}
                onBlur={() => contact.phone !== (p.portalContactPhone ?? "") && patch({ contactPhone: contact.phone })} />
            </div>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>Email address</label>
              <input type="email" disabled={!canEdit} value={contact.email}
                onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))}
                onBlur={() => contact.email !== (p.portalContactEmail ?? "") && patch({ contactEmail: contact.email })}
                placeholder="name@company.com" />
            </div>
          </div>
        </div>

        {/* Per-deal section visibility — saved only on this deal. */}
        <div style={{ marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <span className="ddx-label">Sections shown on this listing</span>
            <span className="muted" style={{ fontSize: 11.5 }}>{visibleCount} of {SECTION_LABELS.length} visible</span>
          </div>
          <div className="dpp-sections">
            {SECTION_LABELS.map(([key, label]) => {
              const on = p.portalSections[key];
              return (
                <button
                  key={key} type="button" disabled={!canEdit}
                  className={`dpp-sec ${on ? "on" : ""}`}
                  onClick={() => { const sections = { ...p.portalSections, [key]: !on }; setP((prev) => prev ? { ...prev, portalSections: sections } : prev); patch({ sections: { [key]: !on } }); }}
                >
                  {on && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>}
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Asking price — defaults to the deal's Ask Price; overridable for the
            listing only (never changes the deal). */}
        {p.portalSections.askPrice && (
          <div style={{ marginBottom: 16, maxWidth: 340 }}>
            <div className="ddx-label" style={{ marginBottom: 8 }}>Published asking price</div>
            <input
              type="number" min="0" disabled={!canEdit}
              value={askOverride}
              placeholder={p.askPrice != null ? `Deal ask: $${p.askPrice.toLocaleString()}` : "No deal ask price set"}
              onChange={(e) => setAskOverride(e.target.value)}
              onBlur={() => { const v = askOverride.trim() === "" ? null : Number(askOverride); if (v !== p.portalAskPrice) { setP((prev) => prev ? { ...prev, portalAskPrice: v } : prev); patch({ askPrice: v }); } }}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Leave blank to use the deal's Ask Price ({p.askPrice != null ? `$${p.askPrice.toLocaleString()}` : "not set"}). This override doesn't change the deal.</div>
          </div>
        )}

        {(p.files?.length ?? 0) > 0 && (
          <div>
            <div className="ddx-label" style={{ marginBottom: 8 }}>Documents visible to buyers</div>
            {p.files!.map((f) => (
              <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 14 }}>
                <input type="checkbox" disabled={!canDocs} checked={f.visibleToBuyers} onChange={(e) => toggleDoc(f.id, e.target.checked)} />
                {f.filename} <span className="muted" style={{ fontSize: 12 }}>· {f.folder}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
