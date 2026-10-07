import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";
import { PhoneInput } from "../components/PhoneInput";
import { Segmented } from "../components/kit";

type Mode = "login" | "register" | "forgot";
interface Provider { key: string; label: string }

const FEATURES: { icon: string; title: string; desc: string }[] = [
  { icon: "M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14", title: "Tract-level mapping", desc: "Abstracts, wells and shapefiles on one map" },
  { icon: "M5 4v16M12 4v11M19 4v6", title: "Deal pipeline", desc: "Every stage from first contact to closing" },
  { icon: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M21 20c0-2.6-1.6-4.9-4-5.7", title: "Buyer intelligence", desc: "Who buys what, where, and how fast they resell" },
];

const BackArrow = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
);

/**
 * Split-screen frame for every signed-out account screen (sign in, create
 * account, password reset, OAuth return): the product brand panel on the left,
 * the form column on the right. Stacks into one column on narrow screens.
 * Uses the product name — no tenant is known before sign-in.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <a href="/" className="auth-home"><BackArrow />Back to home</a>
      <aside className="auth-brand">
        <div className="auth-grid" aria-hidden="true" />
        <div className="auth-logo">
          <span className="auth-logo-mark">M</span>
          <span className="auth-logo-name"><b>Mineral</b><span>Hub</span></span>
        </div>
        <div className="auth-hero">
          <span className="auth-eyebrow">Mineral Hub</span>
          <h1>Every tract, owner and buyer in one working file.</h1>
          <p>Pipeline, research records, maps and buyer relationships for mineral acquisition teams.</p>
          <div className="auth-features">
            {FEATURES.map((f) => (
              <div className="auth-feature" key={f.title}>
                <span className="auth-feature-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={f.icon} /></svg>
                </span>
                <span className="auth-feature-text"><b>{f.title}</b><span>{f.desc}</span></span>
              </div>
            ))}
          </div>
        </div>
        <div className="auth-brand-foot">
          <span>© {new Date().getFullYear()} Mineral Hub</span>
          <a href="/"><BackArrow size={12} />Back to site</a>
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-col">{children}</div>
      </main>
    </div>
  );
}

/** Form-column title block. */
export function AuthTitle({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="auth-title">
      <h2>{title}</h2>
      {sub && <span>{sub}</span>}
    </div>
  );
}

/** Error box (server messages verbatim). */
export function AuthError({ children }: { children: ReactNode }) {
  return (
    <div className="auth-error" role="alert">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5h.01" /></svg>
      <span>{children}</span>
    </div>
  );
}

/** Password input with a show/hide toggle (display only). */
function PasswordField({ value, onChange, autoComplete, placeholder }: {
  value: string; onChange: (v: string) => void; autoComplete: string; placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  const label = show ? "Hide password" : "Show password";
  return (
    <div className="auth-pw">
      <input type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} placeholder={placeholder} required />
      <button type="button" className="auth-pw-eye" onClick={() => setShow((s) => !s)} aria-label={label} title={label}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={show
            ? "M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c5 0 9 4 10 7a11 11 0 0 1-2.7 3.9M6.6 6.6A11 11 0 0 0 2 12c1 3 5 7 10 7a9.8 9.8 0 0 0 3.8-.8"
            : "M2 12c1-3 5-7 10-7s9 4 10 7c-1 3-5 7-10 7S3 15 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"} />
        </svg>
      </button>
    </div>
  );
}

export function Login() {
  const { login, register, loginWithToken } = useAuth();
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
  // One-click demo workspace, offered only when the server enables it.
  const [demoEnabled, setDemoEnabled] = useState(false);
  useEffect(() => {
    api.get<{ enabled: boolean }>("/auth/demo").then((r) => setDemoEnabled(r.enabled === true)).catch(() => {});
  }, []);
  async function exploreDemo() {
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ token: string }>("/auth/demo", {});
      await loginWithToken(r.token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The demo is not available right now");
    } finally {
      setBusy(false);
    }
  }
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
      <AuthLayout>
        <form className="auth-form" onSubmit={submit}>
          <AuthTitle title="Two-factor authentication" sub="Open your authenticator app, or use a saved recovery code." />
          <div className="auth-fields">
            <div className="field">
              <label>Authentication code</label>
              <input className="auth-code" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="6-digit code or recovery code" />
            </div>
          </div>
          {error && <AuthError>{error}</AuthError>}
          <div className="auth-submit">
            <button className="primary auth-primary" disabled={busy}>{busy ? "Verifying…" : "Verify & sign in"}</button>
            <span className="auth-switch"><button type="button" className="auth-link" onClick={() => switchMode("login")}>Back to sign in</button></span>
          </div>
        </form>
      </AuthLayout>
    );
  }

  // --- Forgot password -------------------------------------------------------
  if (mode === "forgot") {
    return (
      <AuthLayout>
        <form className="auth-form" onSubmit={submit}>
          <AuthTitle title="Reset your password" />
          {forgotSent ? (
            <>
              <p className="auth-note">If an account exists for <strong>{email}</strong>, a password reset link is on its way.</p>
              {devResetUrl && (
                <div className="banner banner-info auth-dev-link">
                  Dev mode (no email configured): <a href={devResetUrl}>open reset link</a>
                </div>
              )}
              <div className="auth-submit">
                <button type="button" className="primary auth-primary" onClick={() => switchMode("login")}>Back to sign in</button>
              </div>
            </>
          ) : (
            <>
              <div className="auth-fields">
                <div className="field">
                  <label>Work email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required placeholder="you@company.com" autoComplete="email" />
                </div>
              </div>
              {error && <AuthError>{error}</AuthError>}
              <div className="auth-submit">
                <button className="primary auth-primary" disabled={busy}>{busy ? "Please wait…" : "Send reset link"}</button>
                <span className="auth-switch"><button type="button" className="auth-link" onClick={() => switchMode("login")}>Back to sign in</button></span>
              </div>
            </>
          )}
        </form>
      </AuthLayout>
    );
  }

  // --- Sign in / create account ---------------------------------------------
  const isRegister = mode === "register";
  return (
    <AuthLayout>
      <form className="auth-form" onSubmit={submit}>
        <Segmented
          className="auth-seg"
          ariaLabel="Sign in or create an account"
          value={mode}
          onChange={(m) => { if (m !== mode) switchMode(m); }}
          options={[{ value: "login", label: "Sign in" }, { value: "register", label: "Create account" }]}
        />

        <AuthTitle
          title={isRegister ? "Create your account" : "Welcome back"}
          sub={isRegister
            ? (!publicSignup ? "Sign-up is invite-only. You will need a Team ID or invite code from your administrator." : undefined)
            : "Sign in to your Mineral Hub workspace."}
        />

        {providers.length > 0 && (
          <div className="auth-sso">
            <div className="oauth-buttons">
              {providers.map((p) => (
                <button key={p.key} type="button" className="oauth-btn" onClick={() => startOAuth(p.key)}>
                  Continue with {p.label}
                </button>
              ))}
            </div>
            <div className="oauth-divider"><span>or</span></div>
          </div>
        )}

        <div className="auth-fields">
          {isRegister && (
            <div className="auth-name-row">
              <div className="field"><label>First name</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required /></div>
              <div className="field"><label>Last name</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" required /></div>
            </div>
          )}

          <div className="field">
            <label>Work email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required placeholder="you@company.com" autoComplete="email" />
          </div>

          {isRegister && (
            <div className="field"><label>Phone</label><PhoneInput value={phone} onChange={setPhone} required /></div>
          )}

          <div className="field">
            <div className="auth-label-row">
              <label>Password</label>
              {!isRegister && <button type="button" className="auth-link" onClick={() => switchMode("forgot")}>Forgot password?</button>}
            </div>
            <PasswordField
              value={password}
              onChange={setPassword}
              autoComplete={isRegister ? "new-password" : "current-password"}
              placeholder={isRegister ? "At least 8 characters" : undefined}
            />
          </div>

          {isRegister && (
            <div className="field">
              <div className="auth-label-row">
                <label>Team ID or invite code</label>
                <span className="auth-label-note">{publicSignup ? "Optional" : "Invite-only"}</span>
              </div>
              <input
                className="auth-code"
                value={joinToken}
                onChange={(e) => setJoinToken(e.target.value)}
                placeholder={publicSignup ? "Join an existing company" : "e.g. TEAM-XXXXXX or an invite code"}
                required={!publicSignup}
              />
              {!publicSignup && (
                <span className="auth-help">Ask your administrator for your company's Team ID or an invite code.</span>
              )}
            </div>
          )}
        </div>

        {error && <AuthError>{error}</AuthError>}

        <div className="auth-submit">
          <button className="primary auth-primary" disabled={busy}>
            {busy ? (isRegister ? "Creating account…" : "Signing in…") : isRegister ? "Create account" : "Sign in"}
          </button>
          <span className="auth-switch">
            {isRegister ? "Already have an account?" : "New here?"}{" "}
            <button type="button" className="auth-link strong" onClick={() => switchMode(isRegister ? "login" : "register")}>
              {isRegister ? "Sign in" : "Create an account"}
            </button>
          </span>
          {!isRegister && demoEnabled && (
            <button type="button" className="auth-demo" disabled={busy} onClick={exploreDemo}>
              Explore the demo workspace
            </button>
          )}
        </div>
      </form>
    </AuthLayout>
  );
}
