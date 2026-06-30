import { useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner } from "../components/ui";

export function Settings() {
  const { user, refresh } = useAuth();
  const [f, setF] = useState({
    firstName: user?.firstName ?? "",
    lastName: user?.lastName ?? "",
    phone: user?.phone ?? "",
    email: user?.email ?? "",
    password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF((p) => ({ ...p, [k]: e.target.value }));
    setOk(false);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);
    // All fields are required on update.
    if (!f.firstName.trim() || !f.lastName.trim() || !f.phone.trim() || !f.email.trim() || f.password.length < 8) {
      setError("All fields are required, and the password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await api.patch("/auth/me", {
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        phone: f.phone.trim(),
        email: f.email.trim(),
        password: f.password,
      });
      await refresh();
      setF((p) => ({ ...p, password: "" }));
      setOk(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save settings");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <div className="page-header"><h1>Settings</h1></div>
      <div className="panel">
        <h3>Account information</h3>
        <p className="muted" style={{ marginTop: 0 }}>All fields are required. You must confirm your password to save changes.</p>
        <form onSubmit={save}>
          <div className="grid-2">
            <div className="field"><label>First name</label><input value={f.firstName} onChange={set("firstName")} /></div>
            <div className="field"><label>Last name</label><input value={f.lastName} onChange={set("lastName")} /></div>
          </div>
          <div className="field"><label>Phone number</label><input value={f.phone} onChange={set("phone")} /></div>
          <div className="field"><label>Email address</label><input type="email" value={f.email} onChange={set("email")} /></div>
          <div className="field"><label>Password</label><input type="password" value={f.password} onChange={set("password")} placeholder="Enter a new or current password (min 8 chars)" /></div>
          {error && <div className="error-text">{error}</div>}
          {ok && <Banner kind="info">Account updated.</Banner>}
          <button className="primary" disabled={busy} style={{ marginTop: 8 }}>{busy ? "Saving…" : "Save changes"}</button>
        </form>
      </div>
    </div>
  );
}
