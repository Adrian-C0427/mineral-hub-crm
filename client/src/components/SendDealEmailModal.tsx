import { useEffect, useState } from "react";
import { Modal, Banner } from "./ui";
import { Select } from "./Select";
import { api, ApiError } from "../api/client";

interface Template { id: string; name: string; subject: string; body: string }

const TOKENS = ["{{buyer}}", "{{company}}", "{{deal}}", "{{county}}", "{{askPrice}}", "{{sender}}"];

export function SendDealEmailModal({
  dealId, buyerIds, dealName, onClose, onSent,
}: {
  dealId: string;
  buyerIds: string[];
  dealName: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [subject, setSubject] = useState(`New deal: ${dealName}`);
  const [body, setBody] = useState(
    `Hi {{buyer}},\n\nWe have a new opportunity in {{county}} I think {{company}} would be interested in: {{deal}}.\n\nAsking {{askPrice}}. Reply here and I'll send full details.\n\nBest,\n{{sender}}`,
  );
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ sent: number; skipped: { buyer: string; reason: string }[] } | null>(null);

  function loadTemplates() { api.get<Template[]>("/email-templates").then(setTemplates).catch(() => {}); }
  useEffect(() => { loadTemplates(); }, []);

  function applyTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (t) { setSubject(t.subject); setBody(t.body); }
  }

  async function saveTemplate() {
    if (!saveName.trim()) return;
    try { await api.post("/email-templates", { name: saveName.trim(), subject, body }); setSaveName(""); loadTemplates(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Failed to save template"); }
  }

  async function send() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ sent: number; skipped: { buyer: string; reason: string }[] }>(`/deals/${dealId}/email`, {
        buyerIds, subject, body,
      });
      setResult(r);
      if (r.sent > 0) onSent();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed to send");
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title={`Email deal to ${buyerIds.length} buyer(s)`}
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose}>{result ? "Close" : "Cancel"}</button>
          {!result && <button className="primary" onClick={send} disabled={busy}>{busy ? "Sending…" : `Send to ${buyerIds.length}`}</button>}
        </>
      }
    >
      {result ? (
        <>
          <Banner kind="info">Sent to {result.sent} buyer(s).</Banner>
          {result.skipped.length > 0 && (
            <div className="email-skipped">
              <strong>Skipped ({result.skipped.length}):</strong>
              <ul>{result.skipped.map((s, i) => <li key={i}>{s.buyer} · {s.reason}</li>)}</ul>
            </div>
          )}
        </>
      ) : (
        <>
          {templates.length > 0 && (
            <div className="field">
              <label>Start from a template</label>
              <Select value="" onChange={(v) => { if (v) applyTemplate(v); }} placeholder="Choose a template…" ariaLabel="Email template"
                options={templates.map((t) => ({ value: t.id, label: t.name }))} />
            </div>
          )}
          <div className="field"><label>Subject</label><input value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
          <div className="field">
            <label>Body</label>
            <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <p className="dd-hint email-tokens">
            Personalization tokens (filled per buyer): {TOKENS.join(" ")}
          </p>
          <div className="row email-save-tpl">
            <div className="field">
              <label>Save current as template</label>
              <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Template name" />
            </div>
            <button className="small" onClick={saveTemplate} disabled={!saveName.trim()}>Save template</button>
          </div>
          {err && <div className="error-text">{err}</div>}
        </>
      )}
    </Modal>
  );
}
