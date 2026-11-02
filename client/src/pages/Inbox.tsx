import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Archive, CornerUpLeft, CornerUpRight, Forward, Inbox as InboxIcon, Mail, MailOpen, Paperclip, PenSquare, RefreshCw, Search, Send, Trash2, Folder, FileText, Link2, X } from "lucide-react";
import { api, ApiError } from "../api/client";
import { Banner, Modal, Spinner, showToast } from "../components/ui";
import { Select } from "../components/Select";
import { RecordPicker } from "../components/RecordPicker";
import { MailBody, messageCidResolver } from "../components/mail/MailBody";
import { Composer, type ComposeInit } from "../components/mail/Composer";
import { fmtDateTime } from "../lib/format";
import { downloadThroughApi, humanBytes } from "../lib/cloud";
import { FOLDER_LABEL, fmtAddress, shortAddress, type MailFolder, type MailMessage, type MailSummary } from "../lib/mail";
import { useConnectedAccounts, usableAccounts } from "../lib/connectedAccounts";

/**
 * Inbox — the member's own Outlook mailbox inside the CRM: folders, search,
 * threaded conversations, reply / reply all / forward, attachments, and
 * filing emails on deals, opportunities, contacts and buyers. Everything
 * happens in Outlook itself (sent mail is in Sent Items, deletes go to
 * Deleted Items), so the CRM and Outlook always agree.
 */
const FOLDER_ICON: Record<string, typeof Mail> = { inbox: InboxIcon, sentitems: Send, drafts: PenSquare, archive: Archive, deleteditems: Trash2 };

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (today.getTime() - d.getTime() < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

const RECORD_LABEL = { deal: "Deal", opportunity: "Opportunity", contact: "Contact", buyer: "Buyer" } as const;
const recordHref = (r: { type: keyof typeof RECORD_LABEL; id: string }) =>
  r.type === "deal" ? `/deals/${r.id}` : r.type === "opportunity" ? `/opportunities/${r.id}` : r.type === "contact" ? `/contacts/${r.id}` : `/buyers/${r.id}`;

export function Inbox() {
  const { data, error } = useConnectedAccounts();
  const mailboxes = useMemo(() => usableAccounts(data?.accounts, "outlook"), [data]);
  const broken = (data?.accounts ?? []).filter((a) => a.provider === "outlook" && a.status === "NEEDS_RECONNECT");
  const [accountId, setAccountId] = useState<string>("");
  useEffect(() => { if (!accountId && mailboxes.length) setAccountId(mailboxes[0].id); }, [mailboxes, accountId]);
  const account = mailboxes.find((m) => m.id === accountId) ?? null;

  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [folder, setFolder] = useState<string>("inbox");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [unread, setUnread] = useState(false);
  const [items, setItems] = useState<MailSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<MailSummary | null>(null);
  const [compose, setCompose] = useState<ComposeInit | null>(null);

  const loadFolders = useCallback(() => {
    if (!accountId) return;
    api.get<MailFolder[]>(`/mail/${accountId}/folders`).then(setFolders).catch((e) => setErr(e instanceof ApiError ? e.message : "Couldn't load folders."));
  }, [accountId]);
  useEffect(loadFolders, [loadFolders]);

  const load = useCallback(async (more = false) => {
    if (!accountId) return;
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ folder });
      if (query) p.set("q", query);
      if (unread && !query) p.set("unread", "1");
      if (more && cursor) p.set("cursor", cursor);
      const page = await api.get<{ items: MailSummary[]; cursor: string | null }>(`/mail/${accountId}/messages?${p}`);
      setItems((prev) => (more ? [...prev, ...page.items] : page.items));
      setCursor(page.cursor);
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Couldn't load messages."); }
    finally { setLoading(false); }
  }, [accountId, folder, query, unread, cursor]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSelected(null); void load(false); }, [accountId, folder, query, unread]);

  const currentFolder = folders.find((f) => f.id === folder || f.wellKnown === folder);
  const folderName = query ? `Search: “${query}”` : currentFolder?.name ?? FOLDER_LABEL[folder as keyof typeof FOLDER_LABEL] ?? "Folder";

  if (!data && !error) return <Spinner label="Loading your mailbox…" />;
  return (
    <div className="page inbox-page">
      <div className="page-header">
        <div>
          <h1>Inbox</h1>
          <div className="page-sub">Your Outlook mailbox — read, reply and file conversations on deals, opportunities, contacts and buyers.</div>
        </div>
        {account && <button className="primary" onClick={() => setCompose({ mode: "new", accountId })}><PenSquare size={15} aria-hidden="true" /> New email</button>}
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {broken.map((a) => <Banner key={a.id} kind="error">Outlook ({a.email}) needs to be reconnected. <Link to="/settings/integrations">Reconnect in Settings → Integrations</Link>.</Banner>)}
      {err && <Banner kind="error">{err}</Banner>}

      {mailboxes.length === 0 ? (
        <div className="panel files-empty">
          <Mail size={22} aria-hidden="true" />
          <h3>Connect Outlook</h3>
          <p className="muted">Connect your Outlook / Microsoft 365 mailbox in <Link to="/settings/integrations">Settings → Integrations</Link> to read and send email here.</p>
        </div>
      ) : (
        <div className="ib">
          <aside className="ib-folders panel">
            {mailboxes.length > 1 && (
              <Select value={accountId} onChange={(v) => { setAccountId(v); setFolder("inbox"); }} ariaLabel="Mailbox"
                options={mailboxes.map((m) => ({ value: m.id, label: m.email ?? "Outlook" }))} />
            )}
            {mailboxes.length === 1 && <div className="ib-acct" title={account?.email ?? ""}>{account?.email}</div>}
            <nav className="ib-flist" aria-label="Folders">
              {folders.map((f) => {
                const Icon = FOLDER_ICON[f.wellKnown ?? ""] ?? Folder;
                const active = !query && (folder === f.id || folder === f.wellKnown);
                return (
                  <button key={f.id} type="button" className={`ib-folder ${active ? "active" : ""}`} onClick={() => { setQuery(""); setQ(""); setFolder(f.wellKnown ?? f.id); }}>
                    <Icon size={15} aria-hidden="true" /><span>{f.name}</span>{f.unread > 0 && <span className="ib-unread">{f.unread}</span>}
                  </button>
                );
              })}
            </nav>
          </aside>

          <section className="ib-list panel" aria-label="Messages">
            <div className="ib-listbar">
              <form className="cb-search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
                <Search size={14} aria-hidden="true" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mail" aria-label="Search mail" />
                {query && <button type="button" className="cb-clear" onClick={() => { setQ(""); setQuery(""); }}>Clear</button>}
              </form>
              <button type="button" className={`small ${unread ? "primary" : ""}`} disabled={!!query} onClick={() => setUnread((u) => !u)} title="Show unread only">Unread</button>
              <button type="button" className="small" title="Refresh" onClick={() => { loadFolders(); void load(false); }}><RefreshCw size={13} /></button>
            </div>
            <div className="ib-listhead">{folderName}</div>
            <div className="ib-rows">
              {items.map((m) => {
                const who = folder === "sentitems" || folder === "drafts" ? m.to.map(shortAddress).join(", ") || "(no recipients)" : shortAddress(m.from) || "(unknown sender)";
                return (
                  <button key={m.id} type="button" className={`ib-row ${selected?.id === m.id ? "active" : ""} ${m.isRead ? "" : "unread"}`} onClick={() => setSelected(m)}>
                    <span className="ib-row-top"><span className="ib-who">{m.isDraft && <em className="ib-draft">Draft</em>}{who}</span><span className="ib-when">{when(m.receivedAt ?? m.sentAt)}</span></span>
                    <span className="ib-subj">{m.subject || "(no subject)"}{m.hasAttachments && <Paperclip size={12} aria-label="Has attachments" />}{m.filed && <Link2 size={12} aria-label="Filed on a record" />}</span>
                    <span className="ib-prev">{m.preview}</span>
                  </button>
                );
              })}
              {loading && <Spinner label="Loading…" />}
              {!loading && items.length === 0 && <div className="cb-empty">{query ? "No messages match." : unread ? "No unread messages." : "No messages here."}</div>}
            </div>
            {cursor && !loading && <button className="small cb-more" onClick={() => void load(true)}>Load more</button>}
          </section>

          <section className="ib-read panel" aria-label="Reading pane">
            {selected && account ? (
              <Thread key={selected.id} accountId={account.id} summary={selected} folders={folders}
                onCompose={(init) => setCompose({ ...init, accountId: account.id })}
                onChanged={(removed) => { if (removed) setSelected(null); void load(false); loadFolders(); }} />
            ) : <div className="ib-empty"><MailOpen size={28} aria-hidden="true" /><span>Select a message to read it.</span></div>}
          </section>
        </div>
      )}
      {compose && <Composer init={compose} accounts={mailboxes} onClose={() => setCompose(null)} onSent={() => { void load(false); loadFolders(); }} />}
    </div>
  );
}

function Thread({ accountId, summary, folders, onCompose, onChanged }: {
  accountId: string; summary: MailSummary; folders: MailFolder[]; onCompose: (i: ComposeInit) => void; onChanged: (removed: boolean) => void;
}) {
  const [msg, setMsg] = useState<MailMessage | null>(null);
  const [thread, setThread] = useState<MailSummary[]>([]);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set([summary.id]));
  const [err, setErr] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);
  const base = `/mail/${accountId}`;

  const loadMsg = useCallback(async () => {
    setErr(null);
    try {
      const m = await api.get<MailMessage>(`${base}/messages/${encodeURIComponent(summary.id)}`);
      setMsg(m);
      if (!m.isRead) void api.patch(`${base}/messages/${encodeURIComponent(m.id)}`, { isRead: true }).then(() => onChanged(false)).catch(() => {});
      if (m.conversationId) {
        api.get<MailSummary[]>(`${base}/conversations/${encodeURIComponent(m.conversationId)}`).then(setThread).catch(() => setThread([]));
      }
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Couldn't open this message."); }
  }, [base, summary.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadMsg(); }, [loadMsg]);

  async function act(fn: () => Promise<unknown>, done: string, removed = false) {
    try { await fn(); showToast(done); onChanged(removed); } catch (e) { setErr(e instanceof ApiError ? e.message : "That didn't work."); }
  }
  async function unlink(linkId: string) {
    try { await api.del(`/mail/links/${linkId}`); await loadMsg(); } catch (e) { setErr(e instanceof ApiError ? e.message : "Couldn't remove it."); }
  }
  async function file(rec: { type: "deal" | "opportunity" | "contact" | "buyer"; id: string; name: string }) {
    setFiling(false);
    try {
      await api.post(`${base}/messages/${encodeURIComponent(summary.id)}/links`, { records: [{ type: rec.type, id: rec.id }] });
      showToast(`Filed on ${rec.name}.`);
      await loadMsg();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Couldn't file it."); }
  }

  if (err && !msg) return <Banner kind="error">{err}</Banner>;
  if (!msg) return <Spinner label="Opening…" />;
  const others = thread.filter((t) => t.id !== msg.id);
  const attachments = msg.attachments.filter((a) => !a.isInline);
  const moveTargets = folders.filter((f) => f.id !== msg.folderId);

  return (
    <div className="ib-thread">
      <div className="ib-thead">
        <h2>{msg.subject || "(no subject)"}</h2>
        <div className="ib-actions">
          {msg.isDraft ? (
            <button className="small primary" onClick={() => onCompose({ mode: "draft", source: msg })}><PenSquare size={13} /> Edit &amp; send</button>
          ) : (
            <>
              <button className="small" onClick={() => onCompose({ mode: "reply", source: msg })}><CornerUpLeft size={13} /> Reply</button>
              <button className="small" onClick={() => onCompose({ mode: "replyAll", source: msg })}><CornerUpRight size={13} /> Reply all</button>
              <button className="small" onClick={() => onCompose({ mode: "forward", source: msg })}><Forward size={13} /> Forward</button>
            </>
          )}
          <button className="small" onClick={() => setFiling(true)}><Link2 size={13} /> File on record</button>
          <button className="small" title="Mark as unread" onClick={() => void act(() => api.patch(`${base}/messages/${encodeURIComponent(msg.id)}`, { isRead: false }), "Marked as unread.")}><Mail size={13} /></button>
          {moveTargets.length > 0 && (
            <span className="ib-move"><Select value="" onChange={(f) => f && void act(() => api.patch(`${base}/messages/${encodeURIComponent(msg.id)}`, { folder: f }), "Moved.", true)} ariaLabel="Move to folder" placeholder="Move to…" width={150}
              options={moveTargets.map((f) => ({ value: f.wellKnown ?? f.id, label: f.name }))} /></span>
          )}
          <button className="small set-btn-danger-text" title="Delete (moves to Deleted Items)" onClick={() => void act(() => api.del(`${base}/messages/${encodeURIComponent(msg.id)}`), "Moved to Deleted Items.", true)}><Trash2 size={13} /></button>
        </div>
      </div>
      {err && <Banner kind="error">{err}</Banner>}
      {msg.links.length > 0 && (
        <div className="ib-filed">
          <span className="mc-lbl">Filed on</span>
          {msg.links.filter((l) => l.record).map((l) => (
            <span key={l.id} className="mc-link-chip" title={RECORD_LABEL[l.record!.type]}><Link to={recordHref(l.record!)}>{l.name ?? RECORD_LABEL[l.record!.type]}</Link>
              <button type="button" aria-label="Remove from this record" onClick={() => void unlink(l.id)}><X size={11} /></button></span>
          ))}
        </div>
      )}

      {others.length > 0 && (
        <div className="ib-older">
          {others.map((t) => (
            <OlderMessage key={t.id} accountId={accountId} summary={t} open={openIds.has(t.id)} onToggle={() => setOpenIds((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })} />
          ))}
        </div>
      )}

      <article className="ib-msg">
        <header className="ib-mhead">
          <div><strong>{fmtAddress(msg.from)}</strong></div>
          <div className="ib-mmeta">To: {msg.to.map(fmtAddress).join(", ") || "—"}{msg.cc.length ? ` · Cc: ${msg.cc.map(fmtAddress).join(", ")}` : ""}</div>
          <div className="ib-mmeta">{fmtDateTime(msg.receivedAt ?? msg.sentAt)}</div>
        </header>
        {attachments.length > 0 && (
          <div className="ib-atts">
            {attachments.map((a) => (
              <button key={a.id} type="button" className="mc-att" disabled={a.kind !== "file"} title={a.kind !== "file" ? "Outlook item — open it in Outlook" : "Download"}
                onClick={() => void downloadThroughApi(`${base}/messages/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(a.id)}`, a.name).catch((e) => setErr(e instanceof Error ? e.message : "Download failed"))}>
                <FileText size={12} /> {a.name} <span className="mc-att-size">{humanBytes(a.size)}</span>
              </button>
            ))}
          </div>
        )}
        <MailBody html={msg.bodyHtml} resolveCid={messageCidResolver(`${base}/messages/${encodeURIComponent(msg.id)}/attachments`, msg.attachments)} />
      </article>
      {filing && (
        <Modal title="File this email on a record" onClose={() => setFiling(false)}>
          <p className="muted" style={{ marginTop: 0 }}>Teammates who can open the record will see this email (and the rest of the conversation as it continues).</p>
          <RecordPicker exclude={msg.links.map((l) => l.record!).filter(Boolean)} onPick={(r) => void file(r)} />
        </Modal>
      )}
    </div>
  );
}

function OlderMessage({ accountId, summary, open, onToggle }: { accountId: string; summary: MailSummary; open: boolean; onToggle: () => void }) {
  const [msg, setMsg] = useState<MailMessage | null>(null);
  useEffect(() => {
    if (open && !msg) api.get<MailMessage>(`/mail/${accountId}/messages/${encodeURIComponent(summary.id)}`).then(setMsg).catch(() => {});
  }, [open, msg, accountId, summary.id]);
  return (
    <div className={`ib-old ${open ? "open" : ""}`}>
      <button type="button" className="ib-old-head" onClick={onToggle}>
        <strong>{shortAddress(summary.from) || "(unknown)"}</strong>
        <span className="ib-prev">{open ? "" : summary.preview}</span>
        <span className="ib-when">{when(summary.receivedAt ?? summary.sentAt)}</span>
      </button>
      {open && (msg ? <MailBody html={msg.bodyHtml} resolveCid={messageCidResolver(`/mail/${accountId}/messages/${encodeURIComponent(msg.id)}/attachments`, msg.attachments)} /> : <Spinner label="Loading…" />)}
    </div>
  );
}
