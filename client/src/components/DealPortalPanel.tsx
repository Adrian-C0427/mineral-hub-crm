import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner } from "./ui";

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
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Collapsed by default — the portal controls are a secondary, occasional task,
  // so the panel stays out of the way until the user expands it.
  const [open, setOpen] = useState(false);
  // Publish controls need publishOfferings; buyer-visibility of a document is a
  // document action (manageDocuments) — mirrors the server gates.
  const canEdit = can("publishOfferings");
  const canDocs = can("manageDocuments");

  const load = () => api.get<PortalState>(`/deals/${dealId}/portal`).then((d) => { setP(d); setSummary(d.portalSummary ?? ""); setAskOverride(d.portalAskPrice != null ? String(d.portalAskPrice) : ""); }).catch(() => {});
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

  return (
    <div className="panel">
      <div
        className="section-head dpp-head"
        role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
      >
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Buyer Portal</h3>
          <span className={`badge ${p.publishedToPortal ? "resp-offer" : "resp-pending"}`}>{p.publishedToPortal ? (p.portalVisibility === "PUBLIC" ? "Live · Public" : "Live · Link only") : "Not published"}</span>
        </div>
        <span className="dpp-toggle">
          {!open && <span className="muted" style={{ fontSize: 12 }}>{visibleCount} of {SECTION_LABELS.length} sections shown</span>}
          <span className="muted" style={{ fontSize: 12.5 }}>{open ? "Collapse" : "Expand"}</span>
          <span className={`va-chev ${open ? "" : "down"}`}>⌃</span>
        </span>
      </div>

      {open && (
      <>
      <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
        Publish this deal to the external offering portal. Only buyer-safe fields are shown — pricing, notes, sellers, and internal activity never appear.
      </p>
      {err && <Banner kind="error">{err}</Banner>}

      <div className="row" style={{ gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" disabled={!canEdit} checked={p.publishedToPortal} onChange={(e) => patch({ published: e.target.checked })} />
          <strong>Published</strong>
        </label>
        <select
          disabled={!canEdit || !p.publishedToPortal}
          value={p.portalVisibility}
          onChange={(e) => patch({ visibility: e.target.value })}
          style={{ width: "auto" }}
        >
          <option value="PUBLIC">Public — listed in the marketplace</option>
          <option value="LINK_ONLY">Private — shared link only</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" disabled={!canEdit || !p.publishedToPortal} checked={p.portalFeatured} onChange={(e) => patch({ featured: e.target.checked })} />
          Featured
        </label>
      </div>

      {shareUrl && (
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: "wrap" }}>
          <input readOnly value={shareUrl} style={{ flex: 1, minWidth: 260, fontSize: 13 }} onFocus={(e) => e.target.select()} />
          <button className="small" onClick={() => { void navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? "Copied ✓" : "Copy link"}
          </button>
          {p.publishedToPortal && <a className="small" style={{ textDecoration: "none" }} href={shareUrl} target="_blank" rel="noreferrer"><button className="small">Preview ↗</button></a>}
        </div>
      )}

      <div className="field" style={{ marginTop: 12 }}>
        <label>Buyer-facing summary (shown on the offering page)</label>
        <textarea rows={3} disabled={!canEdit} value={summary} onChange={(e) => setSummary(e.target.value)} onBlur={() => summary !== (p.portalSummary ?? "") && patch({ summary })} placeholder="Describe the opportunity for buyers…" />
      </div>

      {/* Per-deal section visibility — saved only on this deal. */}
      <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", margin: "10px 0 6px" }}>
        Sections shown on this listing <span style={{ textTransform: "none", letterSpacing: 0 }}>· {visibleCount} of {SECTION_LABELS.length} visible</span>
      </div>
      <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
        {SECTION_LABELS.map(([key, label]) => (
          <label key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input
              type="checkbox" disabled={!canEdit}
              checked={p.portalSections[key]}
              onChange={(e) => { const sections = { ...p.portalSections, [key]: e.target.checked }; setP((prev) => prev ? { ...prev, portalSections: sections } : prev); patch({ sections: { [key]: e.target.checked } }); }}
            />
            {label}
          </label>
        ))}
      </div>

      {/* Asking price — defaults to the deal's Ask Price; overridable for the
          listing only (never changes the deal). */}
      {p.portalSections.askPrice && (
        <div className="field" style={{ marginTop: 12, maxWidth: 320 }}>
          <label>Published asking price</label>
          <input
            type="number" min="0" disabled={!canEdit}
            value={askOverride}
            placeholder={p.askPrice != null ? `Deal ask: $${p.askPrice.toLocaleString()}` : "No deal ask price set"}
            onChange={(e) => setAskOverride(e.target.value)}
            onBlur={() => { const v = askOverride.trim() === "" ? null : Number(askOverride); if (v !== p.portalAskPrice) { setP((prev) => prev ? { ...prev, portalAskPrice: v } : prev); patch({ askPrice: v }); } }}
          />
          <span className="muted" style={{ fontSize: 12 }}>Leave blank to use the deal's Ask Price ({p.askPrice != null ? `$${p.askPrice.toLocaleString()}` : "not set"}). This override doesn't change the deal.</span>
        </div>
      )}

      {(p.files?.length ?? 0) > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", margin: "10px 0 6px" }}>Documents visible to buyers</div>
          {p.files!.map((f) => (
            <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 14 }}>
              <input type="checkbox" disabled={!canDocs} checked={f.visibleToBuyers} onChange={(e) => toggleDoc(f.id, e.target.checked)} />
              {f.filename} <span className="muted" style={{ fontSize: 12 }}>· {f.folder}</span>
            </label>
          ))}
        </>
      )}
      </>
      )}
    </div>
  );
}
