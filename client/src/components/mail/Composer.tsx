import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Bold, Italic, Link2, List, ListOrdered, Paperclip, Underline, X, FileText } from "lucide-react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { Banner, Modal, showToast } from "../ui";
import { Select } from "../Select";
import { RecordPicker, type RecordHit } from "../RecordPicker";
import { MailBody, signatureCidResolver } from "./MailBody";
import { uploadWithProgress, humanBytes, type RecordRef } from "../../lib/cloud";
import { fmtAddress, parseAddressList, type Address, type MailMessage, type Signature } from "../../lib/mail";
import type { ConnectedAccount } from "../../lib/connectedAccounts";

/**
 * Compose / reply / reply all / forward / finish a draft — sent from the
 * member's own Outlook mailbox. What they type is the message; the signature
 * is chosen (and previewed) separately and added once on send, above the
 * quoted thread for replies, exactly where Outlook puts it.
 */
export type ComposeMode = "new" | "reply" | "replyAll" | "forward" | "draft";

export interface ComposeInit {
  mode: ComposeMode;
  accountId?: string;
  source?: MailMessage | null;
  to?: Address[];
  cc?: Address[];
  subject?: string;
  /** Records the email is filed on (pre-selected from where it was started). */
  links?: RecordHit[];
}

type DocOption = { id: string; filename: string; sizeBytes: number; record: string };

function subjectFor(mode: ComposeMode, s: string | null | undefined): string {
  const base = s ?? "";
  if (mode === "reply" || mode === "replyAll") return /^re:/i.test(base) ? base : `RE: ${base}`;
  if (mode === "forward") return /^fw(d)?:/i.test(base) ? base : `FW: ${base}`;
  return base;
}

function recipientsFor(init: ComposeInit, me: string | null): { to: Address[]; cc: Address[] } {
  const src = init.source;
  if (!src || init.mode === "new") return { to: init.to ?? [], cc: init.cc ?? [] };
  if (init.mode === "draft") return { to: src.to, cc: src.cc };
  if (init.mode === "forward") return { to: [], cc: [] };
  const self = (a: Address) => me != null && a.address === me.toLowerCase();
  const replyTo = src.replyTo.length ? src.replyTo : src.from ? [src.from] : [];
  if (init.mode === "reply") return { to: replyTo, cc: [] };
  const seen = new Set<string>();
  const uniq = (list: Address[]) => list.filter((a) => !self(a) && !seen.has(a.address) && (seen.add(a.address), true));
  const to = uniq([...replyTo, ...src.to]);
  return { to, cc: uniq(src.cc) };
}

export function Composer({ init, accounts, onClose, onSent }: {
  init: ComposeInit; accounts: ConnectedAccount[]; onClose: () => void; onSent?: () => void;
}) {
  const [accountId, setAccountId] = useState(init.accountId ?? accounts[0]?.id ?? "");
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const initial = useMemo(() => recipientsFor(init, account?.email ?? null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [to, setTo] = useState<Address[]>(initial.to);
  const [cc, setCc] = useState<Address[]>(initial.cc);
  const [bcc, setBcc] = useState<Address[]>([]);
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [subject, setSubject] = useState(init.subject ?? subjectFor(init.mode, init.source?.subject));
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [sigId, setSigId] = useState<string>("");
  const [files, setFiles] = useState<File[]>([]);
  const [docs, setDocs] = useState<DocOption[]>([]);
  const [docIds, setDocIds] = useState<string[]>([]);
  const [links, setLinks] = useState<RecordHit[]>(init.links ?? []);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // One id per composed email: a retry after a lost response can't send it twice.
  const requestId = useRef(crypto.randomUUID());
  const isReply = init.mode === "reply" || init.mode === "replyAll" || init.mode === "forward";

  useEffect(() => {
    if (editor.current && init.mode === "draft" && init.source?.editableHtml) editor.current.innerHTML = init.source.editableHtml;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The mailbox's signatures; preselect its default for this kind of message.
  useEffect(() => {
    if (!accountId) return;
    api.get<Signature[]>(`/mail/${accountId}/signatures`).then((list) => {
      setSignatures(list);
      const d = list.find((s) => (isReply ? s.defaultReply : s.defaultNew));
      setSigId(d?.id ?? "");
    }).catch(() => setSignatures([]));
  }, [accountId, isReply]);

  // Documents on the records this is filed on, to attach.
  useEffect(() => {
    let live = true;
    (async () => {
      const out: DocOption[] = [];
      for (const r of links) {
        if (r.type !== "deal" && r.type !== "opportunity") continue;
        try {
          const rec = await api.get<{ name: string; files?: { id: string; filename: string; sizeBytes: number }[] }>(`/${r.type === "deal" ? "deals" : "opportunities"}/${r.id}`);
          for (const f of rec.files ?? []) out.push({ id: f.id, filename: f.filename, sizeBytes: f.sizeBytes, record: rec.name });
        } catch { /* no access → nothing to offer */ }
      }
      if (live) setDocs(out);
    })();
    return () => { live = false; };
  }, [links]);

  const signature = signatures.find((s) => s.id === sigId) ?? null;
  const resolver = useMemo(() => (signature ? signatureCidResolver(signature.id) : undefined), [signature]);
  const totalBytes = files.reduce((n, f) => n + f.size, 0) + docs.filter((d) => docIds.includes(d.id)).reduce((n, d) => n + d.sizeBytes, 0);

  function exec(cmd: string, value?: string) {
    editor.current?.focus();
    document.execCommand(cmd, false, value);
    setDirty(true);
  }
  // Link: remember the selection, ask for the address inline, then apply it there.
  const savedRange = useRef<Range | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  function startLink() {
    const sel = window.getSelection();
    savedRange.current = sel && sel.rangeCount && editor.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    setLinkUrl("https://");
  }
  function applyLink() {
    const url = (linkUrl ?? "").trim();
    setLinkUrl(null);
    if (!/^(https?:\/\/[^\s]+|mailto:[^\s]+|tel:[^\s]+)$/i.test(url)) return;
    editor.current?.focus();
    const sel = window.getSelection();
    if (savedRange.current && sel) { sel.removeAllRanges(); sel.addRange(savedRange.current); }
    if (sel && sel.isCollapsed) document.execCommand("insertText", false, url);
    exec("createLink", url);
  }

  async function send() {
    if (busy || !account) return;
    if (!to.length) { setErr(init.mode === "forward" ? "Who should this be forwarded to?" : "Add at least one recipient."); return; }
    setBusy(true); setErr(null); setProgress(0);
    const payload = {
      mode: init.mode, sourceMessageId: init.source?.id ?? null, to, cc, bcc, subject,
      html: editor.current?.innerHTML ?? "", signatureId: sigId || null, documentIds: docIds,
      links: links.map((l) => ({ type: l.type, id: l.id })), clientRequestId: requestId.current,
    };
    const form = new FormData();
    form.append("payload", JSON.stringify(payload));
    for (const f of files) form.append("files", f);
    try {
      await uploadWithProgress(`/mail/${account.id}/send`, form, setProgress);
      showToast(`Sent from ${account.email}. It's in your Outlook Sent Items.`);
      onSent?.();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Sending failed. Nothing was sent; try again.");
    } finally { setBusy(false); }
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } };
  const title = { new: "New email", reply: "Reply", replyAll: "Reply all", forward: "Forward", draft: "Finish draft" }[init.mode];

  return (
    <Modal title={title} wide onClose={onClose} dirty={dirty}
      footer={<>
        <span className="modal-req-note">{busy ? (progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Sending through Outlook…") : totalBytes ? `${humanBytes(totalBytes)} attached` : ""}</span>
        <button onClick={onClose}>Discard</button>
        <button className="primary" disabled={busy || !account} onClick={() => void send()}>{busy ? "Sending…" : "Send"}</button>
      </>}>
      <div className="mc" onKeyDown={onKey}>
        {err && <Banner kind="error">{err}</Banner>}
        {accounts.length > 1 && (
          <div className="mc-row"><span className="mc-lbl">From</span>
            <Select value={accountId} onChange={setAccountId} options={accounts.map((a) => ({ value: a.id, label: a.displayName ? `${a.displayName} <${a.email}>` : a.email ?? "Outlook" }))} ariaLabel="From" />
          </div>
        )}
        {accounts.length === 1 && account && <div className="mc-row"><span className="mc-lbl">From</span><span className="mc-from">{fmtAddress({ name: account.displayName, address: account.email ?? "" })}</span></div>}
        <AddressField label="To" accountId={accountId} value={to} onChange={(v) => { setTo(v); setDirty(true); }} extra={!showCc && <button type="button" className="link-btn mc-cc-toggle" onClick={() => setShowCc(true)}>Cc / Bcc</button>} />
        {showCc && <AddressField label="Cc" accountId={accountId} value={cc} onChange={(v) => { setCc(v); setDirty(true); }} />}
        {showCc && <AddressField label="Bcc" accountId={accountId} value={bcc} onChange={(v) => { setBcc(v); setDirty(true); }} />}
        <div className="mc-row"><span className="mc-lbl">Subject</span>
          <input className="mc-subject" value={subject} maxLength={998} onChange={(e) => { setSubject(e.target.value); setDirty(true); }} aria-label="Subject" />
        </div>

        <div className="mc-toolbar" role="toolbar" aria-label="Formatting">
          <button type="button" title="Bold (⌘B)" onClick={() => exec("bold")}><Bold size={14} /></button>
          <button type="button" title="Italic (⌘I)" onClick={() => exec("italic")}><Italic size={14} /></button>
          <button type="button" title="Underline (⌘U)" onClick={() => exec("underline")}><Underline size={14} /></button>
          <button type="button" title="Bulleted list" onClick={() => exec("insertUnorderedList")}><List size={14} /></button>
          <button type="button" title="Numbered list" onClick={() => exec("insertOrderedList")}><ListOrdered size={14} /></button>
          <button type="button" title="Link" onMouseDown={(e) => e.preventDefault()} onClick={startLink}><Link2 size={14} /></button>
          <span className="mc-tool-sep" />
          <button type="button" title="Attach files" onClick={() => fileRef.current?.click()}><Paperclip size={14} /> Attach</button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ""; if (list.length) { setFiles((f) => [...f, ...list]); setDirty(true); } }} />
        </div>
        {linkUrl !== null && (
          <div className="mc-linkbar">
            <input autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} aria-label="Link address"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") { e.stopPropagation(); setLinkUrl(null); } }} />
            <button type="button" className="small primary" onClick={applyLink}>Add link</button>
            <button type="button" className="small" onClick={() => setLinkUrl(null)}>Cancel</button>
          </div>
        )}
        <div ref={editor} className="mc-editor" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Message"
          onInput={() => setDirty(true)} data-placeholder="Write your message…" />

        <div className="mc-sig">
          <div className="mc-sig-head">
            <span className="mc-lbl">Signature</span>
            <Select value={sigId} onChange={setSigId} ariaLabel="Signature" width={240}
              options={[{ value: "", label: "No signature" }, ...signatures.map((s) => ({ value: s.id, label: s.name }))]} />
            {signatures.length === 0 && <Link to="/settings/integrations" className="mc-sig-hint">Import your Outlook signature</Link>}
          </div>
          {signature && <div className="mc-sig-preview"><MailBody html={signature.html} resolveCid={resolver} compact /></div>}
        </div>

        {(files.length > 0 || docs.length > 0) && (
          <div className="mc-atts">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="mc-att"><Paperclip size={12} /> {f.name} <span className="mc-att-size">{humanBytes(f.size)}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((l) => l.filter((_, j) => j !== i))}><X size={12} /></button></span>
            ))}
            {docs.length > 0 && (
              <details className="mc-docs">
                <summary>Attach from documents ({docs.length})</summary>
                {docs.map((d) => (
                  <label key={d.id} className="mc-doc">
                    <input type="checkbox" checked={docIds.includes(d.id)} onChange={(e) => setDocIds((ids) => (e.target.checked ? [...ids, d.id] : ids.filter((x) => x !== d.id)))} />
                    <FileText size={13} /> {d.filename} <span className="mc-att-size">{humanBytes(d.sizeBytes)} · {d.record}</span>
                  </label>
                ))}
              </details>
            )}
          </div>
        )}

        <div className="mc-links">
          <span className="mc-lbl">File on</span>
          {links.map((l) => (
            <span key={`${l.type}:${l.id}`} className="mc-link-chip">{l.name}
              <button type="button" aria-label={`Don't file on ${l.name}`} onClick={() => setLinks((x) => x.filter((y) => !(y.type === l.type && y.id === l.id)))}><X size={12} /></button></span>
          ))}
          <button type="button" className="link-btn" onClick={() => setPicking(true)}>+ Add record</button>
          <span className="mc-links-note">Recipients who are contacts or buyers are filed automatically.</span>
        </div>

        {isReply && init.source && (
          <details className="mc-quote">
            <summary>{init.mode === "forward" ? "Forwarded message" : "Original message"} — {fmtAddress(init.source.from)}{init.mode === "forward" && init.source.attachments.some((a) => !a.isInline) ? " · attachments included" : ""}</summary>
            <MailBody html={init.source.bodyHtml} />
          </details>
        )}
      </div>
      {picking && (
        <Modal title="File this email on a record" onClose={() => setPicking(false)}>
          <RecordPicker exclude={links as RecordRef[]} onPick={(r) => { setLinks((x) => [...x, r]); setPicking(false); }} />
        </Modal>
      )}
    </Modal>
  );
}

/** Recipients as chips, with contact/buyer suggestions. */
function AddressField({ label, accountId, value, onChange, extra }: {
  label: string; accountId: string; value: Address[]; onChange: (v: Address[]) => void; extra?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [hints, setHints] = useState<{ name: string; address: string; kind: string }[]>([]);
  const [bad, setBad] = useState<string[]>([]);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2 || !accountId) { setHints([]); return; }
    let live = true;
    const t = setTimeout(() => {
      api.get<{ name: string; address: string; kind: string }[]>(`/mail/${accountId}/recipients?q=${encodeURIComponent(q)}`)
        .then((h) => { if (live) setHints(h.filter((x) => !value.some((v) => v.address === x.address))); }).catch(() => {});
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [text, accountId, value]);
  function commit(raw = text) {
    const { ok, bad: wrong } = parseAddressList(raw);
    if (ok.length) onChange([...value, ...ok.filter((a) => !value.some((v) => v.address === a.address))]);
    setBad(wrong);
    setText(wrong.join(", "));
    setHints([]);
  }
  return (
    <div className="mc-row mc-addr">
      <span className="mc-lbl">{label}</span>
      <div className="mc-chips">
        {value.map((a) => (
          <span key={a.address} className="mc-chip" title={a.address}>{a.name || a.address}
            <button type="button" aria-label={`Remove ${a.address}`} onClick={() => onChange(value.filter((v) => v.address !== a.address))}><X size={11} /></button></span>
        ))}
        <input value={text} aria-label={label} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === "Tab") { if (text.trim()) { e.preventDefault(); commit(); } } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1)); }}
          onBlur={() => { if (text.trim()) commit(); }} />
        {hints.length > 0 && (
          <div className="mc-hints" role="listbox">
            {hints.map((h) => (
              <button key={h.address} type="button" role="option" aria-selected="false" className="mc-hint" onMouseDown={(e) => { e.preventDefault(); onChange([...value, { name: h.name, address: h.address }]); setText(""); setHints([]); }}>
                <strong>{h.name}</strong> <span>{h.address}</span> <em>{h.kind}</em>
              </button>
            ))}
          </div>
        )}
      </div>
      {extra}
      {bad.length > 0 && <span className="error-text mc-bad">Not an email address: {bad.join(", ")}</span>}
    </div>
  );
}
