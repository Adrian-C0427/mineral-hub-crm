import { useEffect, useState } from "react";
import { Cloud, HardDrive, Mail, RefreshCw } from "lucide-react";
import { api, ApiError } from "../api/client";
import { ConfirmDialog } from "./ui";
import { Tag } from "./kit";
import { UserAvatar } from "./UserAvatar";
import { SignaturesModal } from "./mail/Signatures";
import { fmtDateTime } from "../lib/format";
import {
  startAccountConnect, type AccountProvider, type AccountProviderInfo, type ConnectedAccount, type AccountsPayload,
} from "../lib/connectedAccounts";

/**
 * Settings → Integrations: the member's OWN Outlook, OneDrive and Google
 * Drive connections. One card per provider, one row per connected account:
 * status, account, last successful sync, sync status, granted permissions,
 * errors, and Connect / Reconnect / Sync now / Disconnect. Admins also see the
 * team's connections (who connected what — never contents).
 */

const PROVIDER_ICON: Record<AccountProvider, typeof Mail> = { outlook: Mail, onedrive: Cloud, googledrive: HardDrive };
const PROVIDER_COLOR: Record<AccountProvider, string> = { outlook: "#0078D4", onedrive: "#0078D4", googledrive: "#1A73E8" };
const PROVIDER_BLURB: Record<AccountProvider, string> = {
  outlook: "Read, reply and forward email in the CRM, send from your own address with your Outlook signature (saved to your Sent Items), and keep conversations with contacts, buyers, deals and opportunities on their records.",
  onedrive: "Browse, search, upload and organize your OneDrive, preview files, and link them to deals, opportunities, contacts, buyers and mineral assets without copying them.",
  googledrive: "Browse, search, upload and organize your Google Drive (Docs, Sheets and Slides included), preview files, and link them to deals, opportunities, contacts, buyers and mineral assets.",
};
// Several Outlook mailboxes per member are supported (each with its own signatures).
const MULTI: Record<AccountProvider, boolean> = { outlook: true, onedrive: false, googledrive: false };

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return fmtDateTime(iso);
}

function statusTag(a: ConnectedAccount) {
  if (a.status === "DISCONNECTED") return <Tag tone="neutral" dot>Disconnected</Tag>;
  if (a.status === "NEEDS_RECONNECT") return <Tag tone="danger" dot title={a.lastError ?? undefined}>Reconnect needed</Tag>;
  if (a.syncStatus === "SYNCING") return <Tag tone="accent" dot>Syncing…</Tag>;
  if (a.syncStatus === "ERROR") return <Tag tone="warn" dot title={a.lastError ?? undefined}>Sync problem</Tag>;
  return <Tag tone="success" dot>Connected</Tag>;
}

export function ConnectedAccountsSection({ data, onReload, onMessage, onError }: {
  data: AccountsPayload; onReload: () => void; onMessage: (m: string) => void; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<ConnectedAccount | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [signing, setSigning] = useState<ConnectedAccount | null>(null);

  // A sync in progress (ours or the background one): refresh until it settles.
  const syncing = data.accounts.some((a) => a.syncStatus === "SYNCING");
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(onReload, 4000);
    return () => clearInterval(t);
  }, [syncing, onReload]);

  async function connect(p: AccountProvider) {
    setBusy(`connect:${p}`);
    try { await startAccountConnect(p); }
    catch (e) { onError(e instanceof ApiError ? e.message : "Could not start the connection"); setBusy(null); }
  }
  async function sync(a: ConnectedAccount) {
    setBusy(`sync:${a.id}`);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/accounts/${a.id}/sync`, {});
      setResults((m) => ({ ...m, [a.id]: r }));
      onReload();
    } catch (e) { onError(e instanceof ApiError ? e.message : "Sync failed"); }
    finally { setBusy(null); }
  }
  async function setAutoFile(a: ConnectedAccount, on: boolean) {
    try { await api.patch(`/accounts/${a.id}`, { autoLinkEmail: on }); onReload(); }
    catch (e) { onError(e instanceof ApiError ? e.message : "Couldn't save that setting"); }
  }
  async function disconnect(a: ConnectedAccount) {
    setBusy(`disconnect:${a.id}`);
    try {
      await api.post(`/accounts/${a.id}/disconnect`, {});
      onMessage(`${a.providerName} (${a.email ?? "account"}) disconnected. Emails and files already linked to records stay where they are.`);
      onReload();
    } catch (e) { onError(e instanceof ApiError ? e.message : "Could not disconnect"); }
    finally { setBusy(null); setDisconnecting(null); }
  }

  return (
    <div className="integ-group">
      <span className="integ-group-label"><Mail size={14} aria-hidden="true" /> Your connected accounts</span>
      <p className="integ-group-desc">
        Connected by you, for you. The CRM works with these accounts only on your behalf; teammates see an email or file only after it's linked to a
        record they can open. Your sign-in stays with Microsoft or Google; the CRM keeps an encrypted access token, never your password.
      </p>
      <div className="integration-grid">
        {data.providers.map((p) => (
          <ProviderCard
            key={p.key}
            p={p}
            accounts={data.accounts.filter((a) => a.provider === p.key && a.status !== "DISCONNECTED")}
            busy={busy}
            results={results}
            onConnect={() => void connect(p.key)}
            onSync={(a) => void sync(a)}
            onDisconnect={setDisconnecting}
            onSignatures={setSigning}
            onAutoFile={(a, on) => void setAutoFile(a, on)}
          />
        ))}
      </div>
      {signing && <SignaturesModal account={signing} onClose={() => setSigning(null)} />}
      {disconnecting && (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.providerName}?`}
          message={
            <p style={{ margin: 0 }}>
              The CRM stops working with <strong>{disconnecting.email ?? "this account"}</strong> and deletes its stored sign-in
              {disconnecting.provider === "googledrive" ? " (and revokes it with Google)" : ""}.
              {disconnecting.provider === "outlook" && " Emails still waiting to send from it are cancelled."}
              {" "}Nothing in your {disconnecting.provider === "outlook" ? "mailbox" : "drive"} is touched, and emails or files already linked to records stay
              on them. Reconnect any time.
            </p>
          }
          confirmLabel="Disconnect"
          danger
          busy={busy === `disconnect:${disconnecting.id}`}
          onCancel={() => setDisconnecting(null)}
          onConfirm={() => void disconnect(disconnecting)}
        />
      )}
    </div>
  );
}

function ProviderCard({ p, accounts, busy, results, onConnect, onSync, onDisconnect, onSignatures, onAutoFile }: {
  p: AccountProviderInfo; accounts: ConnectedAccount[]; busy: string | null;
  results: Record<string, { ok: boolean; message: string }>;
  onConnect: () => void; onSync: (a: ConnectedAccount) => void; onDisconnect: (a: ConnectedAccount) => void;
  onSignatures: (a: ConnectedAccount) => void; onAutoFile: (a: ConnectedAccount, on: boolean) => void;
}) {
  const Icon = PROVIDER_ICON[p.key];
  const anyConnected = accounts.some((a) => a.status === "CONNECTED");
  const anyBroken = accounts.some((a) => a.status === "NEEDS_RECONNECT");
  const headTag = !p.configured ? <Tag tone="warn" dot title="An administrator needs to finish the one-time app registration on the server.">Setup required</Tag>
    : !p.allowed ? <Tag tone="neutral" dot title="Your role doesn't include the permission this needs.">Not available</Tag>
    : anyBroken ? <Tag tone="danger" dot>Reconnect needed</Tag>
    : anyConnected ? <Tag tone="success" dot>Connected</Tag>
    : <Tag tone="neutral" dot>Not connected</Tag>;
  const canConnect = p.configured && p.allowed && (MULTI[p.key] || accounts.length === 0);
  return (
    <div className={`integration-card ${anyConnected && !anyBroken ? "connected" : ""}`}>
      <div className="integration-head">
        <span className="integration-logo" style={{ color: PROVIDER_COLOR[p.key] }}><Icon size={20} /></span>
        <div className="integration-id">
          <div className="integration-name">{p.name}</div>
          <div className="integration-chips"><span className="chip-mini" title="Connected with OAuth 2.0 to your own account">Your account</span></div>
        </div>
        {headTag}
      </div>
      <p className="integration-desc" title={PROVIDER_BLURB[p.key]}>{PROVIDER_BLURB[p.key]}</p>

      {p.legacyConnectedAt && (
        <p className="integration-meta">
          A company-wide {p.name} connection from before {fmtDateTime(p.legacyConnectedAt)} still does its old job
          ({p.key === "outlook" ? "importing buyer replies" : "importing files"}) until you connect your own here.
        </p>
      )}

      {accounts.length > 0 && (
        <ul className="ca-list">
          {accounts.map((a) => (
            <li key={a.id} className="ca-row">
              <div className="ca-row-head">
                <div className="ca-id">
                  <span className="ca-email">{a.email ?? "Account"}</span>
                  {a.displayName && <span className="ca-name">{a.displayName}</span>}
                </div>
                {statusTag(a)}
              </div>
              <div className="ca-meta">
                Last successful sync: <strong>{ago(a.lastSyncAt)}</strong>
                {a.lastSyncAttemptAt && a.syncStatus === "ERROR" ? ` · last attempt ${ago(a.lastSyncAttemptAt)}` : ""}
              </div>
              {a.permissions.length > 0 && (
                <div className="ca-perms" title="What you allowed the CRM to do with this account">
                  {a.permissions.map((perm) => <span key={perm} className="chip-mini">{perm}</span>)}
                </div>
              )}
              {a.missingPermissions.length > 0 && (
                <p className="error-text integration-err">Missing permission: {a.missingPermissions.join(", ")}.</p>
              )}
              {a.lastError && a.missingPermissions.length === 0 && <p className="error-text integration-err">{a.lastError}</p>}
              {results[a.id] && <p className={results[a.id].ok ? "integration-meta" : "error-text integration-err"}>{results[a.id].message}</p>}
              {a.provider === "outlook" && a.status === "CONNECTED" && (
                <label className="ca-toggle" title="Emails to or from your contacts and buyers are filed on their records, where teammates who can open the record see them. Turn off to file emails only by hand.">
                  <input type="checkbox" checked={a.autoLinkEmail} onChange={(e) => onAutoFile(a, e.target.checked)} />
                  Auto-file emails with contacts and buyers on their records
                </label>
              )}
              <div className="integration-actions">
                {a.status === "CONNECTED" ? (
                  <button className="small" disabled={busy === `sync:${a.id}` || a.syncStatus === "SYNCING"} onClick={() => onSync(a)}>
                    <RefreshCw size={13} aria-hidden="true" /> {busy === `sync:${a.id}` ? "Syncing…" : "Sync now"}
                  </button>
                ) : (
                  <button className="small primary" disabled={!p.configured || !p.allowed || busy === `connect:${p.key}`} onClick={onConnect}>Reconnect</button>
                )}
                {a.provider === "outlook" && a.status === "CONNECTED" && <button className="small" onClick={() => onSignatures(a)}>Signatures</button>}
                <button className="small set-btn-danger-text" onClick={() => onDisconnect(a)}>Disconnect</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="integration-actions">
        {canConnect && (
          <button className={`small ${accounts.length ? "" : "primary"}`} disabled={busy === `connect:${p.key}`} onClick={onConnect}>
            {busy === `connect:${p.key}` ? "Opening sign-in…" : accounts.length ? "Connect another account" : `Connect ${p.name.replace(/^(Microsoft|Google) /, "")}`}
          </button>
        )}
      </div>
    </div>
  );
}

interface TeamAccount extends ConnectedAccount { owner: { id: string; name: string; avatarColor?: string | null } }

/** Admins: who in the organization has connected which accounts (no contents). */
export function TeamConnections({ onMessage, onError }: { onMessage: (m: string) => void; onError: (m: string) => void }) {
  const [rows, setRows] = useState<TeamAccount[] | null>(null);
  const [revoking, setRevoking] = useState<TeamAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => { api.get<TeamAccount[]>("/accounts/team").then(setRows).catch(() => setRows([])); };
  useEffect(load, []);
  if (!rows || rows.length === 0) return null;
  async function revoke(a: TeamAccount) {
    setBusy(true);
    try { await api.post(`/accounts/team/${a.id}/disconnect`, {}); onMessage(`Disconnected ${a.owner.name}'s ${a.providerName}.`); load(); }
    catch (e) { onError(e instanceof ApiError ? e.message : "Could not disconnect"); }
    finally { setBusy(false); setRevoking(null); }
  }
  return (
    <div className="integ-group">
      <span className="integ-group-label">Team connections</span>
      <p className="integ-group-desc">Accounts your team members have connected. You can see that they're connected and disconnect them (for example when someone leaves), but never their mail or files.</p>
      <div className="ca-team">
        {rows.map((a) => (
          <div key={a.id} className="ca-team-row">
            <UserAvatar user={a.owner} size={22} withName className="inline" />
            <span className="ca-team-acct">{a.providerName} · {a.email ?? "account"}</span>
            {statusTag(a)}
            <span className="ca-team-sync">synced {ago(a.lastSyncAt)}</span>
            <button className="small set-btn-danger-text" onClick={() => setRevoking(a)}>Disconnect</button>
          </div>
        ))}
      </div>
      {revoking && (
        <ConfirmDialog
          title={`Disconnect ${revoking.owner.name}'s ${revoking.providerName}?`}
          message={<p style={{ margin: 0 }}>The CRM stops using {revoking.email ?? "this account"} and deletes its stored sign-in. Linked emails and files stay on their records. {revoking.owner.name} can reconnect it.</p>}
          confirmLabel="Disconnect"
          danger
          busy={busy}
          onCancel={() => setRevoking(null)}
          onConfirm={() => void revoke(revoking)}
        />
      )}
    </div>
  );
}
