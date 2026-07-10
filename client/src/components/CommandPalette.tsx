import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Briefcase, Users, Layers, CornerDownLeft } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { NAV } from "./Sidebar";
import type { DealSummary } from "../types";

/**
 * Global search / command palette (⌘K / Ctrl+K). One box that reaches every
 * deal, buyer, and mineral asset by name plus every page in the app — from
 * anywhere, without touching the mouse. Records load once per open (two list
 * calls) and are filtered client-side; at CRM scale that's instant and keeps
 * the server surface unchanged.
 */

interface BuyerLite { id: string; companyName: string; contactName: string | null }
interface Hit {
  group: "Navigate" | "Deals" | "Buyers" | "Assets";
  label: string;
  sub?: string;
  to: string;
  icon: "nav" | "deal" | "buyer" | "asset";
}

const GROUP_ORDER: Hit["group"][] = ["Deals", "Buyers", "Assets", "Navigate"];
const MAX_PER_GROUP = 6;

function flattenNav(can: (p: string) => boolean): { label: string; to: string }[] {
  const out: { label: string; to: string }[] = [];
  for (const item of NAV) {
    if (item.perm && !can(item.perm)) continue;
    if (item.to) out.push({ label: item.label, to: item.to });
    for (const c of item.children ?? []) {
      if (c.perm && !can(c.perm)) continue;
      if (c.to) out.push({ label: c.children ? c.label : `${item.label} › ${c.label}`.replace(/^([^›]+) › \1$/, "$1"), to: c.to });
    }
  }
  return out;
}

export function CommandPalette() {
  const { user, can } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [deals, setDeals] = useState<DealSummary[] | null>(null);
  const [buyers, setBuyers] = useState<BuyerLite[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => { setOpen(false); setQ(""); setActive(0); }, []);

  // ⌘K / Ctrl+K toggles from anywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        e.stopPropagation();
        close();
      }
    };
    const onOpenEvent = () => setOpen(true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("mh:palette", onOpenEvent);
    return () => { document.removeEventListener("keydown", onKey, true); window.removeEventListener("mh:palette", onOpenEvent); };
  }, [open, close]);

  // Load the searchable records once per open; permission-gated like the nav.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    if (deals == null && can("viewDeals")) api.get<DealSummary[]>("/deals").then(setDeals).catch(() => setDeals([]));
    if (buyers == null && can("viewBuyers")) api.get<BuyerLite[]>("/buyers").then(setBuyers).catch(() => setBuyers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Fresh data next time the palette opens after navigation-heavy work.
  useEffect(() => { if (!open) { setDeals(null); setBuyers(null); } }, [open]);

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase();
    const match = (s: string | null | undefined) => !!s && s.toLowerCase().includes(needle);
    const rank = (s: string) => (s.toLowerCase().startsWith(needle) ? 0 : 1);

    const out: Hit[] = [];
    if (needle) {
      for (const d of (deals ?? [])) {
        if (!match(d.name)) continue;
        const isAsset = d.recordType === "OWNED_ASSET";
        out.push({
          group: isAsset ? "Assets" : "Deals",
          label: d.name,
          sub: isAsset ? (d.assetMode === "SELL" ? "For sale" : "Held") : undefined,
          to: isAsset ? `/assets/${d.id}` : `/deals/${d.id}`,
          icon: isAsset ? "asset" : "deal",
        });
      }
      for (const b of (buyers ?? [])) {
        if (!match(b.companyName) && !match(b.contactName)) continue;
        out.push({ group: "Buyers", label: b.companyName, sub: b.contactName ?? undefined, to: `/buyers/${b.id}`, icon: "buyer" });
      }
    }
    for (const n of flattenNav(can)) {
      if (needle && !n.label.toLowerCase().includes(needle)) continue;
      out.push({ group: "Navigate", label: n.label, to: n.to, icon: "nav" });
    }

    // Group, rank prefix matches first, cap each group.
    const grouped: Hit[] = [];
    for (const g of GROUP_ORDER) {
      const inGroup = out.filter((h) => h.group === g);
      if (needle) inGroup.sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
      grouped.push(...inGroup.slice(0, MAX_PER_GROUP));
    }
    return grouped;
  }, [q, deals, buyers, can]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelectorAll<HTMLElement>(".cp-hit")[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function go(h: Hit) { close(); nav(h.to); }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && hits[active]) { e.preventDefault(); go(hits[active]); }
  }

  if (!user || !open) return null;

  const loading = q.trim() !== "" && (deals == null || buyers == null);
  let lastGroup: string | null = null;

  return (
    <div className="cp-overlay" onClick={close}>
      <div className="cp" role="dialog" aria-label="Global search" onClick={(e) => e.stopPropagation()}>
        <div className="cp-input-row">
          <Search size={16} aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search deals, buyers, assets — or jump to a page…"
            aria-label="Search"
          />
          <kbd>esc</kbd>
        </div>
        <div className="cp-list" ref={listRef} role="listbox">
          {loading && <div className="cp-empty">Searching…</div>}
          {!loading && hits.length === 0 && <div className="cp-empty">No matches for “{q.trim()}”.</div>}
          {hits.map((h, i) => {
            const header = h.group !== lastGroup ? h.group : null;
            lastGroup = h.group;
            return (
              <div key={`${h.group}-${h.to}-${h.label}`}>
                {header && <div className="cp-group">{header}</div>}
                <div
                  className={`cp-hit ${i === active ? "active" : ""}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(h)}
                >
                  {h.icon === "deal" && <Briefcase size={14} aria-hidden />}
                  {h.icon === "buyer" && <Users size={14} aria-hidden />}
                  {h.icon === "asset" && <Layers size={14} aria-hidden />}
                  {h.icon === "nav" && <CornerDownLeft size={14} aria-hidden />}
                  <span className="cp-hit-label">{h.label}</span>
                  {h.sub && <span className="cp-hit-sub">{h.sub}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>⌘K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}
