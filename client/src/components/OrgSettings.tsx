import { Fragment, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth, type OrgRole } from "../auth/AuthContext";
import { Banner, ConfirmChanges, ConfirmDialog } from "./ui";
import { fmtDate } from "../lib/format";
import { formatPhone } from "../lib/phone";

interface OrgInfo { id: string; name: string; teamId: string; memberCount: number; yourRole: OrgRole | null; yourPermissions: string[] }
interface Member { id: string; name: string; email: string; phone: string | null; orgRole: OrgRole | null; status: string; lastActiveAt: string | null }
interface Invite { id: string; code: string; reusable: boolean; active: boolean; maxUses: number | null; uses: number; createdAt: string }
interface RoleRow { role: OrgRole; permissions: string[]; defaults: string[]; editable: boolean; customized: boolean }
interface RolesResponse { roles: RoleRow[]; permissions: { key: string; label: string; group: string }[]; ownerOnlyActions: string[] }

const ROLE_LABEL: Record<string, string> = { OWNER: "Owner", ADMIN: "Administrator", MANAGER: "Manager", MEMBER: "Standard User", VIEWER: "Read-Only Viewer" };
const ASSIGNABLE: OrgRole[] = ["ADMIN", "MANAGER", "MEMBER", "VIEWER"];

type Tab = "org" | "users" | "roles" | "owner";

export function OrgSettings({ initialTab }: { initialTab?: Tab } = {}) {
  const { user, refresh, can, isOrgOwner } = useAuth();
  const [tab, setTab] = useState<Tab>(initialTab ?? "org");
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function loadOrg() { api.get<OrgInfo>("/org").then(setOrg).catch(() => setOrg(null)); }
  useEffect(() => { loadOrg(); }, [user?.orgRole]);

  const showUsers = can("manageMembers") || can("inviteRemoveUsers");
  const showRoles = can("manageRoles");
  const showOwner = isOrgOwner;

  const flash = (m: string) => { setMsg(m); setErr(null); };
  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : "Something went wrong");

  return (
    <div className="panel">
      <div className="tab-row">
        <button className={`tab ${tab === "org" ? "active" : ""}`} onClick={() => setTab("org")}>Organization</button>
        {showUsers && <button className={`tab ${tab === "users" ? "active" : ""}`} onClick={() => setTab("users")}>Users</button>}
        {showRoles && <button className={`tab ${tab === "roles" ? "active" : ""}`} onClick={() => setTab("roles")}>Roles & Permissions</button>}
        {showOwner && <button className={`tab ${tab === "owner" ? "active" : ""}`} onClick={() => setTab("owner")}>Owner controls</button>}
      </div>

      {msg && <Banner kind="info">{msg}</Banner>}
      {err && <div className="error-text">{err}</div>}

      {tab === "org" && org && <OrgTab org={org} canEdit={can("manageOrgSettings")} onSaved={() => { loadOrg(); refresh(); flash("Saved."); }} onJoined={() => { refresh(); loadOrg(); }} onError={fail} />}
      {tab === "users" && showUsers && <UsersTab onFlash={flash} onError={fail} />}
      {tab === "roles" && showRoles && <RolesTab onFlash={flash} onError={fail} />}
      {tab === "owner" && showOwner && <OwnerTab onFlash={flash} onError={fail} onTransferred={() => { refresh(); loadOrg(); }} />}
    </div>
  );
}

function OrgTab({ org, canEdit, onSaved, onJoined, onError }: { org: OrgInfo; canEdit: boolean; onSaved: () => void; onJoined: () => void; onError: (e: unknown) => void }) {
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
  async function join(e: React.FormEvent) {
    e.preventDefault();
    try { await api.post("/auth/join", { token: joinToken.trim() }); setJoinToken(""); onJoined(); } catch (e2) { onError(e2); }
  }
  function copy(text: string) { navigator.clipboard?.writeText(text); }

  return (
    <>
      <div className="dd-grid" style={{ marginBottom: 12 }}>
        <div className="kv"><span className="k">Company</span><span className="v">
          {!editingName ? (
            <span className="row" style={{ gap: 6 }}>
              {org.name}
              {canEdit && <button className="small" onClick={() => setEditingName(true)}>Edit</button>}
            </span>
          ) : (
            <span className="row" style={{ gap: 6 }}>
              <input value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 260 }} autoFocus />
              <button className="small primary" disabled={!name.trim() || name.trim() === org.name} onClick={() => setConfirmingName(true)}>Save</button>
              <button className="small" onClick={cancelNameEdit}>Cancel</button>
            </span>
          )}
        </span></div>
        <div className="kv"><span className="k">Team ID</span><span className="v"><code>{org.teamId}</code> <button className="small" onClick={() => copy(org.teamId)}>Copy</button></span></div>
        <div className="kv"><span className="k">Your role</span><span className="v">{ROLE_LABEL[org.yourRole ?? ""] ?? "—"}</span></div>
        <div className="kv"><span className="k">Members</span><span className="v">{org.memberCount}</span></div>
      </div>
      <form onSubmit={join} className="row" style={{ marginBottom: 8, alignItems: "flex-end" }}>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label>Join a team (Team ID or invite code)</label>
          <input value={joinToken} onChange={(e) => setJoinToken(e.target.value)} placeholder="Enter a code to join another company" />
        </div>
        <button className="primary" disabled={!joinToken.trim()}>Join</button>
      </form>
      <p className="muted" style={{ fontSize: 12 }}>Joining another organization moves you into its shared workspace.</p>
      {confirmingName && <ConfirmChanges busy={savingName} onCancel={() => setConfirmingName(false)} onConfirm={saveName} />}
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
    if (!confirm(`Remove ${m.name} from the organization?`)) return;
    try { await api.del(`/org/members/${m.id}`); load(); } catch (e) { onError(e); }
  }
  async function genInvite(reusable: boolean) { try { await api.post("/org/invites", { reusable }); load(); } catch (e) { onError(e); } }
  async function toggleInvite(i: Invite) { await api.patch(`/org/invites/${i.id}`, { active: !i.active }); load(); }
  async function revokeInvite(i: Invite) { if (confirm(`Revoke invite ${i.code}?`)) { await api.del(`/org/invites/${i.id}`); load(); } }
  function copy(text: string) { navigator.clipboard?.writeText(text); onFlash(`Copied ${text}`); }

  // Owner can assign any role; a non-owner manager can't create admins/owners.
  const roleOptions = (m: Member): OrgRole[] => {
    const base: OrgRole[] = isOrgOwner ? ["ADMIN", "MANAGER", "MEMBER", "VIEWER"] : ["MANAGER", "MEMBER", "VIEWER"];
    return m.orgRole && m.orgRole !== "OWNER" && !base.includes(m.orgRole) ? [m.orgRole, ...base] : base;
  };

  return (
    <>
      {can("manageMembers") && (
        <>
          <div className="section-head"><h3 style={{ margin: 0 }}>Team members</h3></div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Status</th><th>Last active</th><th></th></tr></thead>
              <tbody>
                {members.map((m) => {
                  const isSelf = m.id === user?.id;
                  const locked = m.orgRole === "OWNER" || isSelf || (m.orgRole === "ADMIN" && !isOrgOwner);
                  return (
                    <tr key={m.id}>
                      <td>{m.name}{isSelf ? " (you)" : ""}</td>
                      <td>{m.email}</td>
                      <td>{m.phone ? formatPhone(m.phone) : "—"}</td>
                      <td>
                        {locked ? (ROLE_LABEL[m.orgRole ?? ""] ?? "—") : (
                          <select value={m.orgRole ?? "MEMBER"} onChange={(e) => setPendingRole({ m, orgRole: e.target.value as OrgRole })}>
                            {roleOptions(m).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                          </select>
                        )}
                      </td>
                      <td><span className={`badge ${m.status === "ACTIVE" ? "resp-offer" : "resp-no"}`}>{m.status === "ACTIVE" ? "Active" : "Disabled"}</span></td>
                      <td>{m.lastActiveAt ? fmtDate(m.lastActiveAt) : "—"}</td>
                      <td className="right">
                        {!isSelf && m.orgRole !== "OWNER" && (
                          <>
                            <button className="small" onClick={() => setPendingStatus(m)}>{m.status === "ACTIVE" ? "Deactivate" : "Activate"}</button>
                            {can("inviteRemoveUsers") && <button className="small danger" style={{ marginLeft: 6 }} onClick={() => removeMember(m)}>Remove</button>}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {can("inviteRemoveUsers") && (
        <>
          <div className="section-head" style={{ marginTop: 18 }}>
            <h3 style={{ margin: 0 }}>Invite codes</h3>
            <div className="row">
              <button className="small" onClick={() => genInvite(false)}>+ One-time code</button>
              <button className="small" onClick={() => genInvite(true)}>+ Reusable code</button>
            </div>
          </div>
          {invites.length === 0 ? <p className="muted">No invite codes yet.</p> : (
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Code</th><th>Type</th><th>Uses</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {invites.map((i) => (
                    <tr key={i.id}>
                      <td><code>{i.code}</code> <button className="small" onClick={() => copy(i.code)}>Copy</button></td>
                      <td>{i.reusable ? "Reusable" : "One-time"}</td>
                      <td>{i.uses}{i.maxUses != null ? ` / ${i.maxUses}` : ""}</td>
                      <td><span className={`badge ${i.active ? "resp-offer" : "resp-no"}`}>{i.active ? "Active" : "Disabled"}</span></td>
                      <td className="right">
                        <button className="small" onClick={() => toggleInvite(i)}>{i.active ? "Disable" : "Enable"}</button>
                        <button className="small danger" style={{ marginLeft: 6 }} onClick={() => revokeInvite(i)}>Revoke</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
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
    </>
  );
}

function RolesTab({ onFlash, onError }: { onFlash: (m: string) => void; onError: (e: unknown) => void }) {
  const [data, setData] = useState<RolesResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [saving, setSaving] = useState(false);
  const [confirmRole, setConfirmRole] = useState<OrgRole | null>(null);

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

  async function saveRole(role: OrgRole) {
    setSaving(true);
    try { await api.patch(`/org/roles/${role}`, { permissions: [...(draft[role] ?? [])] }); onFlash(`${ROLE_LABEL[role]} permissions saved.`); load(); }
    catch (e) { onError(e); } finally { setSaving(false); setConfirmRole(null); }
  }
  async function resetRole(role: OrgRole) {
    if (!confirm(`Reset ${ROLE_LABEL[role]} to default permissions?`)) return;
    try { await api.del(`/org/roles/${role}`); onFlash(`${ROLE_LABEL[role]} reset to defaults.`); load(); } catch (e) { onError(e); }
  }

  if (!data) return <p className="muted">Loading roles…</p>;

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Toggle permissions per role, then Save. The Owner always has full access. Owner-only actions
        ({data.ownerOnlyActions.join(", ").replace(/([A-Z])/g, " $1").toLowerCase()}) are reserved for the Owner and can't be assigned.
      </p>
      <div className="table-scroll">
        <table className="data-table perm-matrix">
          <thead>
            <tr>
              <th>Permission</th>
              <th className="center">Owner</th>
              {ASSIGNABLE.map((r) => <th key={r} className="center">{ROLE_LABEL[r]}</th>)}
            </tr>
          </thead>
          <tbody>
            {groups.map(({ group, perms }) => (
              <Fragment key={group}>
                <tr className="group-row"><td colSpan={2 + ASSIGNABLE.length}><strong>{group}</strong></td></tr>
                {perms.map((p) => (
                  <tr key={p.key}>
                    <td>{p.label}</td>
                    <td className="center"><input type="checkbox" checked disabled /></td>
                    {ASSIGNABLE.map((r) => (
                      <td key={r} className="center">
                        <input type="checkbox" checked={draft[r]?.has(p.key) ?? false} onChange={() => toggle(r, p.key)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        {ASSIGNABLE.map((r) => (
          <span key={r} className="row" style={{ gap: 4 }}>
            <button className="small primary" disabled={saving} onClick={() => setConfirmRole(r)}>Save {ROLE_LABEL[r]}</button>
            <button className="small" disabled={saving} onClick={() => resetRole(r)}>Reset</button>
          </span>
        ))}
      </div>
      {confirmRole && <ConfirmChanges busy={saving} onCancel={() => setConfirmRole(null)} onConfirm={() => saveRole(confirmRole)} />}
    </>
  );
}

function OwnerTab({ onFlash, onError, onTransferred }: { onFlash: (m: string) => void; onError: (e: unknown) => void; onTransferred: () => void }) {
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [target, setTarget] = useState("");

  useEffect(() => { api.get<Member[]>("/org/members").then(setMembers).catch(() => {}); }, []);

  async function transfer() {
    const m = members.find((x) => x.id === target);
    if (!m) return;
    if (!confirm(`Transfer ownership to ${m.name}? You will become an Administrator. This cannot be undone by you afterward.`)) return;
    try { await api.post("/org/transfer-ownership", { userId: target }); onFlash(`Ownership transferred to ${m.name}.`); onTransferred(); }
    catch (e) { onError(e); }
  }

  const candidates = members.filter((m) => m.id !== user?.id && m.orgRole !== "OWNER");

  return (
    <>
      <div className="section-head"><h3 style={{ margin: 0 }}>Transfer ownership</h3></div>
      <p className="muted" style={{ marginTop: 0 }}>The Owner holds the highest level of control. Transferring ownership demotes you to Administrator.</p>
      <div className="row" style={{ alignItems: "flex-end", marginBottom: 18 }}>
        <div className="field" style={{ marginBottom: 0, minWidth: 240 }}>
          <label>New owner</label>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Select a member…</option>
            {candidates.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.email})</option>)}
          </select>
        </div>
        <button className="danger" disabled={!target} onClick={transfer}>Transfer ownership</button>
      </div>

      <div className="section-head"><h3 style={{ margin: 0 }}>Billing & subscription</h3></div>
      <p className="muted" style={{ marginTop: 0 }}>Billing management isn't configured yet. This owner-only area is reserved for subscription and payment settings.</p>

      <div className="section-head" style={{ marginTop: 12 }}><h3 style={{ margin: 0 }}>Security & authentication</h3></div>
      <p className="muted" style={{ marginTop: 0 }}>Organization-wide security and account-recovery settings will appear here. Reserved for the Owner.</p>
    </>
  );
}
