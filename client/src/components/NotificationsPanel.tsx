import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { fmtDate } from "../lib/format";

interface Notification { id: string; type: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }

/**
 * Dashboard notifications — portal leads land here so new buyers get a
 * follow-up prompt the moment someone opens the CRM. Hidden when empty.
 */
export function NotificationsPanel() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  const load = () =>
    api.get<{ notifications: Notification[]; unread: number }>("/notifications?unread=1")
      .then((d) => { setItems(d.notifications); setUnread(d.unread); })
      .catch(() => {});
  useEffect(() => { void load(); }, []);

  async function markRead(id: string) {
    await api.post(`/notifications/${id}/read`, {}).catch(() => {});
    void load();
  }

  if (!items.length) return null;
  return (
    <div className="panel" style={{ borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))" }}>
      <div className="section-head">
        <h3 style={{ margin: 0 }}>🔔 New buyer leads ({unread})</h3>
        <button className="small" onClick={() => api.post("/notifications/read-all", {}).then(load)}>Mark all read</button>
      </div>
      {items.map((n) => (
        <div key={n.id} className="row" style={{ justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <strong>{n.title}</strong>
            {n.body && <div className="muted" style={{ fontSize: 13 }}>{n.body}</div>}
            <div className="muted" style={{ fontSize: 12 }}>{fmtDate(n.createdAt)} · Follow up with this buyer</div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {n.link && <Link to={n.link} onClick={() => void markRead(n.id)}><button className="small primary">Open buyer profile</button></Link>}
            <button className="small" onClick={() => void markRead(n.id)}>Dismiss</button>
          </div>
        </div>
      ))}
    </div>
  );
}
