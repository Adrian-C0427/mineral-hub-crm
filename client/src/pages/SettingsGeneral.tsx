import { useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner } from "../components/ui";
import { PhoneInput } from "../components/PhoneInput";

/** General settings — account/profile now; structured for more sections later. */
export function SettingsGeneral() {
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
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-header"><h1>General</h1></div>

      {/* Account & Security (live) */}
      <div className="panel">
        <h3>Account & Security</h3>
        <p className="muted" style={{ marginTop: 0 }}>Your profile and sign-in details. Confirm your password to save changes.</p>
        <form onSubmit={save}>
          <div className="grid-2">
            <div className="field"><label>First name</label><input value={f.firstName} onChange={set("firstName")} /></div>
            <div className="field"><label>Last name</label><input value={f.lastName} onChange={set("lastName")} /></div>
          </div>
          <div className="field"><label>Phone number</label><PhoneInput value={f.phone} onChange={(v) => { setF((p) => ({ ...p, phone: v })); setOk(false); }} /></div>
          <div className="field"><label>Email address</label><input type="email" value={f.email} onChange={set("email")} /></div>
          <div className="field"><label>Password</label><input type="password" value={f.password} onChange={set("password")} placeholder="Enter a new or current password (min 8 chars)" /></div>
          {error && <div className="error-text">{error}</div>}
          {ok && <Banner kind="info">Account updated.</Banner>}
          <button className="primary" disabled={busy} style={{ marginTop: 8 }}>{busy ? "Saving…" : "Save changes"}</button>
        </form>
      </div>

      {/* Forthcoming general settings — laid out so each can be enabled in place. */}
      <SoonPanel title="Notification Preferences" desc="Choose which deal, buyer, and reminder notifications you receive and how (email / in-app)." />
      <SoonPanel title="Appearance" desc="Switch between light and dark mode and set display density." />
      <SoonPanel title="Default Application Preferences" desc="Set your default landing page, date range, and other per-user defaults." />
    </div>
  );
}

function SoonPanel({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="panel" style={{ opacity: 0.75 }}>
      <div className="section-head"><h3 style={{ margin: 0 }}>{title}</h3><span className="badge resp-pending">Coming soon</span></div>
      <p className="muted" style={{ marginBottom: 0 }}>{desc}</p>
    </div>
  );
}
