import { useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner } from "./ui";
import { ThemedLogo } from "./ThemedLogo";
import { SettingsCardHead } from "./SettingsNav";
import { usableLogo } from "../lib/branding";
import { useLogoFailures } from "../lib/useBrandLogo";

/**
 * Company Branding settings: upload a Full logo (expanded sidebar, PDF/report
 * headers) and a Compact logo/icon (collapsed sidebar). Logos are stored as
 * data URLs on the organization; removing one reverts to the default Mineral
 * Hub branding. Drag-and-drop or click to upload, with a live preview.
 *
 * Raster formats only — the server refuses SVG (routes/org.ts LOGO_MIME: logos
 * are echoed on the public portal), so the picker must not offer it.
 */

const ACCEPT = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 512 * 1024;
const ACCEPT_ATTR = ".png,.jpg,.jpeg,.webp";

type Field = "fullLogo" | "compactLogo";

export function CompanyBranding() {
  const { user, refresh, can } = useAuth();
  const org = user?.organization;
  const canManage = can("manageOrgSettings");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Field | null>(null);

  async function save(field: Field, value: string | null) {
    setBusy(field); setError(null);
    try {
      await api.patch("/org/branding", { [field]: value });
      await refresh(); // updates the sidebar immediately
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save logo");
    } finally { setBusy(null); }
  }

  function onFile(field: Field, file: File) {
    setError(null);
    if (!ACCEPT.includes(file.type)) { setError("Unsupported file type. Use PNG, JPG, or WebP."); return; }
    if (file.size > MAX_BYTES) { setError(`"${file.name}" is too large (max 512 KB).`); return; }
    const reader = new FileReader();
    reader.onload = () => save(field, String(reader.result));
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsDataURL(file);
  }

  return (
    <section className="panel">
      <SettingsCardHead
        title="Company branding"
        desc="Replace the default Mineral Hub branding with your own logos. They appear in the navigation sidebar and on exported PDF reports. Supported: PNG, JPG, WebP · max 512 KB."
      />
      {error && <Banner kind="error">{error}</Banner>}
      <div className="logo-slots">
        <LogoSlot
          label="Full logo" hint="Expanded sidebar · PDF reports & headers"
          current={usableLogo(org?.fullLogo)} defaultLabel="Mineral Hub" busy={busy === "fullLogo"} disabled={!canManage}
          onFile={(f) => onFile("fullLogo", f)} onRemove={() => save("fullLogo", null)}
        />
        <LogoSlot
          label="Compact logo (icon)" hint="Collapsed sidebar · square, recognizable at small sizes" square
          current={usableLogo(org?.compactLogo)} defaultLabel="MH" busy={busy === "compactLogo"} disabled={!canManage}
          onFile={(f) => onFile("compactLogo", f)} onRemove={() => save("compactLogo", null)}
        />
      </div>
      {!canManage && <p className="set-meta">You need the “Manage Organization Settings” permission to change branding.</p>}
    </section>
  );
}

function LogoSlot({ label, hint, current, defaultLabel, square, busy, disabled, onFile, onRemove }: {
  label: string; hint: string; current: string | null; defaultLabel: string;
  square?: boolean; busy: boolean; disabled: boolean;
  onFile: (f: File) => void; onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  // A stored logo the browser can't decode: say so (the sidebar falls back on
  // its own) instead of a broken-image preview.
  const { failed, markFailed } = useLogoFailures();
  const broken = !!current && failed.has(current);
  const pick = () => { if (!disabled) inputRef.current?.click(); };

  return (
    <div className="logo-slot">
      <div className="logo-slot-head">
        <span className="logo-slot-title">{label}</span>
        <span className="logo-slot-hint">{hint}</span>
      </div>
      <div
        className={`logo-drop ${drag ? "drag" : ""} ${square ? "square" : ""} ${disabled ? "disabled" : ""}`}
        onClick={pick}
        onDragOver={(e) => { if (!disabled) { e.preventDefault(); setDrag(true); } }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (!disabled && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}
        role="button" tabIndex={0}
      >
        {busy ? <span className="muted">Saving…</span>
          : broken ? (
            <span className="logo-empty">
              <span className="logo-empty-title">This logo can’t be displayed</span>
              <span className="logo-default">{disabled ? "Ask an admin to replace it" : "Upload a replacement"}</span>
            </span>
          )
          : current ? <ThemedLogo src={current} alt={label} className="logo-preview" onError={markFailed} />
          : (
            <span className="logo-empty">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
              <span className="logo-empty-title">{disabled ? "Default logo" : "Drop a file or browse"}</span>
              <span className="logo-default">{defaultLabel}<span> · default</span></span>
            </span>
          )}
      </div>
      <div className="logo-slot-actions">
        <button type="button" className="small" onClick={pick} disabled={disabled || busy}>{current ? "Replace" : "Upload"}</button>
        {current && <button type="button" className="small set-btn-danger-text" onClick={onRemove} disabled={disabled || busy}>Remove</button>}
      </div>
      <input ref={inputRef} type="file" accept={ACCEPT_ATTR} style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </div>
  );
}
