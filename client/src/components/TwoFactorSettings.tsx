import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { Banner } from "./ui";

/**
 * Two-factor (TOTP) management for the account settings page: enroll (secret +
 * manual key), confirm a code to enable, view/copy one-time recovery codes,
 * regenerate them, and disable. QR rendering is intentionally omitted (no extra
 * dependency) — every authenticator app supports manual key entry.
 */

interface Status { enabled: boolean; recoveryCodesRemaining: number }
interface SetupResp { secret: string; otpauthUri: string }

export function TwoFactorSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Enrollment state
  const [setup, setSetup] = useState<SetupResp | null>(null);
  const [enableCode, setEnableCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Disable / regenerate state
  const [manageCode, setManageCode] = useState("");
  const [showDisable, setShowDisable] = useState(false);

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

  return (
    <div className="panel">
      <div className="section-head">
        <h3 style={{ margin: 0 }}>Two-Factor Authentication</h3>
        <span className={`badge ${status?.enabled ? "resp-offer" : "resp-pending"}`}>{status?.enabled ? "Enabled" : "Disabled"}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Add a one-time code from an authenticator app (Google Authenticator, Authy, 1Password…) as a second step when signing in.
      </p>

      {error && <Banner kind="error">{error}</Banner>}

      {recoveryCodes && (
        <Banner kind="warn">
          <strong>Save your recovery codes.</strong> Each can be used once if you lose your authenticator. They won't be shown again.
          <div className="recovery-grid">{recoveryCodes.map((c) => <code key={c}>{c}</code>)}</div>
          <button className="small" style={{ marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(recoveryCodes.join("\n")).catch(() => {})}>Copy all</button>
        </Banner>
      )}

      {status && !status.enabled && !setup && (
        <button className="primary" disabled={busy} onClick={startSetup}>{busy ? "Please wait…" : "Enable two-factor authentication"}</button>
      )}

      {setup && (
        <div>
          <ol className="twofa-steps">
            <li>
              In your authenticator app, add an account and enter this key manually:
              <div className="twofa-secret">
                <code>{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                <button className="small" onClick={() => navigator.clipboard?.writeText(setup.secret).catch(() => {})}>Copy</button>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>Issuer “Mineral Hub”, time-based, 6 digits.</span>
            </li>
            <li>
              Enter the current 6-digit code to confirm:
              <div className="row" style={{ marginTop: 6 }}>
                <input value={enableCode} onChange={(e) => setEnableCode(e.target.value)} inputMode="numeric" placeholder="123456" style={{ width: 140 }} />
                <button className="primary" disabled={busy || !enableCode.trim()} onClick={enable}>Confirm &amp; enable</button>
                <button className="small" onClick={() => { setSetup(null); setEnableCode(""); }}>Cancel</button>
              </div>
            </li>
          </ol>
        </div>
      )}

      {status?.enabled && (
        <div>
          <p className="muted" style={{ marginBottom: 8 }}>{status.recoveryCodesRemaining} recovery code{status.recoveryCodesRemaining === 1 ? "" : "s"} remaining.</p>
          {!showDisable ? (
            <div className="row">
              <button className="small" onClick={() => setShowDisable(true)}>Manage / disable</button>
            </div>
          ) : (
            <div>
              <div className="field" style={{ maxWidth: 240 }}>
                <label>Current code (or recovery code)</label>
                <input value={manageCode} onChange={(e) => setManageCode(e.target.value)} inputMode="numeric" placeholder="123456" />
              </div>
              <div className="row">
                <button className="small" disabled={busy || !manageCode.trim()} onClick={regenerate}>Regenerate recovery codes</button>
                <button className="danger" disabled={busy || !manageCode.trim()} onClick={disable}>Disable 2FA</button>
                <button className="small" onClick={() => { setShowDisable(false); setManageCode(""); }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
