import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, ApiError } from "../api/client";
import { Banner, ConfirmDialog } from "./ui";
import { Tag } from "./kit";
import { SettingsCardHead } from "./SettingsNav";

/**
 * Two-factor (TOTP) management for the account settings page: enroll (scan a QR
 * code or enter the key manually), confirm a code to enable, view/copy one-time
 * recovery codes, regenerate them, and disable.
 */

interface Status { enabled: boolean; recoveryCodesRemaining: number }
interface SetupResp { secret: string; otpauthUri: string }

export function TwoFactorSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Enrollment state
  const [setup, setSetup] = useState<SetupResp | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [enableCode, setEnableCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Render the otpauth URI to a scannable QR image whenever setup starts.
  useEffect(() => {
    if (!setup) { setQr(null); return; }
    QRCode.toDataURL(setup.otpauthUri, { width: 200, margin: 1 }).then(setQr).catch(() => setQr(null));
  }, [setup]);

  // Disable / regenerate state
  const [manageCode, setManageCode] = useState("");
  const [showDisable, setShowDisable] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const load = () => api.get<Status>("/auth/2fa/status").then(setStatus).catch(() => setStatus({ enabled: false, recoveryCodesRemaining: 0 }));
  useEffect(() => { load(); }, []);

  async function startSetup() {
    setError(null); setBusy(true); setRecoveryCodes(null);
    try {
      setSetup(await api.post<SetupResp>("/auth/2fa/setup"));
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not start setup"); }
    finally { setBusy(false); }
  }

  async function enable() {
    setError(null); setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/auth/2fa/enable", { code: enableCode.trim() });
      setRecoveryCodes(r.recoveryCodes);
      setSetup(null);
      setEnableCode("");
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not enable"); }
    finally { setBusy(false); }
  }

  async function disable() {
    setConfirmDisable(false);
    setError(null); setBusy(true);
    try {
      await api.post("/auth/2fa/disable", { code: manageCode.trim() });
      setManageCode(""); setShowDisable(false); setRecoveryCodes(null);
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not disable"); }
    finally { setBusy(false); }
  }

  async function regenerate() {
    setError(null); setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", { code: manageCode.trim() });
      setRecoveryCodes(r.recoveryCodes);
      setManageCode("");
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not regenerate codes"); }
    finally { setBusy(false); }
  }

  const enabled = !!status?.enabled;
  return (
    <section className="panel twofa-card">
      <SettingsCardHead
        title="Two-factor authentication"
        badge={status && <Tag tone={enabled ? "success" : "neutral"} dot>{enabled ? "On" : "Off"}</Tag>}
        desc="Add a one-time code from an authenticator app (Google Authenticator, Authy, 1Password…) as a second step when signing in."
        aside={
          status && !enabled && !setup ? (
            <button className="primary" disabled={busy} onClick={startSetup}>{busy ? "Please wait…" : "Set up"}</button>
          ) : enabled && !showDisable ? (
            <button onClick={() => setShowDisable(true)}>Manage / disable</button>
          ) : null
        }
      />

      {error && <Banner kind="error">{error}</Banner>}

      {recoveryCodes && (
        <Banner kind="warn">
          <strong>Save your recovery codes.</strong> Each can be used once if you lose your authenticator. They won't be shown again.
          <div className="recovery-grid">{recoveryCodes.map((c) => <code key={c}>{c}</code>)}</div>
          <button className="small" style={{ marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(recoveryCodes.join("\n")).catch(() => {})}>Copy all</button>
        </Banner>
      )}

      {setup && (
        <div className="twofa-setup">
          <div className="twofa-qr">
            {qr ? <img src={qr} alt="Two-factor QR code" width={150} height={150} /> : <span>QR code</span>}
          </div>
          <div className="twofa-steps">
            <span className="twofa-step"><b>1.</b> Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.). Can’t scan? Enter this key manually instead:</span>
            <div className="twofa-secret">
              <code>{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
              <button className="small" onClick={() => navigator.clipboard?.writeText(setup.secret).catch(() => {})}>Copy</button>
            </div>
            <span className="twofa-note">Issuer “Mineral Hub”, time-based, 6 digits.</span>
            <span className="twofa-step"><b>2.</b> Enter the current 6-digit code to confirm:</span>
            <div className="twofa-verify">
              <input className="twofa-code" value={enableCode} onChange={(e) => setEnableCode(e.target.value)} inputMode="numeric" placeholder="123456" />
              <button className="primary" disabled={busy || !enableCode.trim()} onClick={enable}>Verify and turn on</button>
              <button className="set-btn-ghost" onClick={() => { setSetup(null); setEnableCode(""); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {enabled && status && (
        <p className="set-meta">{status.recoveryCodesRemaining} recovery code{status.recoveryCodesRemaining === 1 ? "" : "s"} remaining.</p>
      )}
      {enabled && showDisable && (
        <div className="twofa-manage">
          <div className="field">
            <label>Current code (or recovery code)</label>
            <input className="twofa-code" value={manageCode} onChange={(e) => setManageCode(e.target.value)} inputMode="numeric" placeholder="123456" />
          </div>
          <div className="row">
            <button disabled={busy || !manageCode.trim()} onClick={regenerate}>Regenerate recovery codes</button>
            <button className="danger" disabled={busy || !manageCode.trim()} onClick={() => setConfirmDisable(true)}>Disable 2FA</button>
            <button className="set-btn-ghost" onClick={() => { setShowDisable(false); setManageCode(""); }}>Cancel</button>
          </div>
        </div>
      )}
      {confirmDisable && (
        <ConfirmDialog
          title="Disable two-factor authentication?"
          message={<p style={{ margin: 0 }}>Your account will no longer require a second step when signing in. Are you sure you want to save this change?</p>}
          confirmLabel="Disable 2FA"
          danger
          busy={busy}
          onCancel={() => setConfirmDisable(false)}
          onConfirm={disable}
        />
      )}
    </section>
  );
}
