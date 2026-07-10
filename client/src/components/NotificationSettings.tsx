import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { showToast } from "./ui";
import { Toggle } from "./Toggle";

interface PrefType { key: string; label: string; description: string }

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
  return (
    <div className="panel">
      <h3>Notifications</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Choose which events reach your notification bell. Turning a type off hides it (and its unread count)
        for you only — nothing is deleted, and other teammates keep their own settings.
      </p>
      <div className="notif-pref-list">
        {types.map((t) => (
          <div className="notif-pref-row" key={t.key}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ fontSize: 13.5 }}>{t.label}</strong>
              <div className="muted" style={{ fontSize: 12 }}>{t.description}</div>
            </div>
            <Toggle checked={!muted.has(t.key)} onChange={(on) => void toggle(t.key, on)} ariaLabel={`${t.label} notifications`} />
          </div>
        ))}
      </div>
    </div>
  );
}
