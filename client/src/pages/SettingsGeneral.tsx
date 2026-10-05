import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ConfirmChanges, showToast } from "../components/ui";
import { PhoneInput } from "../components/PhoneInput";
import { TwoFactorSettings } from "../components/TwoFactorSettings";
import { ChangePasswordForm } from "../components/ChangePasswordForm";
import { CompanyBranding } from "../components/CompanyBranding";
import { AppearanceSettings } from "../components/AppearanceSettings";
import { NotificationSettings } from "../components/NotificationSettings";
import { SettingsCardHead, SettingsLayout } from "../components/SettingsNav";
import { Avatar } from "../components/kit";
import { ROLE_LABEL } from "../lib/roles";

/** General settings — profile & security, notifications, appearance, branding. */
export function SettingsGeneral() {
  const { user, refresh } = useAuth();
  const initial = () => ({
    firstName: user?.firstName ?? "",
    lastName: user?.lastName ?? "",
    phone: user?.phone ?? "",
    email: user?.email ?? "",
    password: "",
  });
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF((p) => ({ ...p, [k]: e.target.value }));
  };

  // Validate on submit, but only commit after the user confirms.
  function requestSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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
      showToast("Account updated.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save settings");
    } finally {
      setBusy(false);
    }
  }

  const orgName = user?.organization?.name;
  const roleLabel = ROLE_LABEL[user?.orgRole ?? ""];

  return (
    <SettingsLayout>
      {/* Profile & security */}
      <div id="profile" className="settings-anchor">
        <section className="panel set-card-flush">
          <div className="profile-head">
            <Avatar user={user} size={52} />
            <div className="profile-head-text">
              <span className="profile-name">{user?.name}</span>
              {(roleLabel || orgName) && <span className="profile-sub">{[roleLabel, orgName].filter(Boolean).join(" · ")}</span>}
            </div>
            <Link to={{ hash: "#avatar-color" }} className="set-btn-outline">Change avatar color</Link>
          </div>
          <div className="set-card-body">
            <SettingsCardHead
              title="Profile"
              desc="Your profile and sign-in details. Enter your current password to confirm any changes — this never changes your password."
            />
            <form onSubmit={requestSave} className="set-stack">
              <div className="set-field-grid">
                <div className="field"><label>First name</label><input value={f.firstName} onChange={set("firstName")} /></div>
                <div className="field"><label>Last name</label><input value={f.lastName} onChange={set("lastName")} /></div>
                <div className="field"><label>Phone</label><PhoneInput value={f.phone} onChange={(v) => setF((p) => ({ ...p, phone: v }))} /></div>
                <div className="field"><label>Email</label><input type="email" value={f.email} onChange={set("email")} /></div>
              </div>
              <div className="profile-confirm">
                <div className="field">
                  <label>Current password<span className="req-star"> *</span> <span className="label-note">to confirm these changes</span></label>
                  <input type="password" value={f.password} onChange={set("password")} autoComplete="current-password" placeholder="Required to confirm changes" />
                </div>
                <div className="profile-confirm-actions">
                  <button type="button" onClick={() => { setF(initial()); setError(null); }} disabled={busy}>Discard</button>
                  <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
                </div>
              </div>
              {error && <div className="error-text">{error}</div>}
            </form>
          </div>
          {confirming && <ConfirmChanges onCancel={() => setConfirming(false)} onConfirm={save} />}
        </section>

        <section className="panel">
          <SettingsCardHead title="Password" desc="Use at least 8 characters. You'll need your current password to confirm." />
          <ChangePasswordForm />
        </section>

        <TwoFactorSettings />
      </div>

      <div id="notifications" className="settings-anchor">
        <NotificationSettings />
      </div>

      <div id="appearance" className="settings-anchor">
        <AppearanceSettings />
      </div>

      <div id="branding" className="settings-anchor">
        <CompanyBranding />
      </div>

      {/* One line instead of a stack of placeholder panels — empty promise
          sections add scroll and make the finished ones feel less finished. */}
      <p className="muted settings-footnote">Coming soon: per-user defaults</p>
    </SettingsLayout>
  );
}
