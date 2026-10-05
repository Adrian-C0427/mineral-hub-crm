import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { fmtDateTime } from "../lib/format";
import { ConfirmDialog } from "./ui";

interface Notification { id: string; type: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }

const POLL_MS = 60_000;

/** Tile tone + icon per notification type; unknown types fall back to the bell. */
const TYPE_STYLE: Record<string, { tone: "danger" | "accent" | "warn" | "success"; d: string }> = {
  deal_overdue: { tone: "danger", d: "M12 8v5M12 16.5h.01M10.3 4.3L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" },
  task_due: { tone: "accent", d: "M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" },
  task_assigned: { tone: "accent", d: "M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" },
  follow_up_due: { tone: "warn", d: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 8v4l2.5 2" },
  portal_lead: { tone: "success", d: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M21 20c0-2.6-1.6-4.9-4-5.7" },
  portal_offer: { tone: "success", d: "M4 8h16v11H4zM9 8V5h6v3M4 13h16" },
  email_reply: { tone: "accent", d: "M4 6h16v12H4zM4 7l8 6 8-6" },
};
const BELL_PATHS = ["M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15L6 16z", "M10 20.5a2 2 0 0 0 4 0"];

/** Compact age ("6h", "5d") — the full date and time stay on hover. */
function age(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  return days < 7 ? `${days}d` : `${Math.round(days / 7)}w`;
}

function dayGroup(iso: string): "Today" | "Yesterday" | "Earlier" {
  const d = new Date(iso); const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return "Today";
  if (d.getTime() >= start - 86_400_000) return "Yesterday";
  return "Earlier";
}

/**
 * Persistent notifications bell in the top bar. Shows the unread count from
 * every page and opens a panel listing recent notifications (read + unread),
 * grouped by day, with one-click navigation.
 */
export function NotificationsBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [confirmClear, setConfirmClear] = useState(false);
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

  // Close on outside click / Escape. Paused while the clear-all confirmation is
  // up: it renders outside the panel and handles its own Escape.
  useEffect(() => {
    if (!open || confirmClear) return;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, confirmClear]);

  // Clearing updates the list and badge right away; the reload afterwards
  // brings in older rows past the 50 shown (and restores the list on failure).
  function clearOne(n: Notification) {
    setItems((list) => list.filter((x) => x.id !== n.id));
    if (!n.readAt) setUnread((u) => Math.max(0, u - 1));
    void api.del(`/notifications/${n.id}`).catch(() => {}).then(load);
  }
  function clearAll() {
    setConfirmClear(false);
    setItems([]);
    setUnread(0);
    void api.del("/notifications").catch(() => {}).then(load);
  }

  async function openItem(n: Notification) {
    if (!n.readAt) await api.post(`/notifications/${n.id}/read`, {}).catch(() => {});
    setOpen(false);
    void load();
    if (n.link) nav(n.link);
  }

  const unreadItems = useMemo(() => items.filter((n) => !n.readAt), [items]);
  const shown = tab === "unread" ? unreadItems : items;
  const groups = useMemo(() => {
    const out: { label: string; rows: Notification[] }[] = [];
    for (const n of shown) {
      const label = dayGroup(n.createdAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(n); else out.push({ label, rows: [n] });
    }
    return out;
  }, [shown]);

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`notif-bell ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        aria-expanded={open}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {BELL_PATHS.map((d) => <path key={d} d={d} />)}
        </svg>
        {unread > 0 && <span className="notif-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <span className="notif-head-title">Notifications</span>
            {unread > 0 && (
              <button type="button" className="notif-markall" onClick={() => api.post("/notifications/read-all", {}).then(load)}>Mark all read</button>
            )}
            {items.length > 0 && (
              <button type="button" className="notif-markall" onClick={() => (unread > 0 ? setConfirmClear(true) : clearAll())}>Clear all</button>
            )}
            <button type="button" className="notif-gear" title="Notification settings" aria-label="Notification settings"
              onClick={() => { setOpen(false); nav("/settings/general"); }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" /></svg>
            </button>
          </div>
          <div className="notif-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "all"} className={`notif-tab ${tab === "all" ? "active" : ""}`} onClick={() => setTab("all")}>All <span>{items.length}</span></button>
            <button type="button" role="tab" aria-selected={tab === "unread"} className={`notif-tab ${tab === "unread" ? "active" : ""}`} onClick={() => setTab("unread")}>Unread <span>{unreadItems.length}</span></button>
          </div>
          <div className="notif-list">
            {shown.length === 0 ? (
              <div className="notif-empty">
                <strong>You're all caught up</strong>
                <span>{tab === "unread" ? "No unread notifications." : "Nothing yet — portal leads and alerts show up here."}</span>
              </div>
            ) : groups.map((g) => (
              <div key={g.label}>
                <div className="notif-day">{g.label}</div>
                {g.rows.map((n) => {
                  const ts = TYPE_STYLE[n.type];
                  return (
                    <div key={n.id} className="notif-row">
                      <button type="button" className={`notif-item ${n.readAt ? "" : "unread"}`} onClick={() => void openItem(n)}>
                        <span className={`notif-tile tone-${ts?.tone ?? "accent"}`} aria-hidden="true">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                            {ts ? <path d={ts.d} /> : BELL_PATHS.map((d) => <path key={d} d={d} />)}
                          </svg>
                        </span>
                        <span className="notif-text">
                          <span className="notif-title">{n.title}</span>
                          {n.body && <span className="notif-body">{n.body}</span>}
                        </span>
                        <span className="notif-side">
                          <span className="notif-time" title={fmtDateTime(n.createdAt)}>{age(n.createdAt)}</span>
                          <span className="notif-dot" />
                        </span>
                      </button>
                      <button type="button" className="notif-clear" title="Clear" aria-label={`Clear notification: ${n.title}`} onClick={() => clearOne(n)}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
      {confirmClear && (
        <ConfirmDialog
          danger
          title="Clear all notifications?"
          message={`${unread} unread notification${unread === 1 ? "" : "s"} will be removed along with the rest. This cannot be undone.`}
          confirmLabel="Clear all"
          onCancel={() => setConfirmClear(false)}
          onConfirm={clearAll}
        />
      )}
    </div>
  );
}
