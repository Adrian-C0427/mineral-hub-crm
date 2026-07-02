import { useEffect, useMemo, useState } from "react";
import {
  Mail, Bot, Map as MapIcon, HardDrive, Calendar, Calculator, Megaphone, ShieldCheck, Code2,
  type LucideIcon,
} from "lucide-react";
import { api, ApiError } from "../api/client";
import { Spinner, Banner, Modal, ConfirmChanges } from "../components/ui";
import { fmtDate } from "../lib/format";

type Auth = "oauth" | "apikey" | "smtp" | "builtin";

interface Provider { key: string; name: string; description: string; auth: Auth }
interface Category { category: string; icon: LucideIcon; items: Provider[] }

// Catalog lives here (client registry) — add a provider without any schema or
// API change; the backend just tracks per-org status/config for each key.
const REGISTRY: Category[] = [
  { category: "Email & Communication", icon: Mail, items: [
    { key: "outlook", name: "Microsoft Outlook / 365", auth: "oauth", description: "Send deal emails and sync replies from your Microsoft 365 mailbox." },
    { key: "gmail", name: "Gmail / Google Workspace", auth: "oauth", description: "Send and receive deal emails through Google Workspace." },
    { key: "smtp", name: "SMTP / IMAP", auth: "smtp", description: "Generic mail server for outbound deal emails (configured via server env)." },
    { key: "teams", name: "Microsoft Teams", auth: "oauth", description: "Post deal notifications and alerts to Teams channels." },
    { key: "slack", name: "Slack", auth: "oauth", description: "Push deal and buyer activity notifications to Slack." },
  ] },
  { category: "AI & Automation", icon: Bot, items: [
    { key: "claude", name: "Claude", auth: "apikey", description: "Draft outreach, summarize deals, and assist research with Anthropic Claude." },
    { key: "openai", name: "ChatGPT / OpenAI", auth: "apikey", description: "AI drafting and analysis via OpenAI models." },
    { key: "gemini", name: "Google Gemini", auth: "apikey", description: "AI assistance via Google Gemini." },
    { key: "perplexity", name: "Perplexity", auth: "apikey", description: "Research and answer generation via Perplexity." },
  ] },
  { category: "GIS & Mapping", icon: MapIcon, items: [
    { key: "rrc", name: "Texas Railroad Commission (RRC)", auth: "apikey", description: "Ingest RRC well, permit, and production datasets." },
    { key: "qgis", name: "QGIS / QGIS Server", auth: "apikey", description: "Serve and consume spatial layers via QGIS Server." },
    { key: "arcgis", name: "ArcGIS", auth: "oauth", description: "Connect Esri ArcGIS feature and map services." },
    { key: "mapbox", name: "Mapbox", auth: "apikey", description: "Alternate basemaps and geocoding via Mapbox." },
    { key: "googlemaps", name: "Google Maps", auth: "apikey", description: "Geocoding and mapping via Google Maps Platform." },
  ] },
  { category: "Storage & Documents", icon: HardDrive, items: [
    { key: "googledrive", name: "Google Drive", auth: "oauth", description: "Store and attach deal documents from Google Drive." },
    { key: "onedrive", name: "Microsoft OneDrive", auth: "oauth", description: "Store and attach documents from OneDrive." },
    { key: "dropbox", name: "Dropbox", auth: "oauth", description: "Store and attach documents from Dropbox." },
    { key: "box", name: "Box", auth: "oauth", description: "Store and attach documents from Box." },
  ] },
  { category: "Productivity", icon: Calendar, items: [
    { key: "googlecalendar", name: "Google Calendar", auth: "oauth", description: "Sync closing dates and follow-ups to Google Calendar." },
    { key: "outlookcalendar", name: "Outlook Calendar", auth: "oauth", description: "Sync deadlines and follow-ups to Outlook Calendar." },
    { key: "calendly", name: "Calendly", auth: "apikey", description: "Book buyer calls and sync scheduled meetings." },
  ] },
  { category: "Accounting & Finance", icon: Calculator, items: [
    { key: "quickbooks", name: "QuickBooks Online", auth: "oauth", description: "Sync expenses and revenue with QuickBooks." },
    { key: "xero", name: "Xero", auth: "oauth", description: "Sync expenses and revenue with Xero." },
  ] },
  { category: "CRM & Marketing", icon: Megaphone, items: [
    { key: "hubspot", name: "HubSpot", auth: "oauth", description: "Sync buyers and activity with HubSpot." },
    { key: "salesforce", name: "Salesforce", auth: "oauth", description: "Sync buyers and deals with Salesforce." },
    { key: "mailchimp", name: "Mailchimp", auth: "apikey", description: "Sync buyer lists for email campaigns." },
  ] },
  { category: "Authentication", icon: ShieldCheck, items: [
    { key: "entra", name: "Microsoft Entra ID (Azure AD)", auth: "oauth", description: "Single sign-on with Microsoft Entra ID." },
    { key: "googlesignin", name: "Google Sign-In", auth: "oauth", description: "Single sign-on with Google." },
    { key: "okta", name: "Okta", auth: "oauth", description: "Single sign-on and provisioning with Okta." },
  ] },
  { category: "Developer & API", icon: Code2, items: [
    { key: "apikeys", name: "API Keys", auth: "apikey", description: "Issue keys for programmatic access to your Mineral Hub data." },
    { key: "webhooks", name: "Webhooks", auth: "apikey", description: "Send events to your endpoints when deals or buyers change." },
    { key: "customapi", name: "Custom API Integration", auth: "apikey", description: "Connect a bespoke internal or third-party service." },
  ] },
];

const AUTH_LABEL: Record<Auth, string> = { oauth: "OAuth", apikey: "API key", smtp: "SMTP", builtin: "Built-in" };

interface Record_ { provider: string; status: string; config: Record<string, unknown> | null; connectedAt: string | null; lastSyncAt: string | null; lastError: string | null }

export function Integrations() {
  const [state, setState] = useState<Map<string, Record_>>(new Map());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [configure, setConfigure] = useState<Provider | null>(null);

  function load() {
    api.get<Record_[]>("/integrations")
      .then((rows) => setState(new Map(rows.map((r) => [r.provider, r]))))
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Failed to load integrations"))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  const connectedCount = useMemo(() => [...state.values()].filter((r) => r.status === "CONNECTED").length, [state]);

  async function connect(p: Provider) {
    try { await api.post(`/integrations/${p.key}/connect`, {}); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Failed"); }
  }
  async function disconnect(p: Provider) {
    if (!confirm(`Disconnect ${p.name}?`)) return;
    try { await api.post(`/integrations/${p.key}/disconnect`, {}); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Failed"); }
  }

  if (loading) return <Spinner label="Loading integrations…" />;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Integrations</h1>
        <span className="muted">{connectedCount} connected</span>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>
        Connect and manage third-party services. Connecting tracks the integration in your workspace;
        secure per-provider credential/OAuth setup is rolled out provider by provider.
      </p>
      {err && <Banner kind="error">{err}</Banner>}

      {REGISTRY.map((cat) => (
        <div key={cat.category} className="panel">
          <div className="section-head"><h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}><cat.icon size={18} /> {cat.category}</h3></div>
          <div className="integration-grid">
            {cat.items.map((p) => {
              const rec = state.get(p.key);
              const connected = rec?.status === "CONNECTED";
              return (
                <div key={p.key} className="integration-card">
                  <div className="integration-head">
                    <span className="integration-logo">{p.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase()}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="integration-name">{p.name}</div>
                      <span className="chip-mini">{AUTH_LABEL[p.auth]}</span>
                      <span className={`badge ${connected ? "resp-offer" : "resp-pending"}`} style={{ marginLeft: 6 }}>{connected ? "Connected" : "Not connected"}</span>
                    </div>
                  </div>
                  <p className="integration-desc">{p.description}</p>
                  {connected && rec?.lastSyncAt && <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>Last sync: {fmtDate(rec.lastSyncAt)}</p>}
                  {connected && rec?.lastError && <p className="error-text" style={{ fontSize: 12 }}>{rec.lastError}</p>}
                  <div className="row" style={{ gap: 6 }}>
                    {connected ? (
                      <>
                        <button className="small" onClick={() => setConfigure(p)}>Configure</button>
                        <button className="small danger" onClick={() => disconnect(p)}>Disconnect</button>
                      </>
                    ) : (
                      <button className="small primary" onClick={() => connect(p)}>Connect</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {configure && (
        <ConfigureModal
          provider={configure}
          record={state.get(configure.key) ?? null}
          onClose={() => setConfigure(null)}
          onSaved={() => { setConfigure(null); load(); }}
        />
      )}
    </div>
  );
}

function ConfigureModal({ provider, record, onClose, onSaved }: { provider: Provider; record: Record_ | null; onClose: () => void; onSaved: () => void }) {
  const cfg = (record?.config ?? {}) as { schedule?: string; notes?: string };
  const [schedule, setSchedule] = useState(cfg.schedule ?? "manual");
  const [notes, setNotes] = useState(cfg.notes ?? "");
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function save() {
    setConfirming(false);
    setBusy(true);
    try { await api.patch(`/integrations/${provider.key}`, { config: { schedule, notes } }); onSaved(); }
    finally { setBusy(false); }
  }
  async function test() {
    const r = await api.post<{ ok: boolean; message: string }>(`/integrations/${provider.key}/test`, {});
    setTestMsg(r.message);
  }

  return (
    <Modal title={`Configure ${provider.name}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => setConfirming(true)} disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
      <div className="field">
        <label>Synchronization</label>
        <select value={schedule} onChange={(e) => setSchedule(e.target.value)}>
          <option value="manual">Manual only</option>
          <option value="hourly">Every hour</option>
          <option value="daily">Daily</option>
        </select>
      </div>
      <div className="field"><label>Notes</label><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes about this connection" /></div>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button className="small" onClick={test}>Test connection</button>
        {testMsg && <span className="muted" style={{ fontSize: 12 }}>{testMsg}</span>}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        {provider.auth === "smtp"
          ? "SMTP is configured on the API service via SMTP_* environment variables."
          : `Secure ${AUTH_LABEL[provider.auth]} connection for ${provider.name} is coming soon; this records the integration and its sync preferences in the meantime.`}
      </p>
      {confirming && <ConfirmChanges busy={busy} onCancel={() => setConfirming(false)} onConfirm={save} />}
    </Modal>
  );
}
