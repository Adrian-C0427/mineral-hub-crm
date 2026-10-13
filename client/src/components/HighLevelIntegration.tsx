import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { Modal } from "./ui";
import { Tag, ProgressBar } from "./kit";
import { fmtDateTime } from "../lib/format";
import {
  HL_POLL_MS, HL_SCOPES, HL_SYNC_EVERY, previewText, importProgress, importingText, totalsText, lastRunText,
  type HighLevelStatus,
} from "../lib/highlevel";

// HighLevel (LeadConnector) on Settings → Integrations: the card's status
// lines + import button state, and the connect modal with setup steps. The
// sync itself runs on the server (services/highlevel/); this only shows it.

/**
 * The card's live status. Re-read whenever the integration list reloads
 * (refreshKey) and every HL_POLL_MS while the first import runs; when the
 * import finishes, onSettled reloads the list so the card's state follows.
 */
export function useHighLevelStatus(enabled: boolean, refreshKey: string, onSettled: () => void) {
  const [status, setStatus] = useState<HighLevelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  const refresh = useCallback(async () => {
    try {
      const s = await api.get<HighLevelStatus>("/integrations/highlevel/status");
      setStatus(s);
      setError(null);
      return s;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load the HighLevel status.");
      return null;
    }
  }, []);

  useEffect(() => { if (enabled) void refresh(); }, [enabled, refreshKey, refresh]);

  const importing = enabled && status?.phase === "importing";
  useEffect(() => {
    if (!importing) return;
    const t = setInterval(() => {
      void refresh().then((s) => { if (s && s.phase !== "importing") settled.current(); });
    }, HL_POLL_MS);
    return () => clearInterval(t);
  }, [importing, refresh]);

  async function startImport() {
    setStarting(true); setError(null);
    try { setStatus(await api.post<HighLevelStatus>("/integrations/highlevel/import", {})); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't start the import."); }
    finally { setStarting(false); }
  }

  return { status, error, starting, startImport, refresh };
}

/** The HighLevel card's middle section: preview, import progress, or "up to date". */
export function HighLevelSummary({ s }: { s: HighLevelStatus }) {
  // In ERROR the card already shows lastError; don't repeat the failed run.
  const run = s.status === "ERROR" && s.lastRun && !s.lastRun.ok ? null : lastRunText(s.lastRun, s.phase);
  return (
    <div className="hl-summary">
      {s.locationName && <p className="integration-meta">Location: <code>{s.locationName}</code></p>}
      {s.phase === "preview" && s.preview && (
        <p className="hl-line">{previewText(s.preview.texts, s.storageEstimateMb)}</p>
      )}
      {s.phase === "importing" && (
        <>
          <p className="hl-line">{importingText(s)}</p>
          <ProgressBar value={importProgress(s.imported, s.preview?.texts)} />
          <p className="integration-meta">Runs in the background — you can leave this page. Reports are complete once the import finishes.</p>
        </>
      )}
      {s.phase === "live" && (
        <>
          <p className="hl-line">
            <Tag tone={s.status === "ERROR" ? "warn" : "success"} dot>{s.status === "ERROR" ? "Needs attention" : "Up to date"}</Tag>
            <span>{s.status === "ERROR" ? "last good check" : "checked"} {fmtDateTime(s.lastSyncAt)}</span>
          </p>
          <p className="integration-meta">{totalsText(s)} · checked automatically {HL_SYNC_EVERY}.</p>
        </>
      )}
      {run && s.phase !== "preview" && <p className={s.lastRun?.ok ? "integration-meta" : "error-text integration-err"}>{run}</p>}
    </div>
  );
}

/** Connect / replace the key: plain-English setup steps, key + Location ID. */
export function HighLevelConnectModal({ name, setupUrl, locationId, onClose, onConnected }: {
  name: string; setupUrl?: string; locationId?: string; onClose: () => void; onConnected: (msg: string) => void;
}) {
  const [secret, setSecret] = useState("");
  const [location, setLocation] = useState(locationId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    if (!secret.trim()) { setError("Paste the Private Integration key from HighLevel."); return; }
    if (!location.trim()) { setError("Paste your HighLevel Location ID."); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ message?: string }>("/integrations/highlevel/connect", { secret: secret.trim(), config: { locationId: location.trim() } });
      onConnected(r.message ?? `${name} connected.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Connection failed");
    } finally { setBusy(false); }
  }

  return (
    <Modal title={locationId ? `Replace the ${name} key` : `Connect ${name}`} onClose={onClose} dirty={!!secret}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={connect} disabled={busy}>{busy ? "Checking with HighLevel…" : "Check & connect"}</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>
        Mineral Hub reads your HighLevel texting history to build Reports → SMS performance. It is read-only: nothing is
        ever sent, changed or deleted in HighLevel, and the wording of your texts is never stored.
      </p>
      <ol className="hl-steps">
        <li>In HighLevel (your XLeads account works), open <b>Settings → Private Integrations</b> and click <b>Create new integration</b>.</li>
        <li>Name it <b>Mineral Hub CRM</b>.</li>
        <li>
          Tick only these permissions — all of them are read-only:
          <div className="hl-scopes">{HL_SCOPES.map((s) => <Tag key={s}>{s}</Tag>)}</div>
        </li>
        <li>Create it, copy the key HighLevel shows you (it starts with “pit-”), and paste it below.</li>
        <li>Find your <b>Location ID</b> in <b>Settings → Business Profile</b>, or in the browser’s address bar — it’s the part after <code>/location/</code>.</li>
      </ol>
      <div className="field">
        <label>Private Integration key</label>
        <input className="mono-input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="pit-…" autoFocus autoComplete="off" />
      </div>
      <div className="field">
        <label>Location ID</label>
        <input className="mono-input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. ve9EPM428h8vShlRW1KT" autoComplete="off" />
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>You can paste the whole HighLevel address — Mineral Hub picks out the ID.</p>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        The key is checked with HighLevel before anything is saved, then stored encrypted. Only its last 4 characters are ever shown again.
        Nothing is imported until you press <b>Start import</b>.
        {setupUrl && <> <a href={setupUrl} target="_blank" rel="noreferrer">HighLevel’s guide to Private Integrations ↗</a></>}
      </p>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
