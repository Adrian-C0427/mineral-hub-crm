import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";

/**
 * Landing page for the OAuth redirect (/auth/callback#token=… or #twofa=…).
 * The API puts the session token in the URL fragment so it never hits a server
 * log; we read it, adopt the session (or complete a 2FA step), and move on.
 */
export function OAuthCallback() {
  const { loginWithToken } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [twofaToken, setTwofaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = hash.get("token");
    const twofa = hash.get("twofa");
    // Clear the fragment so the token isn't left in the address bar / history.
    window.history.replaceState(null, "", window.location.pathname);
    if (token) {
      loginWithToken(token).then(() => navigate("/", { replace: true })).catch(() => setError("Sign-in failed. Please try again."));
    } else if (twofa) {
      setTwofaToken(twofa);
    } else {
      setError("No sign-in information was returned.");
    }
  }, [loginWithToken, navigate]);

  async function submitTwofa(e: React.FormEvent) {
    e.preventDefault();
    if (!twofaToken) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ token: string }>("/auth/oauth/2fa", { preAuthToken: twofaToken, totpCode: code });
      await loginWithToken(r.token);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand" style={{ fontSize: 22, marginBottom: 4 }}>Mineral Hub<span className="dot">.</span></div>
        {twofaToken ? (
          <form onSubmit={submitTwofa}>
            <p className="muted" style={{ marginTop: 0 }}>Enter your two-factor code to finish signing in</p>
            <div className="field">
              <label>Authentication code</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="6-digit code or recovery code" />
            </div>
            {error && <div className="error-text">{error}</div>}
            <button className="primary" style={{ width: "100%", marginTop: 8 }} disabled={busy}>{busy ? "Verifying…" : "Verify"}</button>
          </form>
        ) : error ? (
          <>
            <div className="error-text">{error}</div>
            <button className="primary" style={{ width: "100%", marginTop: 8 }} onClick={() => navigate("/", { replace: true })}>Back to sign in</button>
          </>
        ) : (
          <p className="muted">Signing you in…</p>
        )}
      </div>
    </div>
  );
}
