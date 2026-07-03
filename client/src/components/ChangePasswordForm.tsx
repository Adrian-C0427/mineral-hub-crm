import { useState } from "react";
import { api, ApiError } from "../api/client";
import { Banner } from "./ui";

/**
 * Self-service password change: current + new + confirm, with client-side
 * complexity validation before the request. Used both in account settings and
 * on the forced-change screen after an owner resets a password.
 */
export function ChangePasswordForm({ onChanged, compact }: { onChanged?: () => void; compact?: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  // Mirrors the server rule (min 8). Extend here + server together if tightened.
  function validate(): string | null {
    if (!current) return "Enter your current password.";
    if (next.length < 8) return "New password must be at least 8 characters.";
    if (next === current) return "New password must be different from your current password.";
    if (next !== confirm) return "New password and confirmation don't match.";
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setOk(false);
    const v = validate();
    if (v) { setError(v); return; }
    setBusy(true); setError(null);
    try {
      await api.post("/auth/change-password", { currentPassword: current, newPassword: next });
      setCurrent(""); setNext(""); setConfirm(""); setOk(true);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change your password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className={compact ? "" : "grid-2"}>
        <div className="field"><label>Current password</label><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></div>
      </div>
      <div className={compact ? "" : "grid-2"}>
        <div className="field"><label>New password</label><input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" /></div>
        <div className="field"><label>Confirm new password</label><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></div>
      </div>
      {error && <div className="error-text">{error}</div>}
      {ok && <Banner kind="info">Password changed.</Banner>}
      <button className="primary" disabled={busy} style={{ marginTop: 4 }}>{busy ? "Saving…" : "Change password"}</button>
    </form>
  );
}
