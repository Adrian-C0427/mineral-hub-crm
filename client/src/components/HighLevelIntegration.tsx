import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { Modal, Spinner, ConfirmChanges, ConfirmDialog } from "./ui";
import { Tag, ProgressBar, FormSection, Segmented, StatStrip } from "./kit";
import { Select } from "./Select";
import { fmtDateTime } from "../lib/format";
import {
  HL_POLL_MS, HL_SCOPES, HL_SYNC_EVERY, RESPONSE_WINDOW_CHOICES, previewText, importProgress, importingText, totalsText,
  lastRunText, missingScopesText, tagRefreshText, crmTagsText, CRM_TAG_GROUPS, tagLine, setTagLine, togglePipeline, filterTags, previewCountsText, parsePrice,
  configureFields, adoptStored, configureChanges,
  type HighLevelStatus, type HighLevelScopeSettings, type LineCounts, type SmsScope, type TagLine, type ConfigureFields,
} from "../lib/highlevel";

// HighLevel (LeadConnector) on Settings → Integrations: the card's status
// lines + import button state, the connect modal with setup steps, and the
// Configure modal (Minerals filter, texting price, response window). The
// sync itself runs on the server (services/highlevel/); this only shows it.

/**
 * The card's live status. Re-read whenever the integration list reloads
 * (refreshKey) and every HL_POLL_MS while the first import or a tag re-read
 * runs; when it finishes, onSettled reloads the list so the card follows.
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

  const busyIn = (s: HighLevelStatus | null) => s?.phase === "importing" || !!s?.tagRefresh?.running || !!s?.crmTags?.working;
  const working = enabled && busyIn(status);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => {
      void refresh().then((s) => { if (s && !busyIn(s)) settled.current(); });
    }, HL_POLL_MS);
    return () => clearInterval(t);
  }, [working, refresh]);

  async function startImport() {
    setStarting(true); setError(null);
    try { setStatus(await api.post<HighLevelStatus>("/integrations/highlevel/import", {})); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't start the import."); }
    finally { setStarting(false); }
  }

  async function rereadTags() {
    setStarting(true); setError(null);
    try { setStatus(await api.post<HighLevelStatus>("/integrations/highlevel/refresh-tags", {})); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't start re-reading tags."); }
    finally { setStarting(false); }
  }

  return { status, error, starting, startImport, rereadTags, refresh };
}

/** The HighLevel card's middle section: preview, import progress, or "up to date". */
export function HighLevelSummary({ s }: { s: HighLevelStatus }) {
  // In ERROR the card already shows lastError; don't repeat the failed run.
  const run = s.status === "ERROR" && s.lastRun && !s.lastRun.ok ? null : lastRunText(s.lastRun, s.phase);
  const missing = missingScopesText(s.missingScopes);
  const retag = s.phase === "live" ? tagRefreshText(s.tagRefresh, fmtDateTime) : null;
  const crm = s.phase === "live" ? crmTagsText(s.crmTags) : null;
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
          {retag && <p className={s.tagRefresh?.running ? "hl-line" : "integration-meta"}>{retag}</p>}
          {s.tagRefresh?.running && <ProgressBar value={importProgress(s.tagRefresh.done, s.tagRefresh.total)} />}
          {crm && <p className={crm.warn ? "hl-warn" : "integration-meta"}>{crm.text}</p>}
        </>
      )}
      {run && s.phase !== "preview" && <p className={s.lastRun?.ok ? "integration-meta" : "error-text integration-err"}>{run}</p>}
      {missing && s.phase !== "preview" && <p className="hl-warn">{missing}</p>}
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
  // The setup steps make the form taller than the dialog, so a failed check's
  // message would land below the fold — bring it into view.
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: "nearest" }); }, [error]);

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
        Mineral Hub reads your HighLevel texting history to build Reports → SMS performance. It only reads — nothing is
        sent, changed or deleted in HighLevel unless you later turn on HighLevel tags in Configure, which adds and removes
        only Mineral Hub's own tags — and the wording of your texts is never stored.
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
      {error && <div ref={errorRef} className="error-text" role="alert">{error}</div>}
    </Modal>
  );
}

const fmt = (v: number) => v.toLocaleString("en-US");
/** Tag rows rendered at once; a search narrows the rest. */
const TAG_ROWS = 250;
const LINE_OPTIONS: { value: TagLine; label: string }[] = [
  { value: "minerals", label: "Minerals" }, { value: "realEstate", label: "Real estate" }, { value: "neither", label: "Neither" },
];

/**
 * Configure HighLevel: the Minerals filter (each tag → Minerals / Real
 * estate / Neither, minerals pipelines, live split of texted people), the
 * price per text segment for cost figures, the response window and notes.
 * The filter is only sent when the admin changed it, so an untouched
 * suggestion keeps following new tags and pipelines. The other settings
 * start from the page's list, switch to the stored ones as soon as they load
 * (the list may be older), and only the ones the admin changed are sent.
 */
export function HighLevelConfigureModal({ name, config, onClose, onSaved }: {
  name: string;
  config: { responseWindowDays?: number; notes?: string; pricePerSegment?: number | null; crmTagsEnabled?: boolean };
  onClose: () => void;
  /** message: shown instead of the plain "Settings saved." (e.g. a tag re-read started). */
  onSaved: (message?: string) => void;
}) {
  const [settings, setSettings] = useState<HighLevelScopeSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SmsScope | null>(null);
  const [touched, setTouched] = useState(false);
  const [counts, setCounts] = useState<LineCounts | null>(null);
  const [counting, setCounting] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [form, setForm] = useState(() => { const f = configureFields(config); return { loaded: f, now: f }; });
  const { price, windowDays, notes, crmTags } = form.now;
  const set = (patch: Partial<ConfigureFields>) => setForm((f) => ({ ...f, now: { ...f.now, ...patch } }));
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<HighLevelScopeSettings>("/integrations/highlevel/scope")
      .then((s) => { setSettings(s); setDraft(s.scope); setCounts(s.counts); setForm((f) => adoptStored(f, configureFields(s))); })
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : "Couldn't load your HighLevel tags and pipelines."));
  }, []);

  // Live preview: recount (debounced) after each change; only the latest answer counts.
  const seq = useRef(0);
  useEffect(() => {
    if (!draft || !touched) return;
    const mine = ++seq.current;
    setCounting(true);
    const t = setTimeout(() => {
      api.post<LineCounts>("/integrations/highlevel/scope-preview", { scope: draft })
        .then((c) => { if (mine === seq.current) { setCounts(c); setPreviewError(null); } })
        .catch((e) => { if (mine === seq.current) setPreviewError(e instanceof ApiError ? e.message : "Couldn't count with this filter."); })
        .finally(() => { if (mine === seq.current) setCounting(false); });
    }, 350);
    return () => clearTimeout(t);
  }, [draft, touched]);

  const edit = (next: SmsScope) => { setDraft(next); setTouched(true); };

  const crmTagsChanged = crmTags !== form.loaded.crmTags;
  const dirty = touched || Object.keys(configureChanges(form.loaded, form.now)).length > 0;

  function requestSave() {
    if (parsePrice(price) === "invalid") { setError("Enter the price per text segment in dollars, like 0.0091 — or leave it empty."); return; }
    setError(null);
    setConfirming(true);
  }

  async function save() {
    setConfirming(false); setBusy(true); setError(null);
    try {
      const r = await api.patch<{ tagRefreshStarted?: boolean }>("/integrations/highlevel", {
        config: { ...configureChanges(form.loaded, form.now), ...(touched && draft ? { scope: draft } : {}) },
      });
      onSaved(r?.tagRefreshStarted
        ? "Settings saved. A tag in your filter isn't on any texted contact yet, so every contact's tags are being re-read from HighLevel — the card shows the progress."
        : crmTagsChanged && crmTags
          ? "Settings saved. Mineral Hub is now tagging your texted contacts in HighLevel — the card shows the progress."
          : undefined);
    } catch (e) { setError(e instanceof ApiError ? e.message : "Failed to save"); }
    finally { setBusy(false); }
  }

  const c = counts;
  return (
    <Modal title={`Configure ${name}`} wide onClose={onClose} dirty={dirty}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={requestSave} disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
      <FormSection title="Minerals filter">
        <p className="hl-help">
          Your HighLevel account also texts for real estate. Reports → SMS performance counts only minerals texting unless you
          switch it to all texting there. Mark which tags and pipelines are minerals — anyone who matches neither list shows as
          “not classified”.
        </p>
        {loadError && <p className="error-text">{loadError}</p>}
        {!settings && !loadError && <Spinner label="Loading your HighLevel tags and pipelines…" />}
        {settings && draft && c && (
          <MineralsFilter settings={settings} draft={draft} counts={c} counting={counting} previewError={previewError}
            suggested={!settings.saved && !touched} onChange={edit} />
        )}
      </FormSection>

      <FormSection title="Texting cost">
        <div className="field">
          <label htmlFor="hl-price">Price per text segment ($)</label>
          <input id="hl-price" className="hl-price" inputMode="decimal" value={price} onChange={(e) => set({ price: e.target.value })} placeholder="0.0091" autoComplete="off" />
          <p className="hl-help">
            What you pay for each SMS segment you send. A text of up to 160 plain characters is one segment (70 if it has an
            emoji); longer texts are split into several. Replies you receive aren't counted. Leave it empty to hide cost in Reports.
          </p>
        </div>
      </FormSection>

      <FormSection title="Tags in HighLevel">
        <label className="hl-check">
          <input type="checkbox" checked={crmTags} onChange={(e) => set({ crmTags: e.target.checked })} />
          <span>Write SMS and Acquisition tags to your HighLevel contacts</span>
        </label>
        <p className="hl-help">
          Mineral Hub works these out from its own record of every text and from your minerals pipelines — the same numbers as
          Reports — and keeps them up to date {HL_SYNC_EVERY}. It only ever adds or removes these tags; your other tags are never
          touched. Handy for smart lists and automations in HighLevel. HighLevel shows tag names in lower case.
        </p>
        <div className="hl-crm-tags">
          {CRM_TAG_GROUPS.map((g) => (
            <div key={g.label}>
              <div className="hl-crm-tags-label">{g.label}</div>
              <div className="hl-scopes">{g.tags.map((t) => <Tag key={t}>{t}</Tag>)}</div>
            </div>
          ))}
        </div>
        <p className="hl-help">
          Needs one more permission on your key: in XLeads, open <b>Settings → Private Integrations</b>, edit <b>Mineral Hub CRM</b>,
          and add <code>contacts.write</code>. The key itself stays the same.
        </p>
        <button type="button" className="link-btn set-btn-danger-text hl-remove-tags" onClick={() => setRemoving(true)}>Remove all Mineral Hub tags from HighLevel…</button>
      </FormSection>

      <FormSection title="Replies and syncing">
        <div className="field">
          <label>Response window</label>
          <Select value={windowDays} onChange={(v) => set({ windowDays: v })} ariaLabel="Response window"
            options={RESPONSE_WINDOW_CHOICES.map((d) => ({ value: String(d), label: `${d} days` }))} />
          <p className="hl-help">
            A reply counts as a response when it arrives within this many days of the most recent text; later replies show as late replies. Changing it recounts every contact in Reports.
          </p>
        </div>
        <div className="field">
          <label>Automatic synchronization</label>
          <p className="hl-help" style={{ margin: 0 }}>
            Nothing to set — new texts, delivery updates and pipeline stages are checked automatically {HL_SYNC_EVERY}. Use Sync now on the card to check right away.
          </p>
        </div>
        <div className="field"><label>Notes</label><textarea rows={3} value={notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Internal notes about this connection" /></div>
      </FormSection>
      {error && <div className="error-text" role="alert">{error}</div>}
      {confirming && <ConfirmChanges busy={busy} onCancel={() => setConfirming(false)} onConfirm={save} />}
      {removing && (
        <ConfirmDialog
          title="Remove Mineral Hub's tags from HighLevel?"
          message="This turns tag writing off and takes every SMS and Acquisition tag Mineral Hub added off your HighLevel contacts. Your other tags stay. Reports aren't affected. You can turn tags back on any time."
          confirmLabel="Remove the tags" danger busy={removeBusy}
          onCancel={() => setRemoving(false)}
          onConfirm={async () => {
            setRemoveBusy(true);
            try {
              await api.post("/integrations/highlevel/crm-tags/remove", {});
              setRemoving(false);
              onSaved("Removing Mineral Hub's tags from HighLevel — the card shows the progress.");
            } catch (e) { setRemoving(false); setError(e instanceof ApiError ? e.message : "Couldn't start removing the tags."); }
            finally { setRemoveBusy(false); }
          }}
        />
      )}
    </Modal>
  );
}

/** The Minerals filter's body: live split, pipeline checkboxes, the searchable tag list. */
export function MineralsFilter({ settings, draft, counts: c, counting, previewError, suggested, onChange }: {
  settings: HighLevelScopeSettings; draft: SmsScope; counts: LineCounts; counting: boolean; previewError: string | null;
  /** Showing the untouched suggestion (nothing saved yet). */
  suggested: boolean;
  onChange: (next: SmsScope) => void;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<TagLine | "all">("all");
  const shown = useMemo(() => filterTags(settings.tags, draft, query, view), [settings, draft, query, view]);
  const viewCounts = useMemo(() => {
    const n = { all: 0, minerals: 0, realEstate: 0, neither: 0 };
    for (const t of settings.tags) { n.all++; n[tagLine(draft, t.name)]++; }
    return n;
  }, [settings, draft]);
  return (
    <>
      {suggested && (
        <p className="hl-note">
          <Tag tone="warn">Suggested</Tag>
          <span>Filled in from your tag and pipeline names (county and “mineral” tags, pipelines named “Minerals”). Nothing is set as real estate yet — review it, then save.</span>
        </p>
      )}
      <div className="hl-preview" aria-live="polite" title={previewCountsText(c)}>
        <StatStrip min={140} cells={[
          { label: "Minerals", value: fmt(c.minerals), tone: "accent", sub: "texted people" },
          { label: "Real estate", value: fmt(c.realEstate), sub: "texted people" },
          { label: "Not classified", value: fmt(c.unclassified), tone: c.unclassified ? "warn" : "default", sub: "texted people" },
        ]} />
        <p className="integration-meta">
          {counting ? "Counting…" : `${fmt(c.texted)} texted ${c.texted === 1 ? "person" : "people"} in all. These numbers update as you change the filter.`}
        </p>
        {previewError && <p className="error-text">{previewError}</p>}
      </div>

      <div className="field">
        <label>Minerals pipelines</label>
        {settings.pipelines.length ? (
          <div className="hl-pipes">
            {settings.pipelines.map((p) => (
              <label key={p.id} className="hl-check">
                <input type="checkbox" checked={draft.mineralPipelineIds.includes(p.id)} onChange={(e) => onChange(togglePipeline(draft, p.id, e.target.checked))} />
                <span className="hl-check-name">{p.name}</span>
                <span className="hl-count">{fmt(p.texted)} texted</span>
              </label>
            ))}
          </div>
        ) : <p className="integration-meta">No pipelines found in HighLevel yet.</p>}
        <p className="hl-help">Anyone with an opportunity in a ticked pipeline counts as minerals, whatever their tags.</p>
      </div>

      <div className="field">
        <label htmlFor="hl-tag-search">Tags</label>
        <div className="hl-tag-tools">
          <input id="hl-tag-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${fmt(settings.tags.length)} tags`} autoComplete="off" />
          <Segmented ariaLabel="Show tags" value={view} onChange={setView} options={[
            { value: "all", label: "All", count: viewCounts.all },
            { value: "minerals", label: "Minerals", count: viewCounts.minerals },
            { value: "realEstate", label: "Real estate", count: viewCounts.realEstate },
            { value: "neither", label: "Neither", count: viewCounts.neither },
          ]} />
        </div>
        <div className="hl-tag-list">
          {shown.slice(0, TAG_ROWS).map((t) => (
            <div key={t.name} className="hl-tag-row">
              <span className="hl-tag-name" title={t.name}>{t.name}</span>
              <span className="hl-count">{fmt(t.texted)} texted</span>
              <Segmented ariaLabel={`“${t.name}” is`} value={tagLine(draft, t.name)} onChange={(v) => onChange(setTagLine(draft, t.name, v))} options={LINE_OPTIONS} />
            </div>
          ))}
          {!shown.length && <p className="hl-empty">{settings.tags.length ? "No tags match." : "No tags found in HighLevel yet."}</p>}
        </div>
        {shown.length > TAG_ROWS && <p className="integration-meta">Showing {fmt(TAG_ROWS)} of {fmt(shown.length)} — search to find the rest.</p>}
        <p className="hl-help">
          Someone with both a minerals tag and a real-estate tag counts as minerals. Capital letters don't matter.
          {settings.saved && (
            <> <button type="button" className="link-btn hl-link" onClick={() => onChange(settings.suggested)}>Start over from the suggestion</button></>
          )}
        </p>
      </div>
    </>
  );
}
