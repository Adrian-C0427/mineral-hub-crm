import { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { AuthError, AuthLayout, AuthTitle } from "./Login";

/** Standalone page reached from the emailed reset link: /reset-password?token=… */
export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setBusy(true);
    try {
      await api.post("/auth/password/reset", { token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset your password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      {!token ? (
        <div className="auth-form">
          <AuthTitle title="Reset your password" sub="This reset link is missing its token." />
          <div className="auth-submit">
            <button className="primary auth-primary" onClick={() => navigate("/")}>Back to sign in</button>
          </div>
        </div>
      ) : done ? (
        <div className="auth-form">
          <AuthTitle title="Reset your password" sub="Your password has been reset." />
          <div className="auth-submit">
            <button className="primary auth-primary" onClick={() => navigate("/")}>Sign in</button>
          </div>
        </div>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <AuthTitle title="Reset your password" sub="Choose a new password" />
          <div className="auth-fields">
            <div className="field">
              <label>New password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required autoComplete="new-password" placeholder="At least 8 characters" />
            </div>
            <div className="field">
              <label>Confirm password</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
            </div>
          </div>
          {error && <AuthError>{error}</AuthError>}
          <div className="auth-submit">
            <button className="primary auth-primary" disabled={busy}>{busy ? "Saving…" : "Reset password"}</button>
            <span className="auth-switch"><button type="button" className="auth-link" onClick={() => navigate("/")}>Back to sign in</button></span>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
