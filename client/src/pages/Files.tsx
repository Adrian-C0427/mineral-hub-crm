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
 */
export function Files() {
  const { data, error } = useConnectedAccounts();
  const drives = useMemo(() => (data ? [...usableAccounts(data.accounts, "onedrive"), ...usableAccounts(data.accounts, "googledrive")] : []), [data]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [linking, setLinking] = useState<CloudItem | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!activeId && drives.length) setActiveId(drives[0].id); }, [drives, activeId]);
  const active = drives.find((d) => d.id === activeId) ?? null;
  const broken = (data?.accounts ?? []).filter((a) => (a.provider === "onedrive" || a.provider === "googledrive") && a.status === "NEEDS_RECONNECT");

  async function link(record: RecordHit) {
    if (!active || !linking) return;
    const item = linking;
    setLinking(null); setErr(null);
    try {
      await api.post("/cloud/links", { accountId: active.id, itemIds: [item.id], record: { type: record.type, id: record.id }, folder: "Other" });
      showToast(`Linked “${item.name}” to ${record.name}.`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Couldn't link the file."); }
  }

  if (!data && !error) return <Spinner label="Loading your drives…" />;
  return (
    <div className="page files-page">
      <div className="page-header">
        <div>
          <h1>Files</h1>
          <div className="page-sub">Your OneDrive and Google Drive — organize files and link them to deals, assets, opportunities, contacts and buyers without copying them.</div>
        </div>
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
        <div className="panel files-panel">
          {drives.length > 1 && (
            <div className="files-tabs" role="tablist" aria-label="Drive">
              {drives.map((d) => (
                <button key={d.id} type="button" role="tab" aria-selected={d.id === activeId} className={`files-tab ${d.id === activeId ? "active" : ""}`} onClick={() => setActiveId(d.id)}>
                  {PROVIDER_LABEL[d.provider as "onedrive" | "googledrive"]} <span className="files-tab-acct">{d.email}</span>
                </button>
              ))}
            </div>
          )}
          {active && <CloudBrowser key={active.id} account={active} mode="manage" onLinkItem={setLinking} />}
        </div>
      )}
      {linking && (
        <Modal title={`Link “${linking.name}” to a record`} onClose={() => setLinking(null)}>
          <p className="muted" style={{ marginTop: 0 }}>The file stays in your drive; the record gets a link to it (under Documents › Other, or Linked files).</p>
          <RecordPicker onPick={(r) => void link(r)} />
        </Modal>
      )}
    </div>
  );
}
