import { useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner, ConfirmChanges } from "../components/ui";
import { PhoneInput } from "../components/PhoneInput";
import { TwoFactorSettings } from "../components/TwoFactorSettings";
import { ChangePasswordForm } from "../components/ChangePasswordForm";

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
  const [confirming, setConfirming] = useState(false);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF((p) => ({ ...p, [k]: e.target.value }));
    setOk(false);
  };

  // Validate on submit, but only commit after the user confirms.
  function requestSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);
    if (!f.firstName.trim() || !f.lastName.trim() || !f.phone.trim() || !f.email.trim() || !f.password) {
      setError("All fields are required — enter your current password to confirm the changes.");
      return;
    }
    setConfirming(true);
  }

  async function save() {
    setConfirming(false);
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
        <p className="muted" style={{ marginTop: 0 }}>Your profile and sign-in details. Enter your current password to confirm any changes — this never changes your password.</p>
        <form onSubmit={requestSave}>
          <div className="grid-2">
            <div className="field"><label>First name</label><input value={f.firstName} onChange={set("firstName")} /></div>
            <div className="field"><label>Last name</label><input value={f.lastName} onChange={set("lastName")} /></div>
          </div>
          <div className="field"><label>Phone number</label><PhoneInput value={f.phone} onChange={(v) => { setF((p) => ({ ...p, phone: v })); setOk(false); }} /></div>
          <div className="field"><label>Email address</label><input type="email" value={f.email} onChange={set("email")} /></div>
          <div className="field"><label>Current password</label><input type="password" value={f.password} onChange={set("password")} autoComplete="current-password" placeholder="Required to confirm changes" /></div>
          {error && <div className="error-text">{error}</div>}
          {ok && <Banner kind="info">Account updated.</Banner>}
          <button className="primary" disabled={busy} style={{ marginTop: 8 }}>{busy ? "Saving…" : "Save changes"}</button>
        </form>
        {confirming && <ConfirmChanges onCancel={() => setConfirming(false)} onConfirm={save} />}
      </div>

      <div className="panel">
        <h3>Change Password</h3>
        <p className="muted" style={{ marginTop: 0 }}>Update your password. You'll need your current password to confirm.</p>
        <ChangePasswordForm />
      </div>

      <TwoFactorSettings />

      {/* One line instead of a stack of placeholder panels — empty promise
          sections add scroll and make the finished ones feel less finished. */}
      <p className="muted" style={{ fontSize: 12, textAlign: "center" }}>
        Coming soon: notification preferences · light/dark appearance · per-user defaults
      </p>
    </div>
  );
}
