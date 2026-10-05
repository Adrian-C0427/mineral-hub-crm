import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth, type OrgRole } from "../auth/AuthContext";
import { Banner, ConfirmChanges, ConfirmDialog, OverflowMenu, showToast } from "./ui";
import { Avatar, Tag } from "./kit";
import { SettingsCardHead } from "./SettingsNav";
import { Select } from "./Select";
import { fmtDate, fmtDateLocal } from "../lib/format";
import { formatPhone } from "../lib/phone";
import { ROLE_LABEL } from "../lib/roles";

// teamId is null for roles that don't manage membership — it is a join
// credential, and the API withholds it rather than showing it to everyone.
interface OrgInfo { id: string; name: string; teamId: string | null; memberCount: number; yourRole: OrgRole | null; yourPermissions: string[] }
interface Member { id: string; name: string; email: string; phone: string | null; orgRole: OrgRole | null; status: string; lastActiveAt: string | null; avatarColor?: string | null }
// code is null (codeHidden) when it grants a role the caller may not hand out
// themselves — the API withholds it. role/expiresAt are null on older codes:
// Standard User, never expires.
interface Invite { id: string; code: string | null; codeHidden?: boolean; reusable: boolean; active: boolean; maxUses: number | null; uses: number; role?: OrgRole | null; expiresAt?: string | null; createdAt: string }

/** "expires in N days" for a live code, null once it has lapsed. */
function inviteExpiryText(expiresAt: string): string | null {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const days = Math.ceil(ms / 86_400_000);
  return `expires in ${days} day${days === 1 ? "" : "s"}`;
}
interface RoleRow { role: OrgRole; permissions: string[]; defaults: string[]; editable: boolean; customized: boolean }
interface RolesResponse { roles: RoleRow[]; permissions: { key: string; label: string; group: string }[]; ownerOnlyActions: string[] }

// MANAGER is a retired role, kept here only to label users not yet reassigned.
const ASSIGNABLE: OrgRole[] = ["ADMIN", "MEMBER", "VIEWER"];

type Tab = "org" | "users" | "roles" | "owner";

export function OrgSettings({ initialTab }: { initialTab?: Tab } = {}) {
  const { user, refresh, can, isOrgOwner } = useAuth();
  const [tab, setTab] = useState<Tab>(initialTab ?? "org");
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  const [org, setOrg] = useState<OrgInfo | null>(null);

  function loadOrg() { api.get<OrgInfo>("/org").then(setOrg).catch(() => setOrg(null)); }
  useEffect(() => { loadOrg(); }, [user?.orgRole]);

  const showUsers = can("manageMembers") || can("inviteRemoveUsers");
  // Roles & Permissions is now owner-only.
  const showRoles = isOrgOwner;
  const showOwner = isOrgOwner;

  // Toasts keep the tab content from jumping when feedback appears.
  const flash = (m: string) => showToast(m);
  const fail = (e: unknown) => showToast(e instanceof ApiError ? e.message : "Something went wrong", "error");

  // Sections are chosen from the Settings menu (?tab=), which replaces the
  // old inner tab strip with the same entries and the same gates.
  return (
    <>
      {tab === "org" && org && <OrgTab org={org} canEdit={can("manageOrgSettings")} isOwner={isOrgOwner} showUsers={showUsers} onSaved={() => { loadOrg(); refresh(); flash("Saved."); }} onJoined={() => { refresh(); loadOrg(); }} onError={fail} />}
      {tab === "users" && showUsers && <UsersTab onFlash={flash} onError={fail} />}
      {tab === "roles" && showRoles && <RolesTab onFlash={flash} onError={fail} />}
      {tab === "owner" && showOwner && <OwnerTab onFlash={flash} onError={fail} onTransferred={() => { refresh(); loadOrg(); }} />}
    </>
  );
}

function OrgTab({ org, canEdit, isOwner, showUsers, onSaved, onJoined, onError }: { org: OrgInfo; canEdit: boolean; isOwner: boolean; showUsers: boolean; onSaved: () => void; onJoined: () => void; onError: (e: unknown) => void }) {
  // The company name is read-only until an intentional Edit; saving requires
  // an explicit confirmation, and Cancel restores the original value.
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(org.name);
  const [confirmingName, setConfirmingName] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [joinToken, setJoinToken] = useState("");
  useEffect(() => { setName(org.name); setEditingName(false); setConfirmingName(false); }, [org.name]);

  function cancelNameEdit() {
    setName(org.name); // discard changes
    setEditingName(false);
    setConfirmingName(false);
  }
  async function saveName() {
    setSavingName(true);
    try { await api.patch("/org", { name: name.trim() }); setConfirmingName(false); setEditingName(false); onSaved(); }
    catch (e) { setConfirmingName(false); onError(e); }
    finally { setSavingName(false); }
  }
  // Joining another org moves the user out of THIS workspace — always confirm.
  const [confirmingJoin, setConfirmingJoin] = useState(false);
  const [joining, setJoining] = useState(false);
  async function join() {
    setJoining(true);
    try { await api.post("/auth/join", { token: joinToken.trim() }); setJoinToken(""); setConfirmingJoin(false); onJoined(); }
    catch (e2) { setConfirmingJoin(false); onError(e2); }
    finally { setJoining(false); }
  }
  // Resetting the Team ID invalidates the old one for everyone holding it —
  // that's the point (it's how a leaked or departed-member key gets revoked),
  // but it also breaks any invite in flight, so it always confirms.
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  async function rotateTeamId() {
    setRotating(true);
    try { await api.post("/org/team-id/rotate", {}); setConfirmingRotate(false); onSaved(); }
    catch (e) { setConfirmingRotate(false); onError(e); }
    finally { setRotating(false); }
  }
  function copy(text: string) { navigator.clipboard?.writeText(text); }

  return (
    <>
      <section className="panel set-card-flush">
        <div className="org-head">
          <span className="org-tile" aria-hidden="true">{org.name.trim().charAt(0).toUpperCase() || "?"}</span>
          {!editingName ? (
            <>
              <div className="org-head-text">
                <span className="org-name">{org.name}</span>
                <span className="org-sub">{org.memberCount} member{org.memberCount === 1 ? "" : "s"}{org.yourRole && ROLE_LABEL[org.yourRole] ? ` · you're the ${ROLE_LABEL[org.yourRole].toLowerCase()}` : ""}</span>
              </div>
              {canEdit && <button className="set-btn-outline" onClick={() => setEditingName(true)}>Rename</button>}
            </>
          ) : (
            <div className="org-rename">
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Company name" autoFocus />
              <button className="primary" disabled={!name.trim() || name.trim() === org.name} onClick={() => setConfirmingName(true)}>Save</button>
              <button className="set-btn-ghost" onClick={cancelNameEdit}>Cancel</button>
            </div>
          )}
        </div>
        <div className="org-stats">
          {/* Only shown to roles that manage membership — the API withholds it
              from everyone else, since holding it is enough to join the org. */}
          {org.teamId && (
            <div className="org-stat">
              <span className="org-stat-label">Team ID</span>
              <span className="org-team-id">{org.teamId}</span>
              <div className="row" style={{ gap: 6 }}>
                <button className="small" onClick={() => copy(org.teamId!)}>Copy</button>
                {isOwner && <button className="small" onClick={() => setConfirmingRotate(true)}>Reset</button>}
              </div>
              <span className="org-stat-help">Teammates use this to join {org.name}. Resetting stops the old ID from working.</span>
            </div>
          )}
          <div className="org-stat">
            <span className="org-stat-label">Members</span>
            <span className="org-stat-value">{org.memberCount}</span>
            {showUsers && <Link className="set-link" to="/settings/organization?tab=users">Manage team →</Link>}
          </div>
          <div className="org-stat">
            <span className="org-stat-label">Your role</span>
            <span className="org-stat-value">{ROLE_LABEL[org.yourRole ?? ""] ?? "—"}</span>
            {isOwner && <Link className="set-link" to="/settings/organization?tab=roles">View permissions →</Link>}
          </div>
        </div>
      </section>
      {/* Deliberately tucked away: switching companies is rare and moves the
          user out of this workspace, so it should never be one Enter away. */}
      <section className="panel set-card-flush">
        <details className="org-join">
          <summary>
            <span className="org-join-text">
              <span className="org-join-title">Join a different company…</span>
              <span className="org-join-sub">Joining another organization moves you out of {org.name} and into their shared workspace.</span>
            </span>
            <svg className="org-join-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </summary>
          <form
            onSubmit={(e) => { e.preventDefault(); if (joinToken.trim()) setConfirmingJoin(true); }}
            className="org-join-form"
          >
            <div className="field">
              <label>Team ID or invite code</label>
              <input className="mono-input" value={joinToken} onChange={(e) => setJoinToken(e.target.value)} placeholder="e.g. TEAM-XXXXXX" />
            </div>
            <button className="primary" disabled={!joinToken.trim()}>Join…</button>
          </form>
        </details>
      </section>
      {confirmingName && <ConfirmChanges busy={savingName} onCancel={() => setConfirmingName(false)} onConfirm={saveName} />}
      {confirmingJoin && (
        <ConfirmDialog
          title="Switch to another company?"
          message={<>You're about to leave <strong>{org.name}</strong> and join the workspace for code <code>{joinToken.trim()}</code>. You'll lose access to this company's deals, buyers, and settings unless you're re-invited. Continue?</>}
          confirmLabel="Leave & join"
          danger
          busy={joining}
          onCancel={() => setConfirmingJoin(false)}
          onConfirm={join}
        />
      )}
      {confirmingRotate && (
        <ConfirmDialog
          title="Reset the Team ID?"
          message={<>Anyone still holding <code>{org.teamId}</code> — including people who have left — will no longer be able to join {org.name} with it. Everyone you've given it to will need the new one. Existing members are unaffected.</>}
          confirmLabel="Reset Team ID"
          danger
          busy={rotating}
          onCancel={() => setConfirmingRotate(false)}
          onConfirm={rotateTeamId}
        />
      )}
    </>
  );
}

function UsersTab({ onFlash, onError }: { onFlash: (m: string) => void; onError: (e: unknown) => void }) {
  const { user, can, isOrgOwner } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  // Role/status changes commit only after an explicit confirmation.
  const [pendingRole, setPendingRole] = useState<{ m: Member; orgRole: OrgRole } | null>(null);
  const [pendingStatus, setPendingStatus] = useState<Member | null>(null);
  const [resetting, setResetting] = useState<Member | null>(null);
  // Destructive actions confirm through the shared ConfirmDialog (not native confirm()).
  const [removingMember, setRemovingMember] = useState<Member | null>(null);
  const [revokingInvite, setRevokingInvite] = useState<Invite | null>(null);
  // Role the next generated code hands to whoever joins with it.
  const [inviteRole, setInviteRole] = useState<OrgRole>("MEMBER");
  const [actionBusy, setActionBusy] = useState(false);

  function load() {
    if (can("manageMembers")) api.get<Member[]>("/org/members").then(setMembers).catch(() => {});
    if (can("inviteRemoveUsers")) api.get<Invite[]>("/org/invites").then(setInvites).catch(() => {});
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function changeRole(m: Member, orgRole: OrgRole) {
    try { await api.patch(`/org/members/${m.id}`, { orgRole }); onFlash(`Updated ${m.name}'s role.`); load(); } catch (e) { onError(e); }
    finally { setPendingRole(null); }
  }
  async function toggleStatus(m: Member) {
    try { await api.patch(`/org/members/${m.id}`, { status: m.status === "ACTIVE" ? "DISABLED" : "ACTIVE" }); load(); } catch (e) { onError(e); }
    finally { setPendingStatus(null); }
  }
  async function removeMember(m: Member) {
    setActionBusy(true);
    try {
      // Removal rotates the org's Team ID (the departing member knew the old
      // one and could otherwise re-join with it). Surface the new value —
      // a join code that silently stops working is worse than one that changed.
      // Invite codes the member could still redeem are deactivated too.
      const r = await api.del<{ teamId?: string | null; invitesRevoked?: number }>(`/org/members/${m.id}`);
      setRemovingMember(null);
      load();
      const revoked = r?.invitesRevoked
        ? ` ${r.invitesRevoked} invite code${r.invitesRevoked === 1 ? " was" : "s were"} deactivated — generate new ones if needed.`
        : "";
      onFlash(`${m.name} removed.${r?.teamId ? ` New Team ID: ${r.teamId}.` : ""}${revoked}`);
    }
    catch (e) { onError(e); } finally { setActionBusy(false); }
  }
  async function genInvite(reusable: boolean) { try { await api.post("/org/invites", { reusable, role: inviteRole }); load(); } catch (e) { onError(e); } }
  async function toggleInvite(i: Invite) { try { await api.patch(`/org/invites/${i.id}`, { active: !i.active }); load(); } catch (e) { onError(e); } }
  async function revokeInvite(i: Invite) {
    setActionBusy(true);
    try { await api.del(`/org/invites/${i.id}`); setRevokingInvite(null); load(); }
    catch (e) { onError(e); } finally { setActionBusy(false); }
  }
  function copy(text: string) { navigator.clipboard?.writeText(text); onFlash(`Copied ${text}`); }

  // Owner can assign any assignable role; a non-owner can't create admins.
  // A user still on the retired MANAGER role keeps it shown as their current
  // value (so the select isn't blank) until reassigned to one of the new roles.
  const roleOptions = (m: Member): OrgRole[] => {
    const base: OrgRole[] = isOrgOwner ? ["ADMIN", "MEMBER", "VIEWER"] : ["MEMBER", "VIEWER"];
    return m.orgRole && m.orgRole !== "OWNER" && !base.includes(m.orgRole) ? [m.orgRole, ...base] : base;
  };
  // Same limit for invite codes (the server enforces it): the role a code
  // grants must be one the creator could assign to a member directly.
  const grantable: OrgRole[] = isOrgOwner ? ["ADMIN", "MEMBER", "VIEWER"] : ["MEMBER", "VIEWER"];
  const legacyCount = members.filter((m) => m.orgRole === "MANAGER").length;
  const activeCount = members.filter((m) => m.status === "ACTIVE").length;

  return (
    <>
      {can("manageMembers") && (
        <section className="panel set-card-flush">
          <div className="set-card-pad">
            <SettingsCardHead
              title="Team members"
              desc={`${members.length} member${members.length === 1 ? "" : "s"} · ${activeCount} active`}
            />
            {legacyCount > 0 && (
              <Banner kind="warn">
                {legacyCount === 1 ? "One team member is" : `${legacyCount} team members are`} still on the retired
                <strong> Manager</strong> role. Reassign {legacyCount === 1 ? "them" : "each"} to Administrator, Standard User,
                or Read-Only Viewer below. Until then they have Standard-User access.
              </Banner>
            )}
          </div>
          <div className="table-scroll set-table">
            <table className="data-table users-table">
              <thead><tr><th>Member</th><th className="users-phone">Phone</th><th>Role</th><th>Status</th><th>Last active</th><th className="user-actions-cell"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {members.map((m) => {
                  const isSelf = m.id === user?.id;
                  const locked = m.orgRole === "OWNER" || isSelf || (m.orgRole === "ADMIN" && !isOrgOwner);
                  const actions = [
                    ...(isOrgOwner ? [{ label: "Reset password", onClick: () => setResetting(m) }] : []),
                    { label: m.status === "ACTIVE" ? "Deactivate" : "Reactivate", onClick: () => setPendingStatus(m) },
                    // Destructive action set apart by danger styling.
                    ...(can("inviteRemoveUsers") ? [{ label: "Remove from team", danger: true, onClick: () => setRemovingMember(m) }] : []),
                  ];
                  return (
                    <tr key={m.id} className={m.status === "ACTIVE" ? "" : "member-off"}>
                      <td>
                        <div className="member-cell">
                          <Avatar user={m} size={32} />
                          <div className="member-text">
                            <span className="member-name">{m.name}{isSelf && <span className="member-you"> (you)</span>}</span>
                            <span className="member-email">{m.email}</span>
                          </div>
                        </div>
                      </td>
                      <td className="users-phone">{m.phone ? formatPhone(m.phone) : "—"}</td>
                      <td>
                        <div className="member-role">
                          {locked ? (
                            <span className="member-role-locked">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
                              {ROLE_LABEL[m.orgRole ?? ""] ?? "—"}
                            </span>
                          ) : (
                            <Select value={m.orgRole ?? "MEMBER"} onChange={(v) => setPendingRole({ m, orgRole: v as OrgRole })}
                              width={190} ariaLabel={`Role for ${m.name}`}
                              options={roleOptions(m).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
                          )}
                          {m.orgRole === "MANAGER" && <Tag tone="warn">reassign</Tag>}
                        </div>
                      </td>
                      <td><Tag tone={m.status === "ACTIVE" ? "success" : "neutral"} dot>{m.status === "ACTIVE" ? "Active" : "Deactivated"}</Tag></td>
                      <td className="member-last">{m.lastActiveAt ? fmtDateLocal(m.lastActiveAt) : "—"}</td>
                      <td className="right user-actions-cell">
                        {!isSelf && m.orgRole !== "OWNER" && <OverflowMenu items={actions} ariaLabel={`Actions for ${m.name}`} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {can("inviteRemoveUsers") && (
        <section className="panel set-card-flush">
          <div className="set-card-pad invite-head">
            <SettingsCardHead
              title="Invite codes"
              desc="Share a code to let someone join with a set role. Codes expire after 7 days; one-time codes also stop working after one use."
              aside={
                <div className="row" style={{ gap: 8 }}>
                  <div className="invite-role-pick">
                    <Select value={inviteRole} onChange={(v) => setInviteRole(v as OrgRole)}
                      width="100%" ariaLabel="Role for new invite codes"
                      options={grantable.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
                  </div>
                  <button onClick={() => genInvite(false)}>+ One-time code</button>
                  <button className="primary" onClick={() => genInvite(true)}>+ Reusable code</button>
                </div>
              }
            />
          </div>
          {invites.length === 0 ? <p className="set-empty">No invite codes yet.</p> : (
            <div className="table-scroll set-table">
              <table className="data-table invite-table">
                <thead><tr><th>Code</th><th>Role</th><th>Type</th><th>Uses</th><th>Status</th><th className="right"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {invites.map((i) => {
                    const role = i.role ?? "MEMBER";
                    // Codes without an expiry (older ones) show nothing extra.
                    const expiry = i.expiresAt ? inviteExpiryText(i.expiresAt) : null;
                    const expired = !!i.expiresAt && !expiry;
                    return (
                      <tr key={i.id}>
                        <td>{i.code ? <code className="invite-code">{i.code}</code> : <span className="invite-hidden">Hidden · owner only</span>}</td>
                        <td className="invite-role">{ROLE_LABEL[role] ?? role}</td>
                        <td><Tag>{i.reusable ? "Reusable" : "One-time"}</Tag></td>
                        <td>{i.uses}{i.maxUses != null ? ` / ${i.maxUses}` : ""}</td>
                        <td>
                          <div className="invite-status">
                            {expired
                              ? <Tag tone="danger" dot>Expired</Tag>
                              : <Tag tone={i.active ? "success" : "neutral"} dot>{i.active ? "Active" : "Disabled"}</Tag>}
                            {expiry && <span className="invite-expiry">{expiry}</span>}
                          </div>
                        </td>
                        <td className="right">
                          <div className="invite-actions">
                            {i.code && !expired && <button className="small" onClick={() => copy(i.code!)}>Copy</button>}
                            {/* An expired code can't be revived, and re-enabling takes the right to grant its role. */}
                            {!expired && (i.active || grantable.includes(role)) && (
                              <button className="small" onClick={() => toggleInvite(i)}>{i.active ? "Disable" : "Enable"}</button>
                            )}
                            <button className="small set-btn-danger-text" onClick={() => setRevokingInvite(i)}>Revoke</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {pendingRole && (
        <ConfirmDialog
          title="Confirm Changes"
          message={<p style={{ margin: 0 }}>Change <strong>{pendingRole.m.name}</strong>'s role to <strong>{ROLE_LABEL[pendingRole.orgRole]}</strong>? Are you sure you want to save this change?</p>}
          onCancel={() => setPendingRole(null)}
          onConfirm={() => changeRole(pendingRole.m, pendingRole.orgRole)}
        />
      )}
      {pendingStatus && (
        <ConfirmDialog
          title={pendingStatus.status === "ACTIVE" ? "Deactivate user?" : "Activate user?"}
          message={<p style={{ margin: 0 }}>{pendingStatus.status === "ACTIVE"
            ? <>Deactivate <strong>{pendingStatus.name}</strong>'s account? They will lose access until reactivated.</>
            : <>Reactivate <strong>{pendingStatus.name}</strong>'s account?</>}</p>}
          confirmLabel={pendingStatus.status === "ACTIVE" ? "Deactivate" : "Activate"}
          danger={pendingStatus.status === "ACTIVE"}
          onCancel={() => setPendingStatus(null)}
          onConfirm={() => toggleStatus(pendingStatus)}
        />
      )}
      {resetting && (
        <ResetPasswordModal member={resetting} onClose={() => setResetting(null)} onDone={(msg) => { setResetting(null); onFlash(msg); }} onError={onError} />
      )}
      {removingMember && (
        <ConfirmDialog
          title="Remove member?"
          message={<>Remove <strong>{removingMember.name}</strong> from the organization? They lose access to this workspace immediately. The company's Team ID is reset too, so they can't re-join with it — anyone else you've given it to will need the new one. This can't be undone.</>}
          confirmLabel="Remove member"
          danger
          busy={actionBusy}
          onCancel={() => setRemovingMember(null)}
          onConfirm={() => removeMember(removingMember)}
        />
      )}
      {revokingInvite && (
        <ConfirmDialog
          title="Revoke invite code?"
          message={<>Revoke {revokingInvite.code ? <>invite code <code>{revokingInvite.code}</code></> : "this invite code"}? It can no longer be used to join this organization. This can't be undone.</>}
          confirmLabel="Revoke code"
          danger
          busy={actionBusy}
          onCancel={() => setRevokingInvite(null)}
          onConfirm={() => revokeInvite(revokingInvite)}
        />
      )}
    </>
  );
}

function ResetPasswordModal({ member, onClose, onDone, onError }: { member: Member; onClose: () => void; onDone: (msg: string) => void; onError: (e: unknown) => void }) {
  const [mode, setMode] = useState<"temp" | "manual">("temp");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [temp, setTemp] = useState<string | null>(null);

  async function run() {
    setError(null);
    if (mode === "manual") {
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
      if (password !== confirm) { setError("Passwords don't match."); return; }
    }
    setBusy(true);
    try {
      const r = await api.post<{ temporaryPassword?: string }>(`/users/${member.id}/reset-password`, mode === "temp" ? { mode } : { mode, password });
      if (r.temporaryPassword) setTemp(r.temporaryPassword);
      else onDone(`${member.name}'s password was reset. They must change it at next login.`);
    } catch (e) { onError(e); setError(e instanceof ApiError ? e.message : "Reset failed"); }
    finally { setBusy(false); }
  }

  return (
    <ConfirmDialog
      title={`Reset password · ${member.name}`}
      message={temp ? (
        <div>
          <p style={{ marginTop: 0 }}>Temporary password created. Share it securely with <strong>{member.name}</strong>; they'll be required to change it at next login.</p>
          <div className="twofa-secret"><code>{temp}</code><button className="small" onClick={() => navigator.clipboard?.writeText(temp).catch(() => {})}>Copy</button></div>
        </div>
      ) : (
        <div>
          <div className="row" style={{ gap: 14, marginBottom: 10 }}>
            <label className="row" style={{ gap: 6, textTransform: "none" }}><input type="radio" checked={mode === "temp"} onChange={() => setMode("temp")} /> Generate temporary password</label>
            <label className="row" style={{ gap: 6, textTransform: "none" }}><input type="radio" checked={mode === "manual"} onChange={() => setMode("manual")} /> Set password manually</label>
          </div>
          {mode === "manual" && (
            <div className="grid-2">
              <div className="field"><label>New password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 8 characters" /></div>
              <div className="field"><label>Confirm</label><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{member.name} will be required to set a new password at next login.</p>
          {error && <div className="error-text">{error}</div>}
        </div>
      )}
      confirmLabel={temp ? "Done" : "Reset password"}
      danger={!temp}
      busy={busy}
      onCancel={temp ? () => onDone(`${member.name}'s password was reset.`) : onClose}
      onConfirm={temp ? () => onDone(`${member.name}'s password was reset.`) : run}
    />
  );
}

function RolesTab({ onFlash, onError }: { onFlash: (m: string) => void; onError: (e: unknown) => void }) {
  const [data, setData] = useState<RolesResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [permQuery, setPermQuery] = useState("");

  function load() {
    api.get<RolesResponse>("/org/roles").then((r) => {
      setData(r);
      const d: Record<string, Set<string>> = {};
      for (const role of r.roles) d[role.role] = new Set(role.permissions);
      setDraft(d);
    }).catch(onError);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const groups = useMemo(() => {
    const g = new Map<string, { key: string; label: string }[]>();
    for (const p of data?.permissions ?? []) { const arr = g.get(p.group) ?? []; arr.push(p); g.set(p.group, arr); }
    return Array.from(g, ([group, perms]) => ({ group, perms }));
  }, [data]);

  function toggle(role: OrgRole, key: string) {
    setDraft((prev) => {
      const set = new Set(prev[role]);
      set.has(key) ? set.delete(key) : set.add(key);
      return { ...prev, [role]: set };
    });
  }

  // Roles whose draft differs from what's currently saved.
  function changedRoles(): OrgRole[] {
    if (!data) return [];
    return ASSIGNABLE.filter((r) => {
      const base = new Set(data.roles.find((x) => x.role === r)?.permissions ?? []);
      const cur = draft[r] ?? new Set<string>();
      if (base.size !== cur.size) return true;
      for (const k of cur) if (!base.has(k)) return true;
      return false;
    });
  }
  const dirty = changedRoles().length > 0;

  // One Save commits every modified role at once.
  async function saveAll() {
    setSaving(true);
    try {
      for (const role of changedRoles()) {
        await api.patch(`/org/roles/${role}`, { permissions: [...(draft[role] ?? [])] });
      }
      onFlash("Permissions saved.");
      load();
    } catch (e) { onError(e); }
    finally { setSaving(false); setConfirming(false); }
  }
  // Reset discards unsaved edits and restores the last-saved configuration.
  function resetAll() {
    if (!data) return;
    const d: Record<string, Set<string>> = {};
    for (const role of data.roles) d[role.role] = new Set(role.permissions);
    setDraft(d);
  }

  if (!data) return <section className="panel"><p className="muted" style={{ margin: 0 }}>Loading roles…</p></section>;

  // Client-side "Find a permission" filter (matches the label or group name).
  const q = permQuery.trim().toLowerCase();
  const shown = groups
    .map(({ group, perms }) => ({ group, perms: q && !group.toLowerCase().includes(q) ? perms.filter((p) => p.label.toLowerCase().includes(q)) : perms }))
    .filter((g) => g.perms.length > 0);
  // A row is marked when any role's draft differs from the saved set.
  const savedHas = (r: OrgRole, key: string) => data.roles.find((x) => x.role === r)?.permissions.includes(key) ?? false;
  const rowChanged = (key: string) => ASSIGNABLE.some((r) => (draft[r]?.has(key) ?? false) !== savedHas(r, key));

  return (
    <>
      <section className="panel set-card-flush">
        <div className="set-card-pad roles-head">
          <SettingsCardHead
            title="Roles & permissions"
            desc={<>
              Toggle permissions per role, then Save. The Owner always has full access. Owner-only actions
              ({data.ownerOnlyActions.join(", ").replace(/([A-Z])/g, " $1").toLowerCase()}) are reserved for the Owner and can't be assigned.
            </>}
            aside={
              <div className="set-search">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                <input value={permQuery} onChange={(e) => setPermQuery(e.target.value)} placeholder="Find a permission" aria-label="Find a permission" />
              </div>
            }
          />
        </div>
        <div className="table-scroll set-table">
          <table className="data-table perm-matrix">
            <thead>
              <tr>
                <th>Permission</th>
                <th className="center"><span className="perm-col">Owner<span>Full access</span></span></th>
                {ASSIGNABLE.map((r) => <th key={r} className="center"><span className="perm-col">{ROLE_LABEL[r]}</span></th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map(({ group, perms }) => (
                <Fragment key={group}>
                  <tr className="group-row"><td colSpan={2 + ASSIGNABLE.length}>{group}</td></tr>
                  {perms.map((p) => (
                    <tr key={p.key}>
                      <td><span className="perm-label">{p.label}{rowChanged(p.key) && <i className="perm-changed" title="Unsaved change" />}</span></td>
                      <td className="center"><input type="checkbox" checked disabled title="The Owner always has every permission" aria-label={`Owner: ${p.label}`} /></td>
                      {ASSIGNABLE.map((r) => (
                        <td key={r} className="center">
                          <input type="checkbox" checked={draft[r]?.has(p.key) ?? false} onChange={() => toggle(r, p.key)} aria-label={`${ROLE_LABEL[r]}: ${p.label}`} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {shown.length === 0 && <p className="set-empty">No permissions match "{permQuery.trim()}".</p>}
      </section>
      {dirty && (
        <div className="set-savebar">
          <span className="set-savebar-dot" aria-hidden="true" />
          <span className="set-savebar-text">Unsaved changes</span>
          <button disabled={saving} onClick={resetAll}>Discard</button>
          <button className="primary" disabled={saving} onClick={() => setConfirming(true)}>Save permissions</button>
        </div>
      )}
      {confirming && <ConfirmChanges busy={saving} onCancel={() => setConfirming(false)} onConfirm={saveAll} />}
    </>
  );
}

function OwnerTab({ onFlash, onError, onTransferred }: { onFlash: (m: string) => void; onError: (e: unknown) => void; onTransferred: () => void }) {
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [target, setTarget] = useState("");
  const [confirmingTransfer, setConfirmingTransfer] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);

  useEffect(() => { api.get<Member[]>("/org/members").then(setMembers).catch(() => {}); }, []);

  const targetMember = members.find((x) => x.id === target) ?? null;
  async function transfer() {
    if (!targetMember) return;
    setTransferBusy(true);
    try { await api.post("/org/transfer-ownership", { userId: target }); setConfirmingTransfer(false); onFlash(`Ownership transferred to ${targetMember.name}.`); onTransferred(); }
    catch (e) { onError(e); } finally { setTransferBusy(false); }
  }

  const candidates = members.filter((m) => m.id !== user?.id && m.orgRole !== "OWNER");

  return (
    <>
      <section className="panel owner-card">
        <SettingsCardHead title="Transfer ownership" desc="The Owner holds the highest level of control. Transferring ownership demotes you to Administrator." />
        <div className="owner-transfer">
          <div className="field">
            <label>New owner</label>
            <Select value={target} onChange={setTarget} placeholder="Select a member…" clearable searchable ariaLabel="New owner"
              options={candidates.map((m) => ({ value: m.id, label: `${m.name} (${m.email})` }))} />
          </div>
          <button className="danger" disabled={!target} onClick={() => setConfirmingTransfer(true)}>Transfer ownership</button>
        </div>
      </section>

      <section className="panel soon-card">
        {["Billing & subscription", "Organization-wide security settings"].map((label) => (
          <div className="soon-row" key={label}>
            <span className="soon-label">{label}</span>
            <Tag>Coming soon</Tag>
          </div>
        ))}
      </section>

      {confirmingTransfer && targetMember && (
        <ConfirmDialog
          title="Transfer ownership?"
          message={<>Transfer ownership to <strong>{targetMember.name}</strong>? You will become an <strong>Administrator</strong> and can't undo this yourself afterward.</>}
          confirmLabel="Transfer ownership"
          danger
          busy={transferBusy}
          onCancel={() => setConfirmingTransfer(false)}
          onConfirm={transfer}
        />
      )}
    </>
  );
}
