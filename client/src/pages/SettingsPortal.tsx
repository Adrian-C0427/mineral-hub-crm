import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { showToast } from "../components/ui";
import { Toggle } from "../components/Toggle";
import { SettingsCardHead, SettingsLayout } from "../components/SettingsNav";
import { Tag } from "../components/kit";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

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
    <SettingsLayout>
      <PortalGeneral />
    </SettingsLayout>
  );
}

function PortalGeneral() {
  const { can } = useAuth();
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

  if (!loaded) return <div className="panel"><p className="muted" style={{ margin: 0 }}>Loading…</p></div>;
  const url = f.slug ? `${window.location.origin}/portal/${f.slug.trim().toLowerCase()}` : null;

  return (
    <section className="panel set-card-flush">
      <div className="set-card-pad portal-head">
        <SettingsCardHead
          title="Buyer marketplace"
          badge={<Tag tone={f.enabled ? "success" : "neutral"} dot>{f.enabled ? "Live" : "Off"}</Tag>}
          desc={<>
            The Buyer Offering Portal is your public marketplace: published deals appear at your portal URL, and buyers can browse,
            filter, view offering pages, and submit their acquisition criteria (which creates buyer leads in the CRM).
          </>}
          // Modern toggle switch — updates immediately.
          aside={<Toggle checked={f.enabled} onChange={toggleEnabled} ariaLabel="Portal enabled" />}
        />
        <div className={`portal-state ${f.enabled ? "on" : "off"}`}>
          <strong>Portal {f.enabled ? "enabled" : "disabled"}</strong> · {f.enabled ? "Your marketplace is live at the URL below." : "Your marketplace is hidden from buyers."}
        </div>
      </div>
      <form onSubmit={saveUrl} className="set-card-pad portal-form">
        <div className="field">
          <label htmlFor="portal-slug">Portal URL</label>
          <div className={`portal-slug ${slugError ? "invalid" : ""}`}>
            <span className="portal-slug-prefix">…/portal/</span>
            <input
              id="portal-slug"
              ref={slugRef}
              value={f.slug}
              onChange={(e) => { setF((p) => ({ ...p, slug: e.target.value })); if (slugError) setSlugError(null); }}
              placeholder="your-company"
              spellCheck={false}
              aria-invalid={slugError ? true : undefined}
            />
          </div>
          {slugError && <div className="error-text" style={{ marginTop: 6 }}>{slugError}</div>}
        </div>
        {url && (
          <div className="portal-url">
            <span className="portal-url-text" title={url}>{url}</span>
            <button type="button" className="small" onClick={() => { navigator.clipboard?.writeText(url).then(() => showToast("Portal URL copied")).catch(() => {}); }}>Copy</button>
            <a className="portal-url-open" href={url} target="_blank" rel="noreferrer">
              Open
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8" /></svg>
            </a>
          </div>
        )}
        <div className="portal-actions">
          <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save marketplace settings"}</button>
        </div>
      </form>
      <div className="portal-links">
        <div className="portal-link-cell">
          <span className="portal-link-title">Logo</span>
          <span className="portal-link-text">Branding (logo) comes from Settings → General → Company Branding.</span>
          <Link className="set-link" to="/settings/general#branding">Edit branding →</Link>
        </div>
        <div className="portal-link-cell">
          <span className="portal-link-title">Listings</span>
          <span className="portal-link-text">Deals are published individually from each deal page, where you also set the point of contact shown on that listing.</span>
          {can("viewDeals") && <Link className="set-link" to="/deals/active">Go to deals →</Link>}
        </div>
      </div>
    </section>
  );
}
