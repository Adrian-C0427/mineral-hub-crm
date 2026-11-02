import { useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Mail, PenSquare } from "lucide-react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { Banner, Modal, Spinner } from "../ui";
import { Tag } from "../kit";
import { MailBody } from "./MailBody";
import { Composer } from "./Composer";
import { fmtDateTime } from "../../lib/format";
import { fmtAddress, shortAddress, type Address, type FiledEmail } from "../../lib/mail";
import type { RecordRef } from "../../lib/cloud";
import { useConnectedAccounts, usableAccounts } from "../../lib/connectedAccounts";
import { useAuth } from "../../auth/AuthContext";

/**
 * Emails filed on a record — sent from the CRM or matched from a member's
 * Outlook (an exact contact/buyer address, or a conversation already filed
 * here). Visible to everyone who can open the record; the full mailbox stays
 * its owner's. "Email" composes from the viewer's own Outlook, filed here.
 */
export function RecordEmails({ record, name, defaultTo }: { record: RecordRef; name: string; defaultTo?: Address[] }) {
  const { can } = useAuth();
  const { data } = useConnectedAccounts();
  const mailboxes = useMemo(() => usableAccounts(data?.accounts, "outlook"), [data]);
  const [rows, setRows] = useState<FiledEmail[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<FiledEmail | null>(null);
  const [composing, setComposing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const load = () => {
    api.get<FiledEmail[]>(`/mail/record?type=${record.type}&id=${encodeURIComponent(record.id)}`)
      .then((r) => { setRows(r); setErr(null); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Couldn't load emails."));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [record.type, record.id]);

  const canSend = can("sendEmail") && mailboxes.length > 0;
  if (rows && rows.length === 0 && !canSend) return null;
  const shown = expanded ? rows ?? [] : (rows ?? []).slice(0, 5);
  return (
    <div className="panel re-panel">
      <div className="re-head">
        <h3><Mail size={15} aria-hidden="true" /> Emails{rows && rows.length ? <span className="re-count">{rows.length}</span> : null}</h3>
        {canSend && <button className="small" onClick={() => setComposing(true)}><PenSquare size={13} aria-hidden="true" /> Email</button>}
      </div>
      {err && <Banner kind="error">{err}</Banner>}
      {!rows ? <Spinner label="Loading…" /> : rows.length === 0 ? (
        <p className="muted re-empty">No emails yet. Emails with this {record.type === "deal" ? "deal's buyers" : record.type} from team members' connected Outlook appear here, as do emails sent from this page.</p>
      ) : (
        <div className="re-list">
          {shown.map((m) => (
            <button key={m.id} type="button" className="re-row" onClick={() => setOpen(m)}>
              <span className={`re-dir ${m.direction}`} aria-label={m.direction === "in" ? "Received" : "Sent"}>{m.direction === "in" ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}</span>
              <span className="re-main">
                <span className="re-top">
                  <strong>{m.direction === "in" ? (m.fromName || m.fromAddress) : `To ${m.toRecipients.map(shortAddress).join(", ")}`}</strong>
                  <span className="re-when">{fmtDateTime(m.receivedAt ?? m.sentAt ?? m.createdAt)}</span>
                </span>
                <span className="re-subj">{m.subject || "(no subject)"}</span>
                <span className="re-prev">{m.bodyPreview}</span>
              </span>
              {m.sendStatus === "QUEUED" || m.sendStatus === "SENDING" ? <Tag tone="accent">Sending…</Tag>
                : m.sendStatus === "FAILED" ? <Tag tone="danger" title={m.sendError ?? undefined}>Not sent</Tag> : null}
            </button>
          ))}
          {rows.length > 5 && <button type="button" className="link-btn re-more" onClick={() => setExpanded((x) => !x)}>{expanded ? "Show fewer" : `Show all ${rows.length}`}</button>}
        </div>
      )}
      {open && <StoredEmailModal id={open.id} onClose={() => setOpen(null)} />}
      {composing && (
        <Composer accounts={mailboxes} onClose={() => setComposing(false)} onSent={load}
          init={{ mode: "new", to: defaultTo ?? [], links: [{ ...record, name, detail: null }] }} />
      )}
    </div>
  );
}

interface StoredEmail extends FiledEmail { bodyHtml: string | null; providerMessageId: string | null }

/** A filed email as stored (its body, sanitized). The mailbox owner can jump to it in their Inbox. */
function StoredEmailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [m, setM] = useState<StoredEmail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.get<StoredEmail>(`/mail/stored/${encodeURIComponent(id)}`).then(setM).catch((e) => setErr(e instanceof ApiError ? e.message : "Couldn't open it.")); }, [id]);
  return (
    <Modal title={m?.subject || "Email"} wide onClose={onClose} footer={<>
      {m?.mine && <Link className="integration-link-btn" to="/inbox">Open your Inbox</Link>}
      <button onClick={onClose}>Close</button>
    </>}>
      {err && <Banner kind="error">{err}</Banner>}
      {!m ? !err && <Spinner label="Opening…" /> : (
        <div className="re-stored">
          <div className="ib-mhead">
            <div><strong>{fmtAddress({ name: m.fromName, address: m.fromAddress ?? "" })}</strong></div>
            <div className="ib-mmeta">To: {m.toRecipients.map(fmtAddress).join(", ")}{m.ccRecipients.length ? ` · Cc: ${m.ccRecipients.map(fmtAddress).join(", ")}` : ""}</div>
            <div className="ib-mmeta">{fmtDateTime(m.receivedAt ?? m.sentAt ?? m.createdAt)} · in {m.mine ? "your" : `${m.account.displayName ?? m.account.email}'s`} mailbox{m.hasAttachments ? " · has attachments (in the mailbox)" : ""}</div>
            {m.sendStatus === "FAILED" && <Banner kind="error">Not sent: {m.sendError}</Banner>}
          </div>
          {m.bodyHtml ? <MailBody html={m.bodyHtml} /> : <p className="muted">{m.bodyPreview}</p>}
        </div>
      )}
    </Modal>
  );
}
