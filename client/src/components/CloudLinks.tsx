import { useEffect, useMemo, useState } from "react";
import { Cloud, ExternalLink, Link2 } from "lucide-react";
import { api, ApiError } from "../api/client";
import { Banner, ConfirmDialog, Modal, OverflowMenu, showToast } from "./ui";
import { Select } from "./Select";
import { Tag } from "./kit";
import { CloudBrowser } from "./CloudBrowser";
import { fmtDateLocal } from "../lib/format";
import { downloadThroughApi, humanBytes, PROVIDER_LABEL, type CloudItem, type CloudLink, type RecordRef } from "../lib/cloud";
import { useConnectedAccounts, usableAccounts, type ConnectedAccount } from "../lib/connectedAccounts";

/**
 * Drive files on CRM records. Three kinds of document stay distinct wherever
 * they appear:
 *   Stored  — kept in the CRM's own storage (the Documents table)
 *   Linked  — lives in someone's OneDrive / Google Drive; the record points at it
 *   Copied  — a stored document someone explicitly copied to their drive
 * Linked files open at the provider, where its own permissions decide who can
 * see them; only the person whose drive it is can download through the CRM.
 */

export function useDriveAccounts(enabled: boolean) {
  const { data } = useConnectedAccounts();
  return useMemo(() => (enabled && data ? [...usableAccounts(data.accounts, "onedrive"), ...usableAccounts(data.accounts, "googledrive")] : []), [enabled, data]);
}

export function useRecordLinks(record: RecordRef | null) {
  const [links, setLinks] = useState<CloudLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    if (!record) return;
    api.get<CloudLink[]>(`/cloud/links?type=${record.type}&id=${encodeURIComponent(record.id)}`)
      .then((l) => { setLinks(l); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load linked files"));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [record?.type, record?.id]);
  return { links, error, reload };
}

const STATUS_NOTE: Record<CloudLink["status"], string | null> = {
  OK: null,
  MISSING: "Deleted or moved to the trash in the drive",
  NO_ACCESS: "No longer accessible with the linked account",
};

/** The linked / copied drive files in one documents folder (or all, for records without folders). */
export function CloudLinksList({ links, folders, canEdit, onChanged }: {
  links: CloudLink[]; folders?: string[]; canEdit: boolean; onChanged: () => void;
}) {
  const [moving, setMoving] = useState<CloudLink | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (links.length === 0) return null;
  async function act(fn: () => Promise<unknown>, done: string) {
    setErr(null);
    try { await fn(); showToast(done); onChanged(); } catch (e) { setErr(e instanceof ApiError ? e.message : "That didn't work."); }
  }
  return (
    <div className="cl-list">
      {err && <Banner kind="error">{err}</Banner>}
      {links.map((l) => (
        <div key={l.id} className={`cl-row ${l.status !== "OK" ? "is-gone" : ""}`}>
          <span className="cl-ico" aria-hidden="true">{l.origin === "COPIED" ? <Cloud size={15} /> : <Link2 size={15} />}</span>
          <div className="cl-main">
            <div className="cl-name">
              {l.webUrl && l.status === "OK"
                ? <a href={l.webUrl} target="_blank" rel="noreferrer noopener" title={`Open in ${PROVIDER_LABEL[l.provider]}`}>{l.name}</a>
                : <span>{l.name}</span>}
            </div>
            <div className="cl-meta">
              <Tag tone={l.origin === "COPIED" ? "cyan" : "accent"} title={l.origin === "COPIED" ? "A CRM document copied to this drive — the original is still stored in the CRM." : "Lives in the drive; this record links to it (no copy is stored in the CRM)."}>
                {l.origin === "COPIED" ? `Copied to ${PROVIDER_LABEL[l.provider]}` : `Linked from ${PROVIDER_LABEL[l.provider]}`}
              </Tag>
              {STATUS_NOTE[l.status] && <Tag tone="danger">{STATUS_NOTE[l.status]}</Tag>}
              <span>{l.ownerName ? `${l.ownerName}'s drive` : "drive"}</span>
              {l.modifiedAt && <span>· modified {fmtDateLocal(l.modifiedAt)}</span>}
              {l.sizeBytes != null && <span>· {humanBytes(l.sizeBytes)}</span>}
            </div>
          </div>
          <div className="cl-actions">
            {l.webUrl && l.status === "OK" && (
              <a className="small-link" href={l.webUrl} target="_blank" rel="noreferrer noopener"><ExternalLink size={13} aria-hidden="true" /> Open</a>
            )}
            {(l.mine || canEdit) && (
              <OverflowMenu ariaLabel={`More for ${l.name}`} items={[
                ...(l.mine && l.status === "OK" ? [{ label: "Download", onClick: () => void downloadThroughApi(`/cloud/links/${l.id}/download`, l.name).catch((e) => setErr(e instanceof Error ? e.message : "Download failed")) }] : []),
                ...(canEdit && folders && folders.length > 1 ? [{ label: "Move to folder…", onClick: () => setMoving(l) }] : []),
                ...(canEdit ? [{ label: "Unlink from this record", danger: true, onClick: () => void act(() => api.del(`/cloud/links/${l.id}`), `Unlinked “${l.name}”. The file is still in the drive.`) }] : []),
              ]} />
            )}
          </div>
        </div>
      ))}
      {moving && folders && (
        <MoveLinkModal link={moving} folders={folders} onClose={() => setMoving(null)}
          onMove={(folder) => { const l = moving; setMoving(null); void act(() => api.patch(`/cloud/links/${l.id}`, { folder }), `Moved to ${folder}.`); }} />
      )}
    </div>
  );
}

function MoveLinkModal({ link, folders, onClose, onMove }: { link: CloudLink; folders: string[]; onClose: () => void; onMove: (f: string) => void }) {
  const [f, setF] = useState(link.folder);
  return (
    <Modal title={`Move “${link.name}”`} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={f === link.folder} onClick={() => onMove(f)}>Move</button></>}>
      <div className="field" style={{ marginBottom: 0 }}><label>Folder</label><Select value={f} onChange={setF} options={folders} ariaLabel="Folder" /></div>
    </Modal>
  );
}

/**
 * Pick files from a drive and either LINK them to the record (no copy) or
 * IMPORT a copy into the CRM's own storage (deals, opportunities, buyers).
 */
export function CloudPickerModal({ account, record, folder, allowImport, onClose, onDone }: {
  account: ConnectedAccount; record: RecordRef; folder: string; allowImport: boolean; onClose: () => void; onDone: () => void;
}) {
  const [picked, setPicked] = useState<Map<string, CloudItem>>(new Map());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const provider = PROVIDER_LABEL[account.provider as "onedrive" | "googledrive"];
  const toggle = (i: CloudItem) => setPicked((m) => { const n = new Map(m); if (n.has(i.id)) n.delete(i.id); else n.set(i.id, i); return n; });
  async function link() {
    setBusy(true); setErr(null);
    try {
      await api.post("/cloud/links", { accountId: account.id, itemIds: [...picked.keys()], record, folder });
      showToast(`Linked ${picked.size} file${picked.size === 1 ? "" : "s"} from ${provider} to ${folder}.`);
      onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Couldn't link the files."); }
    finally { setBusy(false); }
  }
  async function importCopies() {
    setBusy(true); setErr(null);
    let n = 0;
    try {
      for (const id of picked.keys()) { await api.post(`/cloud/${account.id}/import`, { itemId: id, record, folder }); n++; }
      showToast(`Imported a copy of ${n} file${n === 1 ? "" : "s"} into ${folder}.`);
      onDone();
    } catch (e) {
      setErr(`${n ? `${n} imported, then: ` : ""}${e instanceof ApiError ? e.message : "Import failed."}`);
      if (n) onDone();
    } finally { setBusy(false); }
  }
  return (
    <Modal title={`Add from ${provider} · ${account.email ?? ""}`} wide onClose={onClose}
      footer={<>
        <span className="modal-req-note">{picked.size ? `${picked.size} selected` : "Select one or more files"}</span>
        <button onClick={onClose}>Cancel</button>
        {allowImport && <button disabled={!picked.size || busy} onClick={() => void importCopies()} title="Store a copy in the CRM (Google Docs/Sheets/Slides come in as PDF)">Import a copy</button>}
        <button className="primary" disabled={!picked.size || busy} onClick={() => void link()} title="The file stays in the drive; the record links to it">{busy ? "Working…" : `Link to ${folder}`}</button>
      </>}>
      {err && <Banner kind="error">{err}</Banner>}
      <p className="muted cl-pick-note">
        <strong>Link</strong> keeps the file in {provider} — no duplicate, always the current version; teammates open it there with their own access.{" "}
        {allowImport && <><strong>Import a copy</strong> stores a snapshot in the CRM instead.</>}
      </p>
      <CloudBrowser account={account} mode="pick-files" selected={new Set(picked.keys())} onToggle={toggle} />
    </Modal>
  );
}

/** Copy a stored CRM document to one of the member's drives (the original stays in the CRM). */
export function CopyToDriveModal({ account, attachment, onClose, onDone }: {
  account: ConnectedAccount; attachment: { id: string; filename: string }; onClose: () => void; onDone: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflictAt, setConflictAt] = useState<{ id: string | null; name: string } | null>(null);
  const provider = PROVIDER_LABEL[account.provider as "onedrive" | "googledrive"];
  async function copy(parentId: string | null, folderName: string, conflict: "fail" | "rename" = "fail") {
    setBusy(true); setErr(null);
    try {
      await api.post(`/cloud/${account.id}/copy-document`, { attachmentId: attachment.id, parentId, conflict });
      showToast(`Copied “${attachment.filename}” to ${provider} › ${folderName}. The original stays in the CRM.`);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && conflict === "fail") setConflictAt({ id: parentId, name: folderName });
      else setErr(e instanceof ApiError ? e.message : "Copy failed.");
    } finally { setBusy(false); }
  }
  return (
    <Modal title={`Copy “${attachment.filename}” to ${provider}`} wide onClose={onClose}>
      {err && <Banner kind="error">{err}</Banner>}
      {busy && <p className="muted">Copying…</p>}
      <CloudBrowser account={account} mode="pick-folder" pickLabel="Copy here" onPickFolder={(f) => void copy(f.id, f.name)} />
      {conflictAt && (
        <ConfirmDialog
          title="A file with that name is already there"
          message={<p style={{ margin: 0 }}>“{attachment.filename}” already exists in {conflictAt.name}. Nothing was overwritten. Keep both (the copy gets a numbered name)?</p>}
          confirmLabel="Keep both"
          onCancel={() => setConflictAt(null)}
          onConfirm={() => { const c = conflictAt; setConflictAt(null); void copy(c.id, c.name, "rename"); }}
        />
      )}
    </Modal>
  );
}

/** Contacts and buyers have no documents module: a compact "Linked files" panel. */
export function LinkedFilesPanel({ record, canEdit }: { record: RecordRef; canEdit: boolean }) {
  const { links, error, reload } = useRecordLinks(record);
  const accounts = useDriveAccounts(canEdit);
  const [picking, setPicking] = useState<ConnectedAccount | null>(null);
  if (!canEdit && links.length === 0) return null;
  return (
    <div className="panel cl-panel">
      <div className="cl-panel-head">
        <h3>Linked files</h3>
        {canEdit && accounts.map((a) => (
          <button key={a.id} className="small" onClick={() => setPicking(a)} title={a.email ?? undefined}>
            <Cloud size={13} aria-hidden="true" /> {PROVIDER_LABEL[a.provider as "onedrive" | "googledrive"]}
          </button>
        ))}
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {links.length === 0
        ? <p className="muted cl-empty">{accounts.length ? "Link files from your OneDrive or Google Drive." : "Connect OneDrive or Google Drive in Settings → Integrations to link files here."}</p>
        : <CloudLinksList links={links} canEdit={canEdit} onChanged={reload} />}
      {picking && (
        <CloudPickerModal account={picking} record={record} folder="Other" allowImport={false}
          onClose={() => setPicking(null)} onDone={() => { setPicking(null); reload(); }} />
      )}
    </div>
  );
}
