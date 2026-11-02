import { useEffect, useMemo, useState, type ReactNode } from "react";
import { KeyRound, LogOut, RefreshCw, RotateCcw, Settings2, Tags } from "lucide-react";
import { api, ApiError } from "../api/client";
import { Spinner, Banner, Modal, ConfirmChanges, ConfirmDialog, OverflowMenu } from "../components/ui";
import { Select } from "../components/Select";
import { fmtDate, fmtDateTime } from "../lib/format";
import { SettingsLayout } from "../components/SettingsNav";
import { Segmented, Tag } from "../components/kit";
import { useHighLevelStatus, HighLevelSummary, HighLevelConnectModal, HighLevelConfigureModal } from "../components/HighLevelIntegration";
import { PERSONAL_META, PersonalProviderRow, personalStatus, TeamConnections, usePersonalAccounts } from "../components/ConnectedAccounts";
import { CATEGORY_ORDER, IntegrationGroup, IntegrationRow, type RowTone } from "../components/IntegrationRow";
import { useConnectedAccounts, type AccountProvider, type AccountProviderInfo } from "../lib/connectedAccounts";
import { HL_SYNC_EVERY, type HighLevelStatus } from "../lib/highlevel";
import { useAuth } from "../auth/AuthContext";

// The catalog lives on the SERVER (domain/integrationCatalog.ts) — the single
// source of truth for which providers exist, how they authenticate, and how far
// each implementation has gotten. This page renders what the API returns; only
// presentation (icons, names, copy, ordering) is decided here.
//
// Layout (the design's Settings → Integrations): rows in grouped panels — one
// panel per category with a count, each row an icon, the name with its
// connection type, a two-line description, a status and its actions, details
// underneath. The member's own Outlook / OneDrive / Google Drive sit in their
// categories as rows too, with their connected accounts under them.

type Auth = "apikey" | "webhook" | "oauth" | "env";
type Impl = "live" | "env" | "oauth";

interface ResendDomain { name: string; status: string }

interface Provider {
  key: string; name: string; category: string; auth: Auth; implementation: Impl;
  description: string; secretLabel?: string; secretHint?: string; setupUrl?: string; syncable?: boolean;
  /** Connected per member (a personal row), not once for the org. */
  personal?: boolean;
  status: "CONNECTED" | "NOT_CONNECTED" | "ERROR";
  configured: boolean;
  config: {
    schedule?: string; notes?: string; fromEmail?: string; fromName?: string; domains?: ResendDomain[];
    // HighLevel
    locationId?: string; locationName?: string; responseWindowDays?: number; pricePerSegment?: number | null; crmTagsEnabled?: boolean;
  };
  secretMask: string | null;
  connectedAt: string | null; lastSyncAt: string | null; lastError: string | null;
}

const AUTH_LABEL: Record<Auth, string> = { oauth: "OAuth 2.0", apikey: "API key", webhook: "Webhook", env: "Built-in" };

// The design's short names, extra labels and two-line descriptions (the full
// catalog text stays available on hover where it says more).
const DISPLAY_NAME: Record<string, string> = { smtp: "SMTP fallback", storage: "Object storage (S3)", highlevel: "HighLevel" };
const EXTRA_CHIPS: Record<string, { before?: string[]; after?: string[] }> = {
  resend: { after: ["Primary email"] }, highlevel: { before: ["LeadConnector"] }, entra: { after: ["SSO"] },
};
const SHORT_DESC: Record<string, string> = {
  resend: "Sends the app's email: portal notifications, reminders, invitations, password resets, and buyer outreach for anyone without Outlook connected.",
  smtp: "Sends email through your own mail server, only when Resend isn't connected. Configured with SMTP_* variables on the API service.",
  teams: "Posts deal and portal notifications (new leads, offers, buyer replies) to a Teams channel through a Power Automate workflow.",
  claude: "Drafts outreach and summarizes deals. The key is checked against the Anthropic API when you connect.",
  storage: "Stores deal and buyer attachments in S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2). Configured on the API service.",
  outlookcalendar: "Mirrors deal deadlines (find buyer by, closing, extended closing) as events on your Outlook calendar and keeps them up to date.",
  entra: "Single sign-on with Microsoft Entra ID (OpenID Connect). Configured with MICROSOFT_CLIENT_ID and related variables.",
};

/** Verification chips for Resend — one per sending domain. */
function DomainChips({ domains }: { domains: ResendDomain[] }) {
  if (!domains.length) return null;
  return (
    <div className="ig-perms">
      {domains.map((d) => (
        <Tag
          key={d.name}
          tone={d.status === "verified" ? "success" : "warn"}
          title={d.status === "verified" ? "Domain verified — emails from this domain will deliver." : `Domain status: ${d.status}. Finish DNS verification at resend.com/domains.`}
        >
          {d.name} · {d.status}
        </Tag>
      ))}
    </div>
  );
}

function orgStatus(p: Provider): { tone: RowTone; label: string; title?: string; connected: boolean } {
  if (p.implementation === "env") return p.status === "CONNECTED"
    ? { tone: "connected", label: "Connected", connected: true }
    : { tone: "off", label: "Not configured", connected: false, title: "Set with environment variables on the API service." };
  if (p.status === "CONNECTED") return { tone: "connected", label: "Connected", connected: true };
  if (p.status === "ERROR") return { tone: "error", label: "Error", connected: false, title: p.lastError ?? "The last check failed — reconnect or re-validate." };
  if (p.implementation === "oauth" && !p.configured) return { tone: "setup", label: "Setup required", connected: false, title: "Needs a one-time server-side setup (OAuth app registration) before it can be connected." };
  return { tone: "off", label: "Not connected", connected: false };
}

export function Integrations() {
  const { can, user } = useAuth();
  // Admins manage the organization's integrations; every member with the
  // matching permission manages their own Outlook / OneDrive / Google Drive.
  const isAdmin = can("manageApiIntegrations");
  const mine = useConnectedAccounts();
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Provider | null>(null);
  const [configuring, setConfiguring] = useState<Provider | null>(null);
  const [disconnecting, setDisconnecting] = useState<Provider | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [filter, setFilter] = useState<"all" | "connected" | "setup">("all");
  const onMessage = (m: string) => { setErr(null); setFlash(m); };
  const onError = (m: string) => { setFlash(null); setErr(m); };
  const accounts = usePersonalAccounts({ data: mine.data, onReload: mine.reload, onMessage, onError });

  function load() {
    if (!isAdmin) { setProviders([]); return; }
    api.get<Provider[]>("/integrations")
      .then(setProviders)
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Failed to load integrations"));
  }
  useEffect(load, []);

  // Surface the outcome of an OAuth round-trip (provider redirected back here).
  // A successful authorization arrives as #oauth=<provider>&code=…&state=… in
  // the fragment; we finish it through the authed /oauth/complete route, which
  // checks this session is the user who started the flow.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const h = new URLSearchParams(window.location.hash.slice(1));
    const provider = h.get("oauth"), code = h.get("code"), state = h.get("state"), flow = h.get("flow");
    if (q.get("connected")) setFlash(`${q.get("connected")} connected.`);
    else if (q.get("error")) setErr(decodeURIComponent(q.get("error")!));
    if (q.get("connected") || q.get("error") || provider) window.history.replaceState({}, "", window.location.pathname);
    if (provider && code && state && flow === "account") {
      // A member's own account (Outlook / OneDrive / Google Drive).
      setBusyKey(provider);
      api.post<{ message: string }>(`/accounts/${encodeURIComponent(provider)}/oauth/complete`, { code, state })
        .then((r) => { setFlash(r.message); mine.reload(); })
        .catch((e) => setErr(e instanceof ApiError ? e.message : "Could not complete the connection"))
        .finally(() => setBusyKey(null));
    } else if (provider && code && state) {
      setBusyKey(provider);
      api.post<{ connected: string }>(`/integrations/${encodeURIComponent(provider)}/oauth/complete`, { code, state })
        .then(() => { setFlash(`${provider} connected.`); load(); })
        .catch((e) => setErr(e instanceof ApiError ? e.message : "Could not complete the connection"))
        .finally(() => setBusyKey(null));
    }
  }, []);

  // Begin an OAuth authorization: fetch the provider URL, then hand the browser off.
  async function startOAuth(p: Provider) {
    setBusyKey(p.key); setErr(null);
    try {
      const { url } = await api.get<{ url: string }>(`/integrations/${p.key}/oauth/start`);
      window.location.href = url;
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not start authorization"); setBusyKey(null); }
  }

  async function run(p: Provider, action: "test" | "sync") {
    setBusyKey(p.key); setErr(null);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/integrations/${p.key}/${action}`, {});
      setTestResult((m) => ({ ...m, [p.key]: r }));
      load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Request failed"); }
    finally { setBusyKey(null); }
  }

  async function disconnect(p: Provider) {
    setBusyKey(p.key); setErr(null);
    try { await api.post(`/integrations/${p.key}/disconnect`, {}); setFlash(`${p.name} disconnected.`); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Failed"); }
    finally { setBusyKey(null); setDisconnecting(null); }
  }

  // Every row on the page, in the design's order: the org catalog (admins) with
  // its personal providers swapped for the member's own rows; members without
  // the admin view see just their personal rows.
  type Item = { kind: "org"; p: Provider; category: string; connected: boolean } | { kind: "personal"; info: AccountProviderInfo; category: string; connected: boolean };
  const items = useMemo<Item[]>(() => {
    const infos = new Map((mine.data?.providers ?? []).map((i) => [i.key, i] as const));
    const personal = (key: AccountProvider): Item | null => {
      const info = infos.get(key);
      if (!info) return null;
      const accts = (mine.data?.accounts ?? []).filter((a) => a.provider === key && a.status !== "DISCONNECTED");
      return { kind: "personal", info, category: PERSONAL_META[key].category, connected: personalStatus(info, accts).connected };
    };
    const out: Item[] = [];
    if (isAdmin && providers) {
      for (const p of providers) {
        if (p.personal) { const it = personal(p.key as AccountProvider); if (it) out.push(it); }
        else out.push({ kind: "org", p, category: p.category, connected: orgStatus(p).connected });
      }
    } else {
      for (const key of ["outlook", "googledrive", "onedrive"] as AccountProvider[]) { const it = personal(key); if (it) out.push(it); }
    }
    return out;
  }, [providers, mine.data, isAdmin]);

  if (!providers || (!mine.data && !mine.error)) return <SettingsLayout><Spinner label="Loading integrations…" /></SettingsLayout>;

  const connectedCount = items.filter((i) => i.connected).length;
  // View filter (presentation only): counts are of the rows on this page.
  const shownItems = items.filter((i) => filter === "all" || (filter === "connected" ? i.connected : !i.connected));
  const groups = CATEGORY_ORDER
    .map((category) => [category, shownItems.filter((i) => i.category === category)] as const)
    .concat([...new Set(shownItems.map((i) => i.category))].filter((c) => !CATEGORY_ORDER.includes(c)).map((c) => [c, shownItems.filter((i) => i.category === c)] as const))
    .filter(([, list]) => list.length > 0);
  const orgName = user?.organization?.name ?? "your organization";

  return (
    <SettingsLayout>
      <div className="ig-head">
        <div className="ig-head-text">
          <h3 className="set-title">Integrations</h3>
          <p className="set-desc">
            Connect the services {orgName} uses for email, texting, documents and sign-in. Credentials are checked when you connect
            and stored encrypted. They're never sent back to the browser.
          </p>
        </div>
        <Segmented
          className="ig-filter"
          ariaLabel="Show integrations"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: items.length },
            { value: "connected", label: "Connected", count: connectedCount },
            { value: "setup", label: "Needs setup", count: items.length - connectedCount },
          ]}
        />
      </div>
      {err && <Banner kind="error">{err}</Banner>}
      {mine.error && <Banner kind="error">{mine.error}</Banner>}
      {flash && <Banner kind="info">{flash}</Banner>}

      {groups.length === 0 && <div className="integ-none">Nothing here.</div>}
      {groups.map(([category, list]) => (
        <IntegrationGroup key={category} category={category} count={list.length}>
          {list.map((it) => it.kind === "personal" ? (
            <PersonalProviderRow key={it.info.key} info={it.info} isAdmin={isAdmin} ctl={accounts}
              accounts={(mine.data?.accounts ?? []).filter((a) => a.provider === it.info.key && a.status !== "DISCONNECTED")} />
          ) : (
            <OrgRow
              key={it.p.key}
              p={it.p}
              busy={busyKey === it.p.key}
              result={testResult[it.p.key]}
              onConnect={() => setConnecting(it.p)}
              onOAuth={() => startOAuth(it.p)}
              onDisconnect={() => setDisconnecting(it.p)}
              onConfigure={() => setConfiguring(it.p)}
              onTest={() => run(it.p, "test")}
              onSync={() => run(it.p, "sync")}
              onReload={load}
            />
          ))}
        </IntegrationGroup>
      ))}
      {isAdmin && <TeamConnections onMessage={onMessage} onError={onError} />}
      {accounts.dialogs}

      {connecting?.key === "highlevel" && (
        <HighLevelConnectModal
          name={connecting.name}
          setupUrl={connecting.setupUrl}
          locationId={connecting.status !== "NOT_CONNECTED" ? connecting.config.locationId : undefined}
          onClose={() => setConnecting(null)}
          onConnected={(msg) => { setConnecting(null); setFlash(msg); load(); }}
        />
      )}
      {connecting && connecting.key !== "highlevel" && (
        <ConnectModal
          provider={connecting}
          onClose={() => setConnecting(null)}
          onConnected={(msg) => { setConnecting(null); setFlash(msg); load(); }}
        />
      )}
      {configuring?.key === "highlevel" && (
        <HighLevelConfigureModal
          name={configuring.name}
          config={configuring.config}
          onClose={() => setConfiguring(null)}
          onSaved={(msg) => { setConfiguring(null); setFlash(msg ?? "Settings saved."); load(); }}
        />
      )}
      {configuring && configuring.key !== "highlevel" && (
        <ConfigureModal
          provider={configuring}
          onClose={() => setConfiguring(null)}
          onSaved={() => { setConfiguring(null); setFlash("Settings saved."); load(); }}
        />
      )}
      {disconnecting && (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.name}?`}
          message={
            disconnecting.key === "highlevel" ? (
              <p style={{ margin: 0 }}>
                Syncing stops and the stored key is deleted. Texts already imported stay, so Reports keep their history.
                You can reconnect any time with a new key — syncing picks up where it left off.
              </p>
            ) : (
              <p style={{ margin: 0 }}>
                The stored credential will be deleted. You can reconnect at any time with a new {disconnecting.secretLabel?.toLowerCase() ?? "credential"}.
                {disconnecting.key === "resend" && " Until then, outbound email falls back to the instance-wide transport (or fails with a clear error if none is configured)."}
              </p>
            )
          }
          confirmLabel="Disconnect"
          danger
          busy={busyKey === disconnecting.key}
          onCancel={() => setDisconnecting(null)}
          onConfirm={() => disconnect(disconnecting)}
        />
      )}
    </SettingsLayout>
  );
}

const mi = (icon: ReactNode, text: string) => <span className="ig-mi">{icon} {text}</span>;

/** One organization integration as a row (the design's list layout). */
function OrgRow({ p, busy, result, onConnect, onOAuth, onDisconnect, onConfigure, onTest, onSync, onReload }: {
  p: Provider; busy: boolean; result?: { ok: boolean; message: string };
  onConnect: () => void; onOAuth: () => void; onDisconnect: () => void; onConfigure: () => void; onTest: () => void; onSync: () => void;
  onReload: () => void;
}) {
  const connected = p.status === "CONNECTED";
  const errored = p.status === "ERROR";
  // HighLevel shows its sync phase (preview → importing → live) from its own status route.
  const isHL = p.key === "highlevel";
  const hl = useHighLevelStatus(isHL && (connected || errored), `${p.status}|${p.lastSyncAt}|${p.connectedAt}|${p.lastError}`, onReload);
  const hlPhase = hl.status?.phase ?? null;
  // An OAuth provider that isn't configured on the server can't be connected
  // yet — it needs an app registration + server credentials.
  const needsSetup = p.implementation === "oauth" && !p.configured;
  const st = orgStatus(p);
  const chips = [...(EXTRA_CHIPS[p.key]?.before ?? []), AUTH_LABEL[p.auth], ...(EXTRA_CHIPS[p.key]?.after ?? [])];
  const replaceLabel = p.auth === "webhook" ? "Replace webhook URL" : p.key === "highlevel" ? "Replace key" : "Replace credentials";

  let actions: ReactNode;
  if (needsSetup) {
    actions = p.setupUrl ? <a className="ig-btn" href={p.setupUrl} target="_blank" rel="noreferrer noopener">Set up</a> : null;
  } else if (p.implementation === "env") {
    actions = <button className="small" disabled={busy} onClick={onTest}>{busy ? "Testing…" : "Test connection"}</button>;
  } else if (isHL && (connected || errored)) {
    actions = (
      <>
        {hlPhase === "preview" && (
          <button className="small primary" disabled={hl.starting || errored} onClick={() => void hl.startImport()}>{hl.starting ? "Starting…" : "Start import"}</button>
        )}
        <button className="small" disabled={busy} onClick={onTest}>{busy ? "Working…" : "Test"}</button>
        {hlPhase === "live" && <button className="small" disabled={busy} onClick={onSync}>Sync now</button>}
        <OverflowMenu ariaLabel="More HighLevel actions" items={[
          ...(hlPhase === "live" ? [{
            label: mi(<Tags size={14} />, hl.status?.tagRefresh?.running ? "Re-reading tags…" : "Re-read tags now"),
            onClick: () => { if (!hl.starting && !errored && !hl.status?.tagRefresh?.running) void hl.rereadTags(); },
          }] : []),
          { label: mi(<Settings2 size={14} />, "Configure"), onClick: onConfigure },
          { label: mi(<KeyRound size={14} />, replaceLabel), onClick: onConnect },
          { label: mi(<LogOut size={14} />, "Disconnect"), danger: true, onClick: onDisconnect },
        ]} />
      </>
    );
  } else if (connected || errored) {
    actions = (
      <>
        <button className="small" disabled={busy} onClick={onTest}>{busy ? "Working…" : "Test"}</button>
        {p.syncable && <button className="small" disabled={busy} onClick={onSync}>Sync now</button>}
        <OverflowMenu ariaLabel={`More ${p.name} actions`} items={[
          ...(p.implementation !== "oauth" ? [{ label: mi(<Settings2 size={14} />, "Configure"), onClick: onConfigure }] : []),
          p.implementation === "oauth"
            ? { label: mi(<RotateCcw size={14} />, "Reconnect"), onClick: onOAuth }
            : { label: mi(<KeyRound size={14} />, replaceLabel), onClick: onConnect },
          { label: mi(<LogOut size={14} />, "Disconnect"), danger: true, onClick: onDisconnect },
        ]} />
      </>
    );
  } else {
    actions = (
      <button className="small primary" disabled={busy} onClick={p.implementation === "oauth" ? onOAuth : onConnect}>
        {busy ? "Starting…" : "Connect"}
      </button>
    );
  }

  const details = (
    <>
      {p.key === "resend" && (connected || errored) && p.config.fromEmail && (
        <p className="ig-note">Sender: <code>{p.config.fromName ? `${p.config.fromName} <${p.config.fromEmail}>` : p.config.fromEmail}</code></p>
      )}
      {p.key === "resend" && (connected || errored) && <DomainChips domains={p.config.domains ?? []} />}
      {connected && p.secretMask && !isHL && <p className="ig-note">Credential: <code>{p.secretMask}</code></p>}
      {connected && p.lastSyncAt && !isHL && p.syncable && (
        <p className="ig-note">Last sync: {fmtDateTime(p.lastSyncAt)}{p.config.schedule && p.config.schedule !== "manual" ? ` · auto (${p.config.schedule})` : ""}</p>
      )}
      {isHL && hl.status && (connected || errored) && (hl.status.phase === "live"
        ? <HighLevelFigures s={hl.status} secretMask={p.secretMask} connectedAt={p.connectedAt} />
        : <HighLevelSummary s={hl.status} />)}
      {isHL && hl.error && <p className="ig-err">{hl.error}</p>}
      {p.lastError && <p className="ig-err">{p.lastError}</p>}
      {result && <p className={result.ok ? "ig-note" : "ig-err"}>{result.message}</p>}
    </>
  );
  const hasDetails = (p.key === "resend" && (connected || errored)) || (connected && (p.secretMask || (p.lastSyncAt && p.syncable)))
    || (isHL && (hl.status || hl.error)) || p.lastError || result;

  return (
    <IntegrationRow iconKey={p.key} name={DISPLAY_NAME[p.key] ?? p.name} chips={chips} description={SHORT_DESC[p.key] ?? p.description}
      tone={st.tone} statusLabel={st.label} statusTitle={st.title} actions={actions}>
      {hasDetails ? details : null}
    </IntegrationRow>
  );
}

/** HighLevel, live: the four figures, then the credential / location / connected line. */
function HighLevelFigures({ s, secretMask, connectedAt }: { s: HighLevelStatus; secretMask: string | null; connectedAt: string | null }) {
  const n = (v: number) => v.toLocaleString("en-US");
  const checked = s.lastSyncAt ? new Date(s.lastSyncAt) : null;
  const tagged = s.crmTags?.tagged ?? 0;
  return (
    <div className="ig-figs">
      <div className="ig-figs-grid">
        <div className="ig-fig"><span className="ig-fig-k">Texts synced</span><b className="ig-fig-v">{n(s.imported)}</b><span className="ig-fig-s">from {n(s.contacts)} contact{s.contacts === 1 ? "" : "s"}</span></div>
        <div className="ig-fig"><span className="ig-fig-k">Tagged contacts</span><b className="ig-fig-v">{n(tagged)}</b><span className="ig-fig-s">SMS &amp; Acquisition tags</span></div>
        <div className="ig-fig"><span className="ig-fig-k">Last checked</span><b className="ig-fig-v">{checked ? checked.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"}</b><span className="ig-fig-s">{checked ? `${checked.toLocaleDateString([], { month: "short", day: "numeric" })} · ${HL_SYNC_EVERY}` : HL_SYNC_EVERY}</span></div>
        <div className="ig-fig"><span className="ig-fig-k">Status</span><b className={`ig-fig-v ${s.status === "ERROR" ? "warn" : "ok"}`}>{s.status === "ERROR" ? "Needs attention" : "Up to date"}</b><span className="ig-fig-s">Feeds Reports → SMS performance</span></div>
      </div>
      <div className="ig-figs-foot">
        {secretMask && <span>Credential <code>{secretMask}</code></span>}
        {s.locationName && <span>Location <code>{s.locationName}</code></span>}
        {connectedAt && <span>Connected <code>{fmtDate(connectedAt)}</code></span>}
      </div>
      {/* Tag re-read progress, CRM tag writes, last run, missing permissions — as before. */}
      <HighLevelSummary s={{ ...s, locationName: null }} extrasOnly />
    </div>
  );
}

function ConnectModal({ provider, onClose, onConnected }: { provider: Provider; onClose: () => void; onConnected: (msg: string) => void }) {
  const [secret, setSecret] = useState("");
  const [fromEmail, setFromEmail] = useState(provider.config.fromEmail ?? "");
  const [fromName, setFromName] = useState(provider.config.fromName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isResend = provider.key === "resend";

  async function connect() {
    if (!secret.trim()) { setError(`${provider.secretLabel ?? "A credential"} is required.`); return; }
    if (isResend && !fromEmail.trim()) { setError("A sender email address is required — it becomes the From address on every email the app sends."); return; }
    setBusy(true); setError(null);
    try {
      const config = isResend ? { fromEmail: fromEmail.trim(), ...(fromName.trim() ? { fromName: fromName.trim() } : {}) } : undefined;
      const r = await api.post<{ message?: string }>(`/integrations/${provider.key}/connect`, { secret: secret.trim(), ...(config ? { config } : {}) });
      onConnected(r.message ?? `${provider.name} connected.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Connection failed");
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`Connect ${provider.name}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={connect} disabled={busy}>{busy ? "Validating…" : "Validate & connect"}</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>{provider.description}</p>
      <div className="field">
        <label>{provider.secretLabel ?? "Credential"}</label>
        <input className="mono-input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={provider.secretHint ?? ""} autoFocus autoComplete="off" />
      </div>
      {isResend && (
        <>
          <div className="field">
            <label>Sender email (From address)</label>
            <input type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="deals@mail.yourdomain.com" autoComplete="off" />
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Must be on a domain verified in your Resend account — the connection check confirms this.</p>
          </div>
          <div className="field">
            <label>Sender name (optional)</label>
            <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Carsa Minerals" autoComplete="off" />
          </div>
        </>
      )}
      <p className="muted" style={{ fontSize: 12 }}>
        The credential is checked against {provider.name} before anything is saved, then stored encrypted (AES-256-GCM).
        It is never displayed again — only the last 4 characters are shown for identification.
        {provider.setupUrl && <> Need a key? <a href={provider.setupUrl} target="_blank" rel="noreferrer">Create one here ↗</a></>}
      </p>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

function ConfigureModal({ provider, onClose, onSaved }: { provider: Provider; onClose: () => void; onSaved: () => void }) {
  const [schedule, setSchedule] = useState(provider.config.schedule ?? "manual");
  const [notes, setNotes] = useState(provider.config.notes ?? "");
  const [fromEmail, setFromEmail] = useState(provider.config.fromEmail ?? "");
  const [fromName, setFromName] = useState(provider.config.fromName ?? "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isResend = provider.key === "resend";

  async function save() {
    setConfirming(false); setBusy(true); setError(null);
    try {
      const config: Record<string, string> = { schedule, notes };
      if (isResend) {
        if (!fromEmail.trim()) { setError("Resend needs a sender email address."); setBusy(false); return; }
        config.fromEmail = fromEmail.trim();
        config.fromName = fromName.trim();
      }
      await api.patch(`/integrations/${provider.key}`, { config });
      onSaved();
    }
    catch (e) { setError(e instanceof ApiError ? e.message : "Failed to save"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Configure ${provider.name}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => setConfirming(true)} disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
      {isResend && (
        <>
          <div className="field">
            <label>Sender email (From address)</label>
            <input type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="deals@mail.yourdomain.com" />
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Checked against your verified Resend domains when you save.</p>
          </div>
          <div className="field">
            <label>Sender name (optional)</label>
            <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Carsa Minerals" />
          </div>
        </>
      )}
      <div className="field">
        <label>Automatic synchronization</label>
        <Select value={schedule} onChange={setSchedule} ariaLabel="Sync schedule"
          options={[
            { value: "manual", label: "Manual only" },
            ...(provider.syncable ? [{ value: "hourly", label: "Every hour" }, { value: "daily", label: "Daily" }] : []),
          ]} />
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Automatic sync re-validates the connection on schedule and records failures on this page and in the activity log.</p>
      </div>
      <div className="field"><label>Notes</label><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes about this connection" /></div>
      {error && <div className="error-text">{error}</div>}
      {confirming && <ConfirmChanges busy={busy} onCancel={() => setConfirming(false)} onConfirm={save} />}
    </Modal>
  );
}
