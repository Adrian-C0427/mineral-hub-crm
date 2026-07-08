import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BellIcon } from "./NavIcons";
import { api } from "../api/client";
import { fmtDate } from "../lib/format";

interface Notification { id: string; type: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }

const POLL_MS = 60_000;

/**
 * Persistent notifications bell (sidebar). Portal leads previously surfaced
 * only on the Dashboard panel — anywhere else in the app they were invisible.
 * The bell shows an unread count from every page and opens a dropdown listing
 * recent notifications (read + unread) with one-click navigation.
 */
export function NotificationsBell({ collapsed }: { collapsed: boolean }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  const load = () =>
    api.get<{ notifications: Notification[]; unread: number }>("/notifications")
      .then((d) => { setItems(d.notifications); setUnread(d.unread); })
      .catch(() => {});

  useEffect(() => {
    void load();
    const t = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(t);
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  async function openItem(n: Notification) {
    if (!n.readAt) await api.post(`/notifications/${n.id}/read`, {}).catch(() => {});
    setOpen(false);
    void load();
    if (n.link) nav(n.link);
  }

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        className="icon-btn notif-bell"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
      >
        <BellIcon size={16} />
        {unread > 0 && <span className="notif-badge">{unread > 99 ? "99+" : unread}</span>}
        {!collapsed && <span className="notif-label">Notifications</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button className="small" onClick={() => api.post("/notifications/read-all", {}).then(load)}>Mark all read</button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="muted" style={{ padding: "10px 12px", margin: 0 }}>Nothing yet — portal leads and alerts show up here.</p>
          ) : items.map((n) => (
            <button key={n.id} className={`notif-item ${n.readAt ? "" : "unread"}`} onClick={() => void openItem(n)}>
              <span className="notif-title">{n.title}</span>
              {n.body && <span className="notif-body">{n.body}</span>}
              <span className="notif-time">{fmtDate(n.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
