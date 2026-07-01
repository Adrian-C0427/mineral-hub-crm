import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Banner } from "./ui";
import { fmtDate } from "../lib/format";
import { formatPhone } from "../lib/phone";

interface OrgInfo { id: string; name: string; teamId: string; memberCount: number; yourRole: "OWNER" | "MEMBER" }
interface Member { id: string; name: string; email: string; phone: string | null; orgRole: "OWNER" | "MEMBER" | null; status: string }
interface Invite { id: string; code: string; reusable: boolean; active: boolean; maxUses: number | null; uses: number; createdAt: string }

export function OrgSettings() {
  const { user, refresh } = useAuth();
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [joinToken, setJoinToken] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const isOwner = user?.orgRole === "OWNER";

  function loadOrg() { api.get<OrgInfo>("/org").then(setOrg).catch(() => setOrg(null)); }
  function loadOwnerData() {
    if (user?.orgRole !== "OWNER") return;
    api.get<Member[]>("/org/members").then(setMembers).catch(() => {});
    api.get<Invite[]>("/org/invites").then(setInvites).catch(() => {});
  }
  useEffect(() => { loadOrg(); loadOwnerData(); /* eslint-disable-next-line */ }, [user?.orgRole]);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null);
    try {
      await api.post("/auth/join", { token: joinToken.trim() });
      setJoinToken("");
      await refresh();
      setMsg("Joined organization.");
    } catch (e2) { setErr(e2 instanceof ApiError ? e2.message : "Could not join"); }
  }

  async function genInvite(reusable: boolean) {
    setErr(null);
    try { await api.post("/org/invites", { reusable }); loadOwnerData(); }
    catch (e2) { setErr(e2 instanceof ApiError ? e2.message : "Failed"); }
  }
  async function toggleInvite(i: Invite) {
    await api.patch(`/org/invites/${i.id}`, { active: !i.active }); loadOwnerData();
  }
  async function revokeInvite(i: Invite) {
    if (!confirm(`Revoke invite ${i.code}?`)) return;
    await api.del(`/org/invites/${i.id}`); loadOwnerData();
  }
  async function removeMember(m: Member) {
    if (!confirm(`Remove ${m.name} from the organization?`)) return;
    await api.del(`/org/members/${m.id}`); loadOwnerData();
  }
  function copy(text: string) { navigator.clipboard?.writeText(text); setMsg(`Copied ${text}`); }

  return (
    <div className="panel">
      <h3>Organization</h3>
      {msg && <Banner kind="info">{msg}</Banner>}
      {err && <div className="error-text">{err}</div>}

      {org && (
        <div className="dd-grid" style={{ marginBottom: 12 }}>
          <div className="kv"><span className="k">Company</span><span className="v">{org.name}</span></div>
          <div className="kv">
            <span className="k">Team ID</span>
            <span className="v"><code>{org.teamId}</code> <button className="small" onClick={() => copy(org.teamId)}>Copy</button></span>
          </div>
          <div className="kv"><span className="k">Your role</span><span className="v">{org.yourRole === "OWNER" ? "Owner" : "Member"}</span></div>
          <div className="kv"><span className="k">Members</span><span className="v">{org.memberCount}</span></div>
        </div>
      )}

      {/* Join another organization */}
      <form onSubmit={join} className="row" style={{ marginBottom: 8, alignItems: "flex-end" }}>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label>Join a team (Team ID or invite code)</label>
          <input value={joinToken} onChange={(e) => setJoinToken(e.target.value)} placeholder="Enter a code to join another company" />
        </div>
        <button className="primary" disabled={!joinToken.trim()}>Join</button>
      </form>
      <p className="muted" style={{ fontSize: 12 }}>Joining another organization moves you into its shared workspace.</p>

      {isOwner && (
        <>
          {/* Invite codes */}
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

          {/* Members */}
          <div className="section-head" style={{ marginTop: 18 }}><h3 style={{ margin: 0 }}>Members</h3></div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th></th></tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>{m.email}</td>
                    <td>{m.phone ? formatPhone(m.phone) : "—"}</td>
                    <td>{m.orgRole === "OWNER" ? "Owner" : "Member"}</td>
                    <td className="right">
                      {m.id !== user?.id && <button className="small danger" onClick={() => removeMember(m)}>Remove</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
