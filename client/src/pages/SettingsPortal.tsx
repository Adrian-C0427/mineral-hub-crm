import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { Banner } from "../components/ui";
import { Toggle } from "../components/Toggle";

/**
 * Buyer Portal settings — enable/disable and the marketplace URL. Contact
 * information is configured PER DEAL (on each deal's Buyer Portal section), so
 * published listings always show the right representative for that opportunity;
 * there is no global contact manager here anymore.
 */

interface PortalSettings {
  portalSlug: string | null; portalEnabled: boolean;
}

export function SettingsPortal() {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const flash = (m: string) => { setMsg(m); setErr(null); };
  const fail = (e: unknown) => { setErr(e instanceof ApiError ? e.message : "Something went wrong"); setMsg(null); };

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-header"><h1>Buyer Portal</h1></div>
      {msg && <Banner kind="info">{msg}</Banner>}
      {err && <div className="error-text">{err}</div>}
      <PortalGeneral onFlash={flash} onError={fail} />
    </div>
  );
}

function PortalGeneral({ onFlash, onError }: { onFlash: (m: string) => void; onError: (e: unknown) => void }) {
  const [f, setF] = useState({ enabled: false, slug: "" });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<PortalSettings>("/org/portal-settings").then((d) => {
      setF({ enabled: d.portalEnabled, slug: d.portalSlug ?? "" });
      setLoaded(true);
    }).catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The toggle updates immediately (no Save needed for the on/off state).
  async function toggleEnabled(next: boolean) {
    if (next && !f.slug.trim()) { onError(new ApiError(400, "Set a portal URL before enabling the portal.")); return; }
    setF((p) => ({ ...p, enabled: next }));
    try {
      await api.patch("/org/portal-settings", { enabled: next, ...(f.slug.trim() ? { slug: f.slug.trim().toLowerCase() } : {}) });
      onFlash(next ? "Portal enabled." : "Portal disabled.");
    } catch (e) { setF((p) => ({ ...p, enabled: !next })); onError(e); }
  }

  async function saveUrl(e: React.FormEvent) {
    e.preventDefault();
    if (f.enabled && !f.slug.trim()) { onError(new ApiError(400, "Set a portal URL before enabling the portal.")); return; }
    setBusy(true);
    try {
      await api.patch("/org/portal-settings", {
        enabled: f.enabled,
        ...(f.slug.trim() ? { slug: f.slug.trim().toLowerCase() } : {}),
      });
      onFlash("Portal settings saved.");
    } catch (e2) { onError(e2); }
    finally { setBusy(false); }
  }

  if (!loaded) return <div className="panel"><p className="muted">Loading…</p></div>;
  const url = f.slug ? `${window.location.origin}/portal/${f.slug.trim().toLowerCase()}` : null;

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Marketplace</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        The Buyer Offering Portal is your public marketplace: published deals appear at your portal URL, and buyers can browse,
        filter, view offering pages, and submit their acquisition criteria (which creates buyer leads in the CRM).
      </p>
      {/* Modern toggle switch — updates immediately. */}
      <div className="row" style={{ alignItems: "center", gap: 12, marginBottom: 14 }}>
        <Toggle checked={f.enabled} onChange={toggleEnabled} ariaLabel="Portal enabled" />
        <div>
          <strong>Portal {f.enabled ? "enabled" : "disabled"}</strong>
          <div className="muted" style={{ fontSize: 12 }}>{f.enabled ? "Your marketplace is live at the URL below." : "Your marketplace is hidden from buyers."}</div>
        </div>
      </div>
      <form onSubmit={saveUrl} style={{ maxWidth: 520 }}>
        <div className="field">
          <label>Portal URL</label>
          <input value={f.slug} onChange={(e) => setF((p) => ({ ...p, slug: e.target.value }))} placeholder="your-company" />
          {url && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{url}</div>}
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          Branding (logo) comes from Settings → General → Company Branding. Deals are published individually from each deal page,
          where you also set the point of contact shown on that listing.
        </p>
        <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save marketplace settings"}</button>
      </form>
    </div>
  );
}
