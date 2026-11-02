import { useEffect, useState, type ReactNode } from "react";
import { LogOut, PenLine, RefreshCw, RotateCcw } from "lucide-react";
import { api, ApiError } from "../api/client";
import { ConfirmDialog, OverflowMenu } from "./ui";
import { UserAvatar } from "./UserAvatar";
import { SignaturesModal } from "./mail/Signatures";
import { IntegrationGroup, IntegrationRow, RowStatus, type RowTone } from "./IntegrationRow";
import { fmtDateTime } from "../lib/format";
import {
  startAccountConnect, type AccountProvider, type AccountProviderInfo, type ConnectedAccount, type AccountsPayload,
} from "../lib/connectedAccounts";

/**
 * Settings → Integrations: the member's OWN Outlook, OneDrive and Google
 * Drive connections, as rows in the same grouped panels as the organization's
 * integrations. Each provider row lists the member's accounts underneath:
 * account, status, last successful sync, granted permissions, errors, and
 * Sync now / Signatures / Reconnect / Disconnect. Admins also get a Team
 * connections panel (who connected what — never contents).
 */

export const PERSONAL_META: Record<AccountProvider, { category: string; name: string; blurb: string; setupUrl: string }> = {
  outlook: {
    category: "Email & Communication", name: "Microsoft Outlook / 365", setupUrl: "https://portal.azure.com",
    blurb: "Read, reply and forward email in the CRM and send from your own address with your Outlook signature (saved to your Sent Items). Conversations with contacts, buyers, deals and opportunities stay on their records.",
  },
  googledrive: {
    category: "Storage & Documents", name: "Google Drive", setupUrl: "https://console.cloud.google.com/apis/credentials",
    blurb: "Browse, search, upload and organize your Google Drive (Docs, Sheets and Slides included) and link files to deals, assets, opportunities, contacts and buyers without copying them.",
  },
  onedrive: {
    category: "Storage & Documents", name: "Microsoft OneDrive", setupUrl: "https://portal.azure.com",
    blurb: "Browse, search, upload and organize your OneDrive and link files to deals, assets, opportunities, contacts and buyers without copying them.",
  },
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

function accountStatus(a: ConnectedAccount): { tone: RowTone; label: string } {
  if (a.status === "DISCONNECTED") return { tone: "off", label: "Disconnected" };
  if (a.status === "NEEDS_RECONNECT") return { tone: "error", label: "Reconnect needed" };
  if (a.syncStatus === "SYNCING") return { tone: "connected", label: "Syncing…" };
  if (a.syncStatus === "ERROR") return { tone: "setup", label: "Sync problem" };
  return { tone: "connected", label: "Connected" };
}

/** The provider row's overall status for this member. */
export function personalStatus(info: AccountProviderInfo, accounts: readonly ConnectedAccount[]): { tone: RowTone; label: string; connected: boolean; title?: string } {
  if (!info.configured) return { tone: "setup", label: "Setup required", connected: false, title: "An administrator needs to finish the one-time app registration on the server." };
  if (!info.allowed) return { tone: "off", label: "Not available", connected: false, title: "Your role doesn't include the permission this needs." };
  if (accounts.some((a) => a.status === "NEEDS_RECONNECT")) return { tone: "error", label: "Reconnect needed", connected: false };
  if (accounts.some((a) => a.status === "CONNECTED")) return { tone: "connected", label: "Connected", connected: true };
  return { tone: "off", label: "Not connected", connected: false };
}

/** Per-account actions and their dialogs, shared by the three provider rows. */
export function usePersonalAccounts({ data, onReload, onMessage, onError }: {
  data: AccountsPayload | null; onReload: () => void; onMessage: (m: string) => void; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<ConnectedAccount | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [signing, setSigning] = useState<ConnectedAccount | null>(null);

  // A sync in progress (ours or the background one): refresh until it settles.
  const syncing = !!data?.accounts.some((a) => a.syncStatus === "SYNCING");
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

  const dialogs: ReactNode = (
    <>
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
    </>
  );
  return { busy, results, connect, sync, setAutoFile, askDisconnect: setDisconnecting, openSignatures: setSigning, dialogs };
}

type AccountsCtl = ReturnType<typeof usePersonalAccounts>;

/** One provider (Outlook / OneDrive / Google Drive) as an integration row, with the member's accounts under it. */
export function PersonalProviderRow({ info, accounts, ctl, isAdmin }: {
  info: AccountProviderInfo; accounts: ConnectedAccount[]; ctl: AccountsCtl; isAdmin: boolean;
}) {
  const meta = PERSONAL_META[info.key];
  const st = personalStatus(info, accounts);
  const canConnect = info.configured && info.allowed && (MULTI[info.key] || accounts.length === 0);
  const connecting = ctl.busy === `connect:${info.key}`;
  const actions = !info.configured
    ? isAdmin && <a className="ig-btn" href={meta.setupUrl} target="_blank" rel="noreferrer noopener">Set up</a>
    : canConnect && (
      <button className={accounts.length ? "small" : "small primary"} disabled={connecting} onClick={() => void ctl.connect(info.key)}>
        {connecting ? "Opening sign-in…" : accounts.length ? "Connect another" : "Connect"}
      </button>
    );
  const legacy = info.legacyConnectedAt && (
    <p className="ig-note">
      A company-wide {meta.name} connection from {fmtDateTime(info.legacyConnectedAt)} still does its old job
      ({info.key === "outlook" ? "importing buyer replies" : "importing files"}) until you connect your own.
    </p>
  );
  return (
    <IntegrationRow iconKey={info.key} name={meta.name} chips={["OAuth 2.0", "Your account"]} description={meta.blurb}
      tone={st.tone} statusLabel={st.label} statusTitle={st.title} actions={actions || undefined}>
      {(accounts.length > 0 || legacy) && (
        <>
          {legacy}
          {accounts.map((a) => <AccountLine key={a.id} a={a} info={info} ctl={ctl} />)}
        </>
      )}
    </IntegrationRow>
  );
}

function AccountLine({ a, info, ctl }: { a: ConnectedAccount; info: AccountProviderInfo; ctl: AccountsCtl }) {
  const st = accountStatus(a);
  const result = ctl.results[a.id];
  const connected = a.status === "CONNECTED";
  return (
    <div className="ig-acct">
      <div className="ig-acct-head">
        <div className="ig-acct-id">
          <strong>{a.email ?? "Account"}</strong>
          {a.displayName && <span>{a.displayName}</span>}
        </div>
        <span className="ig-acct-sync">Last successful sync: <b>{ago(a.lastSyncAt)}</b></span>
        <RowStatus tone={st.tone} label={st.label} title={a.lastError ?? undefined} />
        <div className="ig-actions">
          {connected ? (
            <button className="small" disabled={ctl.busy === `sync:${a.id}` || a.syncStatus === "SYNCING"} onClick={() => void ctl.sync(a)}>
              {ctl.busy === `sync:${a.id}` ? "Syncing…" : "Sync now"}
            </button>
          ) : (
            <button className="small primary" disabled={!info.configured || !info.allowed} onClick={() => void ctl.connect(info.key)}>Reconnect</button>
          )}
          {a.provider === "outlook" && connected && <button className="small" onClick={() => ctl.openSignatures(a)}>Signatures</button>}
          <OverflowMenu ariaLabel={`More for ${a.email ?? "this account"}`} items={[
            ...(connected ? [{ label: <span className="ig-mi"><RotateCcw size={14} /> Reconnect</span>, onClick: () => void ctl.connect(info.key) }] : []),
            ...(connected ? [{ label: <span className="ig-mi"><RefreshCw size={14} /> Sync now</span>, onClick: () => void ctl.sync(a) }] : []),
            ...(a.provider === "outlook" && connected ? [{ label: <span className="ig-mi"><PenLine size={14} /> Signatures</span>, onClick: () => ctl.openSignatures(a) }] : []),
            { label: <span className="ig-mi"><LogOut size={14} /> Disconnect</span>, danger: true, onClick: () => ctl.askDisconnect(a) },
          ]} />
        </div>
      </div>
      {a.permissions.length > 0 && (
        <div className="ig-perms" title="What you allowed the CRM to do with this account">
          {a.permissions.map((p) => <span key={p} className="ig-chip">{p}</span>)}
        </div>
      )}
      {a.missingPermissions.length > 0 && <p className="ig-err">Missing permission: {a.missingPermissions.join(", ")}.</p>}
      {a.lastError && a.missingPermissions.length === 0 && <p className="ig-err">{a.lastError}</p>}
      {result && <p className={result.ok ? "ig-note" : "ig-err"}>{result.message}</p>}
      {a.provider === "outlook" && connected && (
        <label className="ig-toggle" title="Emails to or from your contacts and buyers are filed on their records, where teammates who can open the record see them. Turn off to file emails only by hand.">
          <input type="checkbox" checked={a.autoLinkEmail} onChange={(e) => void ctl.setAutoFile(a, e.target.checked)} />
          Auto-file emails with contacts and buyers on their records
        </label>
      )}
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
    <>
      <IntegrationGroup category="Team connections" count={rows.length}>
        <p className="ig-panel-note">Accounts your team members have connected. You can see that they're connected and disconnect them (for example when someone leaves), but never their mail or files.</p>
        {rows.map((a) => {
          const st = accountStatus(a);
          return (
            <div key={a.id} className="ig-team-row">
              <UserAvatar user={a.owner} size={24} withName className="inline" />
              <span className="ig-team-acct">{a.providerName} · {a.email ?? "account"}</span>
              <span className="ig-acct-sync">synced {ago(a.lastSyncAt)}</span>
              <RowStatus tone={st.tone} label={st.label} />
              <button className="small" onClick={() => setRevoking(a)}>Disconnect</button>
            </div>
          );
        })}
      </IntegrationGroup>
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
    </>
  );
}
