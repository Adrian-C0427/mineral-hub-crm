import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { Banner, ConfirmDialog, Modal, Spinner, showToast } from "../ui";
import { Tag } from "../kit";
import { MailBody, signatureCidResolver } from "./MailBody";
import { uploadWithProgress } from "../../lib/cloud";
import type { Signature } from "../../lib/mail";
import type { ConnectedAccount } from "../../lib/connectedAccounts";

/**
 * Outlook signatures for one connected mailbox. Microsoft offers no API to
 * read an Outlook signature, so it's imported once (pasted or uploaded, with
 * its formatting and images) and managed here: one default for new messages
 * and one for replies & forwards. Recipients see exactly the imported
 * signature — images travel inside the email, like Outlook sends them.
 */
export function SignaturesModal({ account, onClose }: { account: ConnectedAccount; onClose: () => void }) {
  const [list, setList] = useState<Signature[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState<Signature | null>(null);
  const [deleting, setDeleting] = useState<Signature | null>(null);
  const load = () => { api.get<Signature[]>(`/mail/${account.id}/signatures`).then(setList).catch((e) => setErr(e instanceof ApiError ? e.message : "Couldn't load signatures.")); };
  useEffect(load, [account.id]);

  async function patch(s: Signature, body: Record<string, string | boolean>) {
    setErr(null);
    try { await api.patch(`/mail/signatures/${s.id}`, body); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Couldn't save."); }
  }
  const setDefault = (s: Signature, kind: "defaultNew" | "defaultReply", on: boolean) => void patch(s, { [kind]: on });

  return (
    <Modal title={`Signatures · ${account.email ?? "Outlook"}`} wide onClose={onClose}
      footer={<><span className="modal-req-note">Imported once — Microsoft doesn't let apps read Outlook signatures automatically.</span><button onClick={onClose}>Done</button><button className="primary" onClick={() => setImporting(true)}>Import signature</button></>}>
      {err && <Banner kind="error">{err}</Banner>}
      {!list ? <Spinner label="Loading…" /> : list.length === 0 ? (
        <div className="sig-empty">
          <p>No signature yet. Import the one you use in Outlook so emails sent from the CRM look exactly like emails sent from Outlook.</p>
          <button className="primary" onClick={() => setImporting(true)}>Import your Outlook signature</button>
        </div>
      ) : (
        <div className="sig-list">
          {list.map((s) => (
            <div key={s.id} className="sig-card">
              <div className="sig-card-head">
                <strong>{s.name}</strong>
                {s.defaultNew && <Tag tone="accent">New messages</Tag>}
                {s.defaultReply && <Tag tone="cyan">Replies &amp; forwards</Tag>}
                <span className="sig-card-actions">
                  <label><input type="checkbox" checked={s.defaultNew} onChange={(e) => void setDefault(s, "defaultNew", e.target.checked)} /> Use for new</label>
                  <label><input type="checkbox" checked={s.defaultReply} onChange={(e) => void setDefault(s, "defaultReply", e.target.checked)} /> Use for replies</label>
                  <button className="small" onClick={() => setRenaming(s)}>Rename</button>
                  <button className="small set-btn-danger-text" onClick={() => setDeleting(s)}>Delete</button>
                </span>
              </div>
              <div className="sig-preview"><MailBody html={s.html} resolveCid={signatureCidResolver(s.id)} compact /></div>
            </div>
          ))}
        </div>
      )}
      {importing && <ImportSignatureModal account={account} first={!list?.length} onClose={() => setImporting(false)} onSaved={() => { setImporting(false); load(); }} />}
      {renaming && <RenameSig s={renaming} onClose={() => setRenaming(null)} onSave={(name) => { const s = renaming; setRenaming(null); void patch(s, { name }); }} />}
      {deleting && (
        <ConfirmDialog title={`Delete “${deleting.name}”?`} message={<p style={{ margin: 0 }}>Emails already sent keep it. You can import it again any time.</p>}
          confirmLabel="Delete" danger onCancel={() => setDeleting(null)}
          onConfirm={() => { const s = deleting; setDeleting(null); void api.del(`/mail/signatures/${s.id}`).then(load).catch((e) => setErr(e instanceof ApiError ? e.message : "Couldn't delete.")); }} />
      )}
    </Modal>
  );
}

function RenameSig({ s, onClose, onSave }: { s: Signature; onClose: () => void; onSave: (n: string) => void }) {
  const [v, setV] = useState(s.name);
  return (
    <Modal title="Rename signature" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!v.trim() || v.trim() === s.name} onClick={() => onSave(v.trim())}>Save</button></>}>
      <div className="field" style={{ marginBottom: 0 }}><label>Name</label><input autoFocus value={v} maxLength={100} onChange={(e) => setV(e.target.value)} /></div>
    </Modal>
  );
}

interface Preview { html: string; images: { contentId: string; dataUrl: string }[] }

function ImportSignatureModal({ account, first, onClose, onSaved }: { account: ConnectedAccount; first: boolean; onClose: () => void; onSaved: () => void }) {
  const [tab, setTab] = useState<"paste" | "upload">("paste");
  const [html, setHtml] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [name, setName] = useState("Outlook signature");
  const [forNew, setForNew] = useState(true);
  const [forReply, setForReply] = useState(first);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pasteRef = useRef<HTMLDivElement>(null);

  const form = (extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.append("name", name.trim() || "Outlook signature");
    f.append("html", html);
    f.append("defaultNew", String(forNew));
    f.append("defaultReply", String(forReply));
    for (const [k, v] of Object.entries(extra)) f.append(k, v);
    for (const img of images) f.append("images", img);
    return f;
  };
  // Re-preview whenever the source changes.
  useEffect(() => {
    if (!html.trim()) { setPreview(null); setMissing([]); return; }
    let live = true;
    setBusy(true); setErr(null);
    uploadWithProgress<{ preview: Preview; missing: string[] }>(`/mail/${account.id}/signatures?preview=1`, form(), () => {})
      .then((r) => { if (live) { setPreview(r.preview); setMissing(r.missing); } })
      .catch((e) => { if (live) { setPreview(null); setErr(e instanceof ApiError ? e.message : "Couldn't read that signature."); } })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [html, images]); // eslint-disable-line react-hooks/exhaustive-deps

  const previewResolver = useMemo(() => (preview ? async (cid: string) => preview.images.find((i) => i.contentId === cid)?.dataUrl ?? null : undefined), [preview]);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await uploadWithProgress(`/mail/${account.id}/signatures`, form(), () => {});
      showToast("Signature imported.");
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Couldn't import it."); }
    finally { setBusy(false); }
  }

  async function readHtm(file: File) {
    const text = await file.text();
    setHtml(text);
    if (!name.trim() || name === "Outlook signature") setName(file.name.replace(/\.(htm|html)$/i, ""));
  }

  return (
    <Modal title="Import your Outlook signature" wide onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!preview || busy} onClick={() => void save()}>{busy ? "Working…" : "Save signature"}</button></>}>
      {err && <Banner kind="error">{err}</Banner>}
      <div className="cb-views sig-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "paste"} className={`cb-view ${tab === "paste" ? "active" : ""}`} onClick={() => setTab("paste")}>Paste from Outlook</button>
        <button type="button" role="tab" aria-selected={tab === "upload"} className={`cb-view ${tab === "upload" ? "active" : ""}`} onClick={() => setTab("upload")}>Upload signature files</button>
      </div>
      {tab === "paste" ? (
        <>
          <ol className="sig-steps">
            <li>In Outlook, open <strong>Settings → Signatures</strong> (or a sent email that has your signature).</li>
            <li>Select the whole signature and copy it (⌘C / Ctrl+C).</li>
            <li>Click the box below and paste (⌘V / Ctrl+V). Fonts, colors, links and logos come along.</li>
          </ol>
          <div ref={pasteRef} className="sig-paste" contentEditable suppressContentEditableWarning role="textbox" aria-label="Paste your signature here"
            data-placeholder="Paste your signature here"
            onPaste={(e) => {
              const rich = e.clipboardData.getData("text/html");
              if (rich) { e.preventDefault(); setHtml(rich); if (pasteRef.current) pasteRef.current.textContent = "Signature pasted — see the preview below."; }
            }}
            onInput={() => { if (pasteRef.current && !html) setHtml(pasteRef.current.innerHTML); }} />
        </>
      ) : (
        <>
          <p className="sig-steps-p">
            Classic Outlook keeps each signature as an <code>.htm</code> file with a folder of images —
            on Windows in <code>%APPDATA%\Microsoft\Signatures</code>, on Mac in Outlook's signature settings. Choose the <code>.htm</code> file and its image files.
          </p>
          <div className="sig-upload-row">
            <label className="integration-link-btn">Choose .htm file<input type="file" hidden accept=".htm,.html,text/html" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void readHtm(f); }} /></label>
            <label className="integration-link-btn">Add image files<input type="file" hidden multiple accept="image/*" onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ""; if (list.length) setImages((x) => [...x, ...list]); }} /></label>
            {images.length > 0 && <span className="muted">{images.length} image{images.length === 1 ? "" : "s"} added</span>}
          </div>
        </>
      )}

      {missing.length > 0 && (
        <Banner kind="error">
          {missing.length === 1 ? "One image" : `${missing.length} images`} couldn't be read ({missing.join(", ")}) — Outlook copied {missing.length === 1 ? "it" : "them"} as a file on your computer.{" "}
          <label className="link-btn" style={{ cursor: "pointer" }}>Add the image file{missing.length === 1 ? "" : "s"}<input type="file" hidden multiple accept="image/*" onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ""; if (list.length) setImages((x) => [...x, ...list]); }} /></label>
          {" "}(or use “Upload signature files”).
        </Banner>
      )}

      {preview && (
        <>
          <div className="sig-preview-label">Preview — exactly what recipients will see</div>
          <div className="sig-preview"><MailBody html={preview.html} resolveCid={previewResolver} compact /></div>
          <div className="sig-meta">
            <div className="field"><label>Name</label><input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></div>
            <label className="sig-check"><input type="checkbox" checked={forNew} onChange={(e) => setForNew(e.target.checked)} /> Use for new messages</label>
            <label className="sig-check"><input type="checkbox" checked={forReply} onChange={(e) => setForReply(e.target.checked)} /> Use for replies &amp; forwards</label>
          </div>
        </>
      )}
      {busy && !preview && <Spinner label="Reading the signature…" />}
    </Modal>
  );
}
