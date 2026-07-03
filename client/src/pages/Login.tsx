import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";
import { PhoneInput } from "../components/PhoneInput";

type Mode = "login" | "register" | "forgot";
interface Provider { key: string; label: string }

export function Login() {
  const { login, register } = useAuth();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [error, setError] = useState<string | null>(params.get("oauthError"));
  const [busy, setBusy] = useState(false);

  // Two-factor challenge (shown after a correct password when 2FA is on).
  const [twoFactor, setTwoFactor] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  // Forgot-password result (dev builds without SMTP return the link directly).
  const [forgotSent, setForgotSent] = useState(false);
  const [devResetUrl, setDevResetUrl] = useState<string | null>(null);

  const [providers, setProviders] = useState<Provider[]>([]);
  // Whether the server allows creating a brand-new workspace without an invite.
  // Defaults true so the field only tightens up once the policy is known.
  const [publicSignup, setPublicSignup] = useState(true);
  useEffect(() => {
    api.get<{ providers: Provider[]; publicSignup?: boolean }>("/auth/oauth/providers")
      .then((r) => { setProviders(r.providers); setPublicSignup(r.publicSignup !== false); })
      .catch(() => {});
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setTwoFactor(false);
    setTotpCode("");
    setForgotSent(false);
    setDevResetUrl(null);
  }

  function startOAuth(key: string) {
    const qs = mode === "register" && joinToken.trim() ? `?joinToken=${encodeURIComponent(joinToken.trim())}` : "";
    window.location.href = `${api.base}/api/auth/oauth/${key}/start${qs}`;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "forgot") {
        const r = await api.post<{ ok: true; devResetUrl?: string }>("/auth/password/forgot", { email: email.trim() });
        setForgotSent(true);
        setDevResetUrl(r.devResetUrl ?? null);
      } else if (mode === "login") {
        const res = await login(email, password, twoFactor ? totpCode.trim() : undefined);
        if (res.status === "twoFactorRequired") setTwoFactor(true);
      } else {
        await register({
          firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim(),
          email: email.trim(), password, joinToken: joinToken.trim() || undefined,
        });
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : mode === "login" ? "Login failed" : mode === "forgot" ? "Request failed" : "Sign up failed";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  // --- Two-factor challenge screen -----------------------------------------
  if (mode === "login" && twoFactor) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={submit}>
          <div className="brand" style={{ fontSize: 22, marginBottom: 4 }}>Mineral Hub<span className="dot">.</span></div>
          <p className="muted" style={{ marginTop: 0 }}>Two-factor authentication</p>
          <div className="field">
            <label>Authentication code</label>
            <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="6-digit code or recovery code" />
            <span className="muted" style={{ fontSize: 12 }}>Open your authenticator app, or use a saved recovery code.</span>
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="primary" style={{ width: "100%", marginTop: 8 }} disabled={busy}>{busy ? "Verifying…" : "Verify & sign in"}</button>
          <p className="muted" style={{ textAlign: "center", marginTop: 14, marginBottom: 0 }}>
            <a href="#" onClick={(e) => { e.preventDefault(); switchMode("login"); }}>Back to sign in</a>
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ fontSize: 22, marginBottom: 4 }}>Mineral Hub<span className="dot">.</span></div>
        <p className="muted" style={{ marginTop: 0 }}>
          {mode === "login" ? "Sign in to your CRM" : mode === "register" ? "Create your account" : "Reset your password"}
        </p>

        {mode === "forgot" ? (
          forgotSent ? (
            <>
              <p>If an account exists for <strong>{email}</strong>, a password reset link is on its way.</p>
              {devResetUrl && (
                <div className="banner banner-info" style={{ fontSize: 13, wordBreak: "break-all" }}>
                  Dev mode (no email configured): <a href={devResetUrl}>open reset link</a>
                </div>
              )}
              <button type="button" className="primary" style={{ width: "100%" }} onClick={() => switchMode("login")}>Back to sign in</button>
            </>
          ) : (
            <>
              <div className="field">
                <label>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
              </div>
              {error && <div className="error-text">{error}</div>}
              <button className="primary" style={{ width: "100%", marginTop: 8 }} disabled={busy}>{busy ? "Please wait…" : "Send reset link"}</button>
              <p className="muted" style={{ textAlign: "center", marginTop: 14, marginBottom: 0 }}>
                <a href="#" onClick={(e) => { e.preventDefault(); switchMode("login"); }}>Back to sign in</a>
              </p>
            </>
          )
        ) : (
          <>
            {providers.length > 0 && (
              <>
                <div className="oauth-buttons">
                  {providers.map((p) => (
                    <button key={p.key} type="button" className="oauth-btn" onClick={() => startOAuth(p.key)}>
                      Continue with {p.label}
                    </button>
                  ))}
                </div>
                <div className="oauth-divider"><span>or</span></div>
              </>
            )}

            {mode === "register" && (
              <>
                <div className="row" style={{ gap: 10 }}>
                  <div className="field" style={{ flex: 1 }}><label>First name</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} required /></div>
                  <div className="field" style={{ flex: 1 }}><label>Last name</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} required /></div>
                </div>
                <div className="field"><label>Phone number</label><PhoneInput value={phone} onChange={setPhone} required /></div>
              </>
            )}

            <div className="field">
              <label>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
            </div>
            <div className="field">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <label style={{ margin: 0 }}>Password</label>
                {mode === "login" && <a href="#" className="muted" style={{ fontSize: 12 }} onClick={(e) => { e.preventDefault(); switchMode("forgot"); }}>Forgot password?</a>}
              </div>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>

            {mode === "register" && (
              <div className="field">
                <label>Team ID or invite code{publicSignup ? " (optional)" : ""}</label>
                <input
                  value={joinToken}
                  onChange={(e) => setJoinToken(e.target.value)}
                  placeholder={publicSignup ? "Join an existing company" : "e.g. TEAM-XXXXXX or an invite code"}
                  required={!publicSignup}
                />
                {!publicSignup && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Sign-up is invite-only — ask your administrator for your company's Team ID or an invite code.
                  </span>
                )}
              </div>
            )}

            {error && <div className="error-text">{error}</div>}
            <button className="primary" style={{ width: "100%", marginTop: 8 }} disabled={busy}>
              {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
            </button>

            <p className="muted" style={{ textAlign: "center", marginTop: 14, marginBottom: 0 }}>
              {mode === "login" ? (
                <>New here? <a href="#" onClick={(e) => { e.preventDefault(); switchMode("register"); }}>Create an account</a></>
              ) : (
                <>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); switchMode("login"); }}>Sign in</a></>
              )}
            </p>
          </>
        )}
      </form>
    </div>
  );
}
