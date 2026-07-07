import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { Banner, ConfirmDialog } from "../components/ui";
import { formatPhone } from "../lib/phone";

/**
 * Buyer Portal settings — enable/disable, marketplace URL, and the multi-contact
 * manager. Lives under Settings (not the Buyer Portal section) so all app
 * configuration sits together.
 */

interface PortalSettings {
  portalSlug: string | null; portalEnabled: boolean;
}
interface PortalContact {
  id: string; name: string; title: string | null; email: string | null;
  phone: string | null; department: string | null; photo: string | null;
  isPrimary: boolean; published: boolean; sortOrder: number;
}

const PHOTO_MAX_BYTES = 512 * 1024;

export function SettingsPortal() {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const flash = (m: string) => { setMsg(m); setErr(null); };
  const fail = (e: unknown) => { setErr(e instanceof ApiError ? e.message : "Something went wrong"); setMsg(null); };

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-header"><h1>Buyer Portal</h1></div>
      {msg && <Banner kind="info">{msg}</Banner>}
      {err && <div className="error-text">{err}</div>}
      <PortalGeneral onFlash={flash} onError={fail} />
      <PortalContacts onFlash={flash} onError={fail} />
    </div>
  );
}

function PortalGeneral({ onFlash, onError }: { onFlash: (m: string) => void; onError: (e: unknown) => void }) {
  const [f, setF] = useState({ enabled: false, slug: "" });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<PortalSettings>("/org/portal-settings").then((d) => {
      setF({ enabled: d.portalEnabled, slug: d.portalSlug ?? "" });
      setLoaded(true);
    }).catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (f.enabled && !f.slug.trim()) { onError(new ApiError(400, "Set a portal URL before enabling the portal.")); return; }
    setBusy(true);
    try {
      await api.patch("/org/portal-settings", {
        enabled: f.enabled,
        ...(f.slug.trim() ? { slug: f.slug.trim().toLowerCase() } : {}),
      });
      onFlash("Portal settings saved.");
    } catch (e2) { onError(e2); }
    finally { setBusy(false); }
  }

  if (!loaded) return <div className="panel"><p className="muted">Loading…</p></div>;
  const url = f.slug ? `${window.location.origin}/portal/${f.slug.trim().toLowerCase()}` : null;

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Marketplace</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        The Buyer Offering Portal is your public marketplace: published deals appear at your portal URL, and buyers can browse,
        filter, view offering pages, and submit their acquisition criteria (which creates buyer leads in the CRM).
      </p>
      <form onSubmit={save} style={{ maxWidth: 520 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF((p) => ({ ...p, enabled: e.target.checked }))} />
          <strong>Portal enabled</strong>
        </label>
        <div className="field">
          <label>Portal URL</label>
          <input value={f.slug} onChange={(e) => setF((p) => ({ ...p, slug: e.target.value }))} placeholder="your-company" />
          {url && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{url}</div>}
        </div>
        <p className="muted" style={{ fontSize: 12 }}>Branding (logo) comes from Settings → General → Company Branding. Deals are published individually from each deal page.</p>
        <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save marketplace settings"}</button>
      </form>
    </div>
  );
}

function PortalContacts({ onFlash, onError }: { onFlash: (m: string) => void; onError: (e: unknown) => void }) {
  const [contacts, setContacts] = useState<PortalContact[] | null>(null);
  const [editing, setEditing] = useState<PortalContact | "new" | null>(null);
  const [deleting, setDeleting] = useState<PortalContact | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<PortalContact[]>("/org/portal-contacts").then(setContacts).catch(onError);
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function move(idx: number, dir: -1 | 1) {
    if (!contacts) return;
    const next = idx + dir;
    if (next < 0 || next >= contacts.length) return;
    const ids = contacts.map((c) => c.id);
    [ids[idx], ids[next]] = [ids[next], ids[idx]];
    setContacts((prev) => { if (!prev) return prev; const a = [...prev]; [a[idx], a[next]] = [a[next], a[idx]]; return a; });
    try { setContacts(await api.post<PortalContact[]>("/org/portal-contacts/reorder", { ids })); }
    catch (e) { onError(e); load(); }
  }

  async function setPrimary(c: PortalContact) {
    try { await api.patch(`/org/portal-contacts/${c.id}`, { isPrimary: true }); await load(); onFlash(`${c.name} is now the primary contact.`); }
    catch (e) { onError(e); }
  }
  async function togglePublish(c: PortalContact) {
    try { await api.patch(`/org/portal-contacts/${c.id}`, { published: !c.published }); await load(); }
    catch (e) { onError(e); }
  }

  return (
    <div className="panel">
      <div className="section-head">
        <h3 style={{ margin: 0 }}>Contacts</h3>
        <span className="muted">Shown on your public offering pages — only published contacts appear</span>
        <button className="primary small" style={{ marginLeft: "auto" }} onClick={() => setEditing("new")}>+ Add Contact</button>
      </div>

      {!contacts ? <p className="muted">Loading…</p> : contacts.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>No contacts yet. Add one so buyers know who to reach on your offering pages.</p>
      ) : (
        <div className="portal-contact-list">
          {contacts.map((c, i) => (
            <div key={c.id} className="portal-contact-row">
              <div className="pcr-order">
                <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up" aria-label="Move up">▲</button>
                <button className="icon-btn" disabled={i === contacts.length - 1} onClick={() => move(i, 1)} title="Move down" aria-label="Move down">▼</button>
              </div>
              <div className="pcr-avatar">
                {c.photo ? <img src={c.photo} alt={c.name} /> : <span>{c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>}
              </div>
              <div className="pcr-body">
                <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{c.name}</strong>
                  {c.isPrimary && <span className="badge">Primary</span>}
                  {!c.published && <span className="badge" style={{ opacity: 0.7 }}>Hidden</span>}
                </div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {[c.title, c.department].filter(Boolean).join(" · ")}
                  {(c.title || c.department) && (c.email || c.phone) ? " — " : ""}
                  {[c.email, c.phone ? formatPhone(c.phone) : null].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div className="pcr-actions">
                {!c.isPrimary && <button className="small" onClick={() => setPrimary(c)}>Make primary</button>}
                <button className="small" onClick={() => togglePublish(c)}>{c.published ? "Unpublish" : "Publish"}</button>
                <button className="small" onClick={() => setEditing(c)}>Edit</button>
                <button className="small danger" onClick={() => setDeleting(c)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ContactEditor
          contact={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); onFlash("Contact saved."); }}
          onError={onError}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Remove contact" danger busy={busy}
          message={<>Remove <strong>{deleting.name}</strong> from your Buyer Portal contacts?</>}
          confirmLabel="Remove"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            setBusy(true);
            try { await api.del(`/org/portal-contacts/${deleting.id}`); setDeleting(null); await load(); onFlash("Contact removed."); }
            catch (e) { onError(e); } finally { setBusy(false); }
          }}
        />
      )}
    </div>
  );
}

function ContactEditor({ contact, onClose, onSaved, onError }: { contact: PortalContact | null; onClose: () => void; onSaved: () => void; onError: (e: unknown) => void }) {
  const [f, setF] = useState({
    name: contact?.name ?? "", title: contact?.title ?? "", email: contact?.email ?? "",
    phone: contact?.phone ?? "", department: contact?.department ?? "",
    photo: contact?.photo ?? null as string | null,
    published: contact?.published ?? true, isPrimary: contact?.isPrimary ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function pickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) { setLocalErr("Photo must be a PNG, JPG, or WebP."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      if ((url.length * 3) / 4 > PHOTO_MAX_BYTES) { setLocalErr("Photo must be under 512 KB."); return; }
      setLocalErr(null);
      setF((p) => ({ ...p, photo: url }));
    };
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!f.name.trim()) { setLocalErr("Name is required."); return; }
    setBusy(true); setLocalErr(null);
    const payload = {
      name: f.name.trim(), title: f.title.trim() || null, email: f.email.trim() || null,
      phone: f.phone.trim() || null, department: f.department.trim() || null,
      photo: f.photo, published: f.published,
      // On create, only send isPrimary when checked — the server auto-promotes
      // the first contact to primary, and an explicit false would defeat that.
      ...(contact || f.isPrimary ? { isPrimary: f.isPrimary } : {}),
    };
    try {
      if (contact) await api.patch(`/org/portal-contacts/${contact.id}`, payload);
      else await api.post("/org/portal-contacts", payload);
      onSaved();
    } catch (e) { onError(e); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>{contact ? "Edit contact" : "Add contact"}</h3><button className="icon-btn" onClick={onClose} aria-label="Close">×</button></div>
        <div className="modal-body">
          {localErr && <div className="error-text">{localErr}</div>}
          <div className="row" style={{ gap: 14, alignItems: "center", marginBottom: 10 }}>
            <div className="pcr-avatar pcr-avatar-lg">
              {f.photo ? <img src={f.photo} alt="" /> : <span>{f.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?"}</span>}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="small" type="button" onClick={() => fileRef.current?.click()}>{f.photo ? "Change photo" : "Add photo"}</button>
              {f.photo && <button className="small" type="button" onClick={() => setF((p) => ({ ...p, photo: null }))}>Remove</button>}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={pickPhoto} />
            </div>
          </div>
          <div className="grid-2">
            <div className="field"><label>Name *</label><input value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} /></div>
            <div className="field"><label>Title</label><input value={f.title} onChange={(e) => setF((p) => ({ ...p, title: e.target.value }))} placeholder="e.g. Land Manager" /></div>
            <div className="field"><label>Email</label><input type="email" value={f.email} onChange={(e) => setF((p) => ({ ...p, email: e.target.value }))} /></div>
            <div className="field"><label>Phone</label><input value={f.phone} onChange={(e) => setF((p) => ({ ...p, phone: e.target.value }))} /></div>
            <div className="field"><label>Department</label><input value={f.department} onChange={(e) => setF((p) => ({ ...p, department: e.target.value }))} placeholder="e.g. Acquisitions" /></div>
          </div>
          <div className="row" style={{ gap: 18, marginTop: 6, flexWrap: "wrap" }}>
            <label className="row" style={{ gap: 8, alignItems: "center" }}><input type="checkbox" checked={f.published} onChange={(e) => setF((p) => ({ ...p, published: e.target.checked }))} /> Published (visible on the portal)</label>
            <label className="row" style={{ gap: 8, alignItems: "center" }}><input type="checkbox" checked={f.isPrimary} onChange={(e) => setF((p) => ({ ...p, isPrimary: e.target.checked }))} /> Primary contact</label>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : contact ? "Save changes" : "Add contact"}</button>
        </div>
      </div>
    </div>
  );
}
