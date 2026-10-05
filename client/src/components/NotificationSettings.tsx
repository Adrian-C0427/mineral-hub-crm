import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { showToast } from "./ui";
import { Toggle } from "./Toggle";
import { SettingsCardHead } from "./SettingsNav";

interface PrefType { key: string; label: string; description: string }

const GROUP_OF: Record<string, string> = {
  portal_lead: "Buyer portal", portal_offer: "Buyer portal",
  email_reply: "Email",
  deal_overdue: "Deals & tasks", follow_up_due: "Deals & tasks", task_due: "Deals & tasks",
};
const GROUP_ORDER = ["Buyer portal", "Email", "Deals & tasks"];
const groupRank = (label: string) => { const i = GROUP_ORDER.indexOf(label); return i < 0 ? GROUP_ORDER.length : i; };

/**
 * Per-user notification preferences (Settings → General). Muting a type hides
 * it from the bell and its unread count on every device; nothing is deleted,
 * so turning a type back on restores its history instantly. Saves on toggle —
 * no Save button to forget.
 */
export function NotificationSettings() {
  const [types, setTypes] = useState<PrefType[]>([]);
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.get<{ types: PrefType[]; mutedTypes: string[] }>("/notifications/preferences")
      .then((d) => { setTypes(d.types); setMuted(new Set(d.mutedTypes)); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  async function toggle(key: string, enabled: boolean) {
    const next = new Set(muted);
    if (enabled) next.delete(key); else next.add(key);
    const prev = muted;
    setMuted(next);
    try {
      await api.put("/notifications/preferences", { mutedTypes: [...next] });
    } catch (e) {
      setMuted(prev); // roll back on failure
      showToast(e instanceof ApiError ? e.message : "Could not save preferences", "error");
    }
  }

  if (!loaded || types.length === 0) return null;

  // Presentation-only grouping of the server's type list (server order kept
  // inside each group; unknown types land in "Other").
  const groups: { label: string; items: PrefType[] }[] = [];
  for (const t of types) {
    const label = GROUP_OF[t.key] ?? "Other";
    let g = groups.find((x) => x.label === label);
    if (!g) { g = { label, items: [] }; groups.push(g); }
    g.items.push(t);
  }
  groups.sort((a, b) => groupRank(a.label) - groupRank(b.label));
  const onCount = types.filter((t) => !muted.has(t.key)).length;

  return (
    <section className="panel notif-card">
      <SettingsCardHead
        title="Notifications"
        desc="Choose which events reach your notification bell. Turning a type off hides it (and its unread count) for you only — nothing is deleted, and other teammates keep their own settings."
        aside={<span className="set-meta">{onCount} of {types.length} on</span>}
      />
      {groups.map((g) => (
        <div className="notif-pref-group" key={g.label}>
          <span className="notif-pref-group-label">{g.label}</span>
          <div className="notif-pref-list">
            {g.items.map((t) => (
              <div className="notif-pref-row" key={t.key}>
                <div className="notif-pref-text">
                  <strong>{t.label}</strong>
                  <span>{t.description}</span>
                </div>
                <Toggle checked={!muted.has(t.key)} onChange={(on) => void toggle(t.key, on)} ariaLabel={`${t.label} notifications`} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
