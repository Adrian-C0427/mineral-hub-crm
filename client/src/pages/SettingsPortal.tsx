import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { showToast } from "../components/ui";
import { Toggle } from "../components/Toggle";
import { SettingsNav } from "../components/SettingsNav";

/**
 * Buyer Portal settings — enable/disable and the marketplace URL. Contact
 * information is configured PER DEAL (on each deal's Buyer Portal section), so
 * published listings always show the right representative for that opportunity;
 * there is no global contact manager here anymore.
 *
 * Feedback rules: successes are toasts (fixed position — the form never jumps
 * under the cursor); validation problems render inline next to the control
 * that caused them, and focus moves to the field that fixes the problem.
 */

interface PortalSettings {
  portalSlug: string | null; portalEnabled: boolean;
}

export function SettingsPortal() {
  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-header"><h1>Settings</h1></div>
      <SettingsNav />
      <PortalGeneral />
    </div>
  );
}

function PortalGeneral() {
  const [f, setF] = useState({ enabled: false, slug: "" });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);
  const slugRef = useRef<HTMLInputElement>(null);

  const fail = (e: unknown) => showToast(e instanceof ApiError ? e.message : "Something went wrong", "error");

  useEffect(() => {
    api.get<PortalSettings>("/org/portal-settings").then((d) => {
      setF({ enabled: d.portalEnabled, slug: d.portalSlug ?? "" });
      setLoaded(true);
    }).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The toggle updates immediately (no Save needed for the on/off state).
  async function toggleEnabled(next: boolean) {
    if (next && !f.slug.trim()) {
      setSlugError("Set a portal URL first — buyers need an address to visit.");
      slugRef.current?.focus();
      return;
    }
    setF((p) => ({ ...p, enabled: next }));
    try {
      await api.patch("/org/portal-settings", { enabled: next, ...(f.slug.trim() ? { slug: f.slug.trim().toLowerCase() } : {}) });
      showToast(next ? "Portal enabled — your marketplace is live." : "Portal disabled.");
    } catch (e) { setF((p) => ({ ...p, enabled: !next })); fail(e); }
  }

  async function saveUrl(e: React.FormEvent) {
    e.preventDefault();
    if (f.enabled && !f.slug.trim()) {
      setSlugError("The portal is enabled, so it needs a URL.");
      slugRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.patch("/org/portal-settings", {
        enabled: f.enabled,
        ...(f.slug.trim() ? { slug: f.slug.trim().toLowerCase() } : {}),
      });
      showToast("Portal settings saved.");
    } catch (e2) { fail(e2); }
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
          <input
            ref={slugRef}
            value={f.slug}
            onChange={(e) => { setF((p) => ({ ...p, slug: e.target.value })); if (slugError) setSlugError(null); }}
            placeholder="your-company"
            aria-invalid={slugError ? true : undefined}
          />
          {slugError && <div className="error-text" style={{ marginTop: 6 }}>{slugError}</div>}
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
