import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Cloud } from "lucide-react";
import { api, ApiError } from "../api/client";
import { Banner, Modal, Spinner, showToast } from "../components/ui";
import { CloudBrowser } from "../components/CloudBrowser";
import { RecordPicker, type RecordHit } from "../components/RecordPicker";
import { PROVIDER_LABEL, type CloudItem } from "../lib/cloud";
import { useConnectedAccounts, usableAccounts } from "../lib/connectedAccounts";

/**
 * Files — the member's own OneDrive and Google Drive, side by side: browse,
 * search, upload, organize, preview, download, and link files to records.
 * Laid out as the design's Files page: title row with the drive switch and
 * the drive actions, then the browser (stat strip, table, inspector) — see
 * components/CloudBrowser.tsx (manage mode).
 */
export function Files() {
  const { data, error } = useConnectedAccounts();
  const drives = useMemo(() => (data ? [...usableAccounts(data.accounts, "onedrive"), ...usableAccounts(data.accounts, "googledrive")] : []), [data]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [linking, setLinking] = useState<CloudItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The browser renders its New folder / Upload buttons into the title row.
  const [toolsSlot, setToolsSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { if (!activeId && drives.length) setActiveId(drives[0].id); }, [drives, activeId]);
  const active = drives.find((d) => d.id === activeId) ?? null;
  const broken = (data?.accounts ?? []).filter((a) => (a.provider === "onedrive" || a.provider === "googledrive") && a.status === "NEEDS_RECONNECT");

  async function link(record: RecordHit) {
    if (!active || !linking) return;
    const items = linking;
    setLinking(null); setErr(null);
    try {
      await api.post("/cloud/links", { accountId: active.id, itemIds: items.map((i) => i.id), record: { type: record.type, id: record.id }, folder: "Other" });
      showToast(items.length === 1 ? `Linked “${items[0].name}” to ${record.name}.` : `Linked ${items.length} files to ${record.name}.`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Couldn't link the file."); }
  }

  if (!data && !error) return <Spinner label="Loading your drives…" />;
  return (
    <div className="page files-page">
      <div className="page-header files-head">
        <div className="files-head-text">
          <div className="files-crumb"><span>Workspace</span><span className="files-crumb-sep">/</span><span className="current">Files</span></div>
          <h1>Files</h1>
          <p className="page-sub">Your cloud drives, organized around the work. Link any file to a deal, asset, contact or buyer — nothing gets copied.</p>
        </div>
        {drives.length > 0 && (
          <div className="files-head-actions">
            <div className="files-sources" role="tablist" aria-label="Drive">
              {drives.map((d) => (
                <button key={d.id} type="button" role="tab" aria-selected={d.id === activeId} className={`files-source ${d.id === activeId ? "active" : ""}`} onClick={() => setActiveId(d.id)} title={d.email ?? undefined}>
                  <i className={d.status === "CONNECTED" ? "ok" : ""} />
                  <span>{PROVIDER_LABEL[d.provider as "onedrive" | "googledrive"]}</span>
                </button>
              ))}
            </div>
            <div className="files-tools" ref={setToolsSlot} />
          </div>
        )}
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {err && <Banner kind="error">{err}</Banner>}
      {broken.map((a) => (
        <Banner key={a.id} kind="error">{a.providerName} ({a.email ?? "account"}) needs to be reconnected. <Link to="/settings/integrations">Reconnect in Settings → Integrations</Link>.</Banner>
      ))}
      {drives.length === 0 ? (
        <div className="panel files-empty">
          <Cloud size={22} aria-hidden="true" />
          <h3>Connect a drive</h3>
          <p className="muted">Connect your OneDrive or Google Drive in <Link to="/settings/integrations">Settings → Integrations</Link> to browse and link files here.</p>
        </div>
      ) : (
        active && <CloudBrowser key={active.id} account={active} mode="manage" onLinkItem={(i) => setLinking([i])} onLinkItems={setLinking} toolsSlot={toolsSlot} />
      )}
      {linking && (
        <Modal title={linking.length === 1 ? `Link “${linking[0].name}” to a record` : `Link ${linking.length} files to a record`} onClose={() => setLinking(null)}>
          <p className="muted" style={{ marginTop: 0 }}>{linking.length === 1 ? "The file stays" : "The files stay"} in your drive; the record gets a link (under Documents › Other, or Linked files).</p>
          <RecordPicker onPick={(r) => void link(r)} />
        </Modal>
      )}
    </div>
  );
}
