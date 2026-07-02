import { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";

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
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand" style={{ fontSize: 22, marginBottom: 4 }}>Mineral Hub<span className="dot">.</span></div>
        {!token ? (
          <>
            <p className="muted" style={{ marginTop: 0 }}>This reset link is missing its token.</p>
            <button className="primary" style={{ width: "100%" }} onClick={() => navigate("/")}>Back to sign in</button>
          </>
        ) : done ? (
          <>
            <p className="muted" style={{ marginTop: 0 }}>Your password has been reset.</p>
            <button className="primary" style={{ width: "100%" }} onClick={() => navigate("/")}>Sign in</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="muted" style={{ marginTop: 0 }}>Choose a new password</p>
            <div className="field">
              <label>New password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
            </div>
            <div className="field">
              <label>Confirm password</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
            {error && <div className="error-text">{error}</div>}
            <button className="primary" style={{ width: "100%", marginTop: 8 }} disabled={busy}>{busy ? "Saving…" : "Reset password"}</button>
            <p className="muted" style={{ textAlign: "center", marginTop: 14, marginBottom: 0 }}>
              <a href="#" onClick={(e) => { e.preventDefault(); navigate("/"); }}>Back to sign in</a>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
