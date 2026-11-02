import { useEffect, useMemo, useState } from "react";
import { Modal, Banner } from "./ui";
import { Select } from "./Select";
import { api, ApiError } from "../api/client";
import { useConnectedAccounts, usableAccounts } from "../lib/connectedAccounts";
import { MailBody, signatureCidResolver } from "./mail/MailBody";
import type { Signature } from "../lib/mail";

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
  // The selection behind this window can clear once the deal reloads after sending.
  const [count] = useState(buyerIds.length);
  const [subject, setSubject] = useState(`New deal: ${dealName}`);
  const [body, setBody] = useState(
    `Hi {{buyer}},\n\nWe have a new opportunity in {{county}} I think {{company}} would be interested in: {{deal}}.\n\nAsking {{askPrice}}. Reply here and I'll send full details.\n\nBest,\n{{sender}}`,
  );
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ sent: number; queued?: number; threadId?: string; via?: string; skipped: { buyer: string; reason: string }[] } | null>(null);
  // Send from the member's own Outlook (each buyer gets an individual email
  // from their mailbox, with their signature) — or the app's Resend sender.
  const { data: acctData } = useConnectedAccounts();
  const mailboxes = useMemo(() => usableAccounts(acctData?.accounts, "outlook"), [acctData]);
  const [from, setFrom] = useState<string>("");
  useEffect(() => { if (!from && mailboxes.length) setFrom(mailboxes[0].id); }, [mailboxes, from]);
  const viaOutlook = from !== "" && from !== "resend";
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [sigId, setSigId] = useState("");
  useEffect(() => {
    if (!viaOutlook) { setSignatures([]); return; }
    api.get<Signature[]>(`/mail/${from}/signatures`).then((l) => { setSignatures(l); setSigId(l.find((x) => x.defaultNew)?.id ?? ""); }).catch(() => setSignatures([]));
  }, [from, viaOutlook]);
  const signature = signatures.find((x) => x.id === sigId) ?? null;
  const resolver = useMemo(() => (signature ? signatureCidResolver(signature.id) : undefined), [signature]);
  const [progress, setProgress] = useState<{ queued: number; sent: number; failed: number; failures: { toRecipients: { address: string }[]; sendError: string | null }[] } | null>(null);
  // Follow a queued Outlook batch until it's done.
  useEffect(() => {
    if (!result?.threadId) return;
    let live = true;
    const tick = () => api.get<typeof progress>(`/mail/outbox?threadId=${encodeURIComponent(result.threadId!)}`).then((p) => { if (live && p) { setProgress(p); if (p.queued > 0) setTimeout(tick, 3000); else onSent(); } }).catch(() => {});
    tick();
    return () => { live = false; };
  }, [result?.threadId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const r = await api.post<{ sent: number; queued?: number; threadId?: string; via?: string; skipped: { buyer: string; reason: string }[] }>(`/deals/${dealId}/email`, {
        buyerIds, subject, body, ...(viaOutlook ? { accountId: from, signatureId: sigId || null } : {}),
      });
      setResult(r);
      if (r.sent > 0) onSent();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed to send");
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title={`Email deal to ${count} buyer${count === 1 ? "" : "s"}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose}>{result ? "Close" : "Cancel"}</button>
          {!result && <button className="primary" onClick={send} disabled={busy}>{busy ? "Sending…" : `Send to ${count}`}</button>}
        </>
      }
    >
      {result ? (
        <>
          {result.via === "outlook" ? (
            <Banner kind="info">
              {progress
                ? progress.queued > 0
                  ? `Sending from Outlook… ${progress.sent} of ${progress.sent + progress.queued + progress.failed} sent. Outlook allows about 30 emails a minute, so this keeps going if you close this window.`
                  : `Sent ${progress.sent} email${progress.sent === 1 ? "" : "s"} from Outlook — each is in your Sent Items and logged on the deal.${progress.failed ? ` ${progress.failed} couldn't be sent.` : ""}`
                : `Queued ${result.queued ?? 0} email${result.queued === 1 ? "" : "s"} to send from Outlook…`}
            </Banner>
          ) : <Banner kind="info">Sent to {result.sent} buyer(s).</Banner>}
          {progress && progress.failures.length > 0 && (
            <div className="email-skipped">
              <strong>Not sent ({progress.failures.length}):</strong>
              <ul>{progress.failures.map((f, i) => <li key={i}>{f.toRecipients.map((t) => t.address).join(", ")} · {f.sendError ?? "failed"}</li>)}</ul>
            </div>
          )}
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
          {mailboxes.length > 0 && (
            <div className="field">
              <label>Send from</label>
              <Select value={from} onChange={setFrom} ariaLabel="Send from"
                options={[...mailboxes.map((m) => ({ value: m.id, label: `${m.email} (Outlook)` })), { value: "resend", label: "Mineral Hub email (Resend)" }]} />
              <div className="dd-hint">{viaOutlook ? "Each buyer gets an individual email from your mailbox, with your signature; it appears in your Outlook Sent Items and replies come back to you." : "Sent by the app's email service with your address as reply-to."}</div>
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
          {viaOutlook && (
            <div className="field">
              <label>Signature</label>
              <Select value={sigId} onChange={setSigId} ariaLabel="Signature" width={260}
                options={[{ value: "", label: "No signature" }, ...signatures.map((x) => ({ value: x.id, label: x.name }))]} />
              {signature && <div className="mc-sig-preview"><MailBody html={signature.html} resolveCid={resolver} compact /></div>}
            </div>
          )}
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
