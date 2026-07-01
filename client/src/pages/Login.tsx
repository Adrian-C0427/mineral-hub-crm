import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { PhoneInput } from "../components/PhoneInput";

export function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim(),
          email: email.trim(),
          password,
          joinToken: joinToken.trim() || undefined,
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : mode === "login" ? "Login failed" : "Sign up failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ fontSize: 22, marginBottom: 4 }}>
          Mineral Hub<span className="dot">.</span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          {mode === "login" ? "Sign in to your CRM" : "Create your account"}
        </p>

        {mode === "register" && (
          <>
            <div className="row" style={{ gap: 10 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>First name</label>
                <input value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Last name</label>
                <input value={lastName} onChange={(e) => setLastName(e.target.value)} required />
              </div>
            </div>
            <div className="field">
              <label>Phone number</label>
              <PhoneInput value={phone} onChange={setPhone} required />
            </div>
          </>
        )}

        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>

        {mode === "register" && (
          <div className="field">
            <label>Team ID or invite code (optional)</label>
            <input value={joinToken} onChange={(e) => setJoinToken(e.target.value)} placeholder="Join an existing company" />
          </div>
        )}

        {error && <div className="error-text">{error}</div>}
        <button className="primary" style={{ width: "100%", marginTop: 8 }} disabled={busy}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>

        <p className="muted" style={{ textAlign: "center", marginTop: 14, marginBottom: 0 }}>
          {mode === "login" ? (
            <>New here? <a href="#" onClick={(e) => { e.preventDefault(); setError(null); setMode("register"); }}>Create an account</a></>
          ) : (
            <>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); setError(null); setMode("login"); }}>Sign in</a></>
          )}
        </p>
      </form>
    </div>
  );
}
