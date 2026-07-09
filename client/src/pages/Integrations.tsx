import { useEffect, useMemo, useState } from "react";
import {
  Mail, Bot, Map as MapIcon, HardDrive, Calendar, Calculator, Megaphone, ShieldCheck,
  Users, Cloud, Hash, type LucideIcon,
} from "lucide-react";
import { api, ApiError } from "../api/client";
import { Spinner, Banner, Modal, ConfirmChanges, ConfirmDialog } from "../components/ui";
import { Select } from "../components/Select";
import { fmtDate } from "../lib/format";

// The catalog lives on the SERVER (domain/integrationCatalog.ts) — the single
// source of truth for which providers exist, how they authenticate, and how far
// each implementation has gotten. This page renders what the API returns; only
// presentation (icons, ordering) is decided here.

type Auth = "apikey" | "webhook" | "oauth" | "env";
type Impl = "live" | "env" | "oauth" | "planned";

interface Provider {
  key: string; name: string; category: string; auth: Auth; implementation: Impl;
  description: string; secretLabel?: string; secretHint?: string; setupUrl?: string; syncable?: boolean;
  status: "CONNECTED" | "NOT_CONNECTED" | "ERROR";
  configured: boolean;
  config: { schedule?: string; notes?: string };
  secretMask: string | null;
  connectedAt: string | null; lastSyncAt: string | null; lastError: string | null;
}

const CATEGORY_ICON: Record<string, LucideIcon> = {
  "Email & Communication": Mail, "AI & Automation": Bot, "GIS & Mapping": MapIcon,
  "Storage & Documents": HardDrive, "Productivity": Calendar, "Accounting & Finance": Calculator,
  "CRM & Marketing": Megaphone, "Authentication": ShieldCheck,
};

const AUTH_LABEL: Record<Auth, string> = { oauth: "OAuth 2.0", apikey: "API key", webhook: "Webhook", env: "Built-in" };

// Official brand marks via Simple Icons (SVG, served from its CDN). Rendered on
// a light tile so each brand's own color reads cleanly on the dark UI. Providers
// without a brand slug fall back to a category glyph or initials. If a slug 404s
// (brand not in the set), the <img> onError also falls back — so wrong guesses
// degrade gracefully rather than breaking the card.
// Brands with an official mark in Simple Icons (served from its CDN, rendered in
// the brand's own color on a light tile). The Microsoft family + Slack are NOT
// here — Simple Icons removed them for trademark reasons — so they use a
// brand-matched glyph below instead (a clean, recognizable alternative).
const LOGO_SLUG: Record<string, string> = {
  gmail: "gmail", claude: "claude", openai: "openai", gemini: "googlegemini", perplexity: "perplexity",
  mapbox: "mapbox", googlemaps: "googlemaps", arcgis: "arcgis",
  googledrive: "googledrive", dropbox: "dropbox", box: "box",
  calendly: "calendly", googlecalendar: "googlecalendar",
  quickbooks: "quickbooks", xero: "xero", hubspot: "hubspot", mailchimp: "mailchimp",
  salesforce: "salesforce", googlesignin: "google", okta: "okta",
};
// Brand-matched glyphs for providers without a usable Simple Icons mark: the
// glyph echoes the provider's identity (Slack's mark IS a hash; Outlook = mail;
// Teams = people; OneDrive = cloud) and is tinted with the brand color.
const LOGO_ICON: Record<string, LucideIcon> = {
  smtp: Mail, storage: HardDrive,
  outlook: Mail, outlookcalendar: Calendar, onedrive: Cloud, entra: ShieldCheck,
  teams: Users, slack: Hash,
};
const BRAND_COLOR: Record<string, string> = {
  outlook: "#0078D4", outlookcalendar: "#0078D4", onedrive: "#0078D4", entra: "#0078D4",
  teams: "#6264A7", slack: "#611F69", storage: "#569A31",
};

function IntegrationLogo({ p }: { p: Provider }) {
  const [failed, setFailed] = useState(false);
  const slug = LOGO_SLUG[p.key];
  const initials = p.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  if (slug && !failed) {
    // Initials sit behind the brand mark so a blocked/offline CDN (corporate
    // proxy, ad-blocker, outage) degrades to a readable badge instead of a
    // blank tile — the image covers them once it loads.
    return (
      <span className="integration-logo brand" title={p.name}>
        <span className="integration-logo-fallback" aria-hidden="true">{initials}</span>
        <img src={`https://cdn.simpleicons.org/${slug}`} alt="" width={24} height={24} loading="lazy" onError={() => setFailed(true)} />
      </span>
    );
  }
  const Icon = LOGO_ICON[p.key];
  const color = BRAND_COLOR[p.key];
  return (
    <span className="integration-logo" title={p.name} style={color ? { color } : undefined}>
      {Icon ? <Icon size={20} /> : initials}
    </span>
  );
}

export function Integrations() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Provider | null>(null);
  const [configuring, setConfiguring] = useState<Provider | null>(null);
  const [disconnecting, setDisconnecting] = useState<Provider | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});

  function load() {
    api.get<Provider[]>("/integrations")
      .then(setProviders)
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Failed to load integrations"));
  }
  useEffect(load, []);

  // Surface the outcome of an OAuth round-trip (provider redirected back here).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("connected")) setFlash(`${q.get("connected")} connected.`);
    else if (q.get("error")) setErr(decodeURIComponent(q.get("error")!));
    if (q.get("connected") || q.get("error")) window.history.replaceState({}, "", window.location.pathname);
  }, []);

  // Begin an OAuth authorization: fetch the provider URL, then hand the browser off.
  async function startOAuth(p: Provider) {
    setBusyKey(p.key); setErr(null);
    try {
      const { url } = await api.get<{ url: string }>(`/integrations/${p.key}/oauth/start`);
      window.location.href = url;
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Could not start authorization"); setBusyKey(null); }
  }

  const categories = useMemo(() => {
    const m = new Map<string, Provider[]>();
    for (const p of providers ?? []) { const arr = m.get(p.category) ?? []; arr.push(p); m.set(p.category, arr); }
    return [...m.entries()];
  }, [providers]);

  const connectedCount = useMemo(() => (providers ?? []).filter((p) => p.status === "CONNECTED").length, [providers]);

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

  if (!providers) return <Spinner label="Loading integrations…" />;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Integrations</h1>
        <span className="muted">{connectedCount} connected</span>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>
        Every integration listed here passed a feasibility audit: it has an officially supported API and can run on our
        stack. Credentials are validated live when you connect and stored encrypted; they are never sent back to the browser.
      </p>
      {err && <Banner kind="error">{err}</Banner>}
      {flash && <Banner kind="info">{flash}</Banner>}

      {categories.map(([category, items]) => {
        const Icon = CATEGORY_ICON[category] ?? Bot;
        return (
          <div key={category} className="panel">
            <div className="section-head"><h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}><Icon size={18} /> {category}</h3></div>
            <div className="integration-grid">
              {items.map((p) => (
                <IntegrationCard
                  key={p.key}
                  p={p}
                  busy={busyKey === p.key}
                  result={testResult[p.key]}
                  onConnect={() => setConnecting(p)}
                  onOAuth={() => startOAuth(p)}
                  onDisconnect={() => setDisconnecting(p)}
                  onConfigure={() => setConfiguring(p)}
                  onTest={() => run(p, "test")}
                  onSync={() => run(p, "sync")}
                />
              ))}
            </div>
          </div>
        );
      })}

      {connecting && (
        <ConnectModal
          provider={connecting}
          onClose={() => setConnecting(null)}
          onConnected={(msg) => { setConnecting(null); setFlash(msg); load(); }}
        />
      )}
      {configuring && (
        <ConfigureModal
          provider={configuring}
          onClose={() => setConfiguring(null)}
          onSaved={() => { setConfiguring(null); setFlash("Settings saved."); load(); }}
        />
      )}
      {disconnecting && (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.name}?`}
          message={<p style={{ margin: 0 }}>The stored credential will be deleted. You can reconnect at any time with a new {disconnecting.secretLabel?.toLowerCase() ?? "credential"}.</p>}
          confirmLabel="Disconnect"
          danger
          busy={busyKey === disconnecting.key}
          onCancel={() => setDisconnecting(null)}
          onConfirm={() => disconnect(disconnecting)}
        />
      )}
    </div>
  );
}

function IntegrationCard({ p, busy, result, onConnect, onOAuth, onDisconnect, onConfigure, onTest, onSync }: {
  p: Provider; busy: boolean; result?: { ok: boolean; message: string };
  onConnect: () => void; onOAuth: () => void; onDisconnect: () => void; onConfigure: () => void; onTest: () => void; onSync: () => void;
}) {
  const connected = p.status === "CONNECTED";
  const errored = p.status === "ERROR";
  // An OAuth (or planned) provider that isn't configured on the server can't be
  // connected yet — it needs an app registration + server credentials.
  const needsSetup = p.implementation === "planned" || (p.implementation === "oauth" && !p.configured);
  return (
    <div className="integration-card">
      <div className="integration-head">
        <IntegrationLogo p={p} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="integration-name">{p.name}</div>
          <span className="chip-mini">{AUTH_LABEL[p.auth]}</span>
          <span
            className={`badge ${connected ? "resp-offer" : errored ? "resp-no" : "resp-pending"}`}
            style={{ marginLeft: 6 }}
            title={
              connected ? "Connected and validated — data can flow."
                : errored ? "Connected previously but the last check failed — reconnect or re-validate."
                : needsSetup ? "Needs a one-time server-side setup (OAuth app registration or API config) before it can be connected."
                : "Ready to connect — add a credential to start. Nothing is flowing yet."
            }
          >
            {connected ? "Connected" : errored ? "Error" : needsSetup ? "Setup required" : "Not connected"}
          </span>
        </div>
      </div>
      <p className="integration-desc">{p.description}</p>

      {connected && p.secretMask && <p className="muted" style={{ fontSize: 12, margin: "0 0 4px" }}>Credential: <code>{p.secretMask}</code></p>}
      {connected && p.lastSyncAt && <p className="muted" style={{ fontSize: 12, margin: "0 0 4px" }}>Last sync: {fmtDate(p.lastSyncAt)}{p.config.schedule && p.config.schedule !== "manual" ? ` · auto (${p.config.schedule})` : ""}</p>}
      {p.lastError && <p className="error-text" style={{ fontSize: 12 }}>{p.lastError}</p>}
      {result && <p className={result.ok ? "muted" : "error-text"} style={{ fontSize: 12 }}>{result.message}</p>}

      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {needsSetup ? (
          p.setupUrl && <a className="chip-mini" href={p.setupUrl} target="_blank" rel="noreferrer">Setup guide ↗</a>
        ) : p.implementation === "env" ? (
          <button className="small" disabled={busy} onClick={onTest}>{busy ? "Testing…" : "Test connection"}</button>
        ) : connected || errored ? (
          <>
            <button className="small" disabled={busy} onClick={onTest}>{busy ? "Working…" : "Test"}</button>
            {p.syncable && <button className="small" disabled={busy} onClick={onSync}>Sync now</button>}
            {p.implementation !== "oauth" && <button className="small" onClick={onConfigure}>Configure</button>}
            <button className="small" onClick={p.implementation === "oauth" ? onOAuth : onConnect}>
              {p.implementation === "oauth" ? "Reconnect" : "Replace key"}
            </button>
            <button className="small danger" onClick={onDisconnect}>Disconnect</button>
          </>
        ) : (
          <button className="small primary" disabled={busy} onClick={p.implementation === "oauth" ? onOAuth : onConnect}>
            {busy ? "Starting…" : p.implementation === "oauth" ? "Connect with OAuth" : "Connect"}
          </button>
        )}
      </div>
    </div>
  );
}

function ConnectModal({ provider, onClose, onConnected }: { provider: Provider; onClose: () => void; onConnected: (msg: string) => void }) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    if (!secret.trim()) { setError(`${provider.secretLabel ?? "A credential"} is required.`); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ message?: string }>(`/integrations/${provider.key}/connect`, { secret: secret.trim() });
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
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={provider.secretHint ?? ""} autoFocus autoComplete="off" />
      </div>
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
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setConfirming(false); setBusy(true); setError(null);
    try { await api.patch(`/integrations/${provider.key}`, { config: { schedule, notes } }); onSaved(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Failed to save"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Configure ${provider.name}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => setConfirming(true)} disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
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
