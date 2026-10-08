import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell,
} from "recharts";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Spinner, Banner, Modal, ConfirmDelete, ConfirmDialog } from "../components/ui";
import { StatStrip, Avatar, Tag, FormSection } from "../components/kit";
import { Select } from "../components/Select";
import { Toggle } from "../components/Toggle";
import { compactMoney, money, fmtDate, toInputDate } from "../lib/format";
import { downloadCsv } from "../lib/csv";
import { CHART_COLORS, monthLabel, chartTooltip } from "../lib/charts";
import type { UserLite } from "../types";
import { MoneyInput } from "../components/MoneyInput";
import { DateField } from "../components/DateField";

interface Category { id: string; name: string; active: boolean; color?: string | null; expenseCount?: number }
interface Expense {
  id: string; date: string; amount: number; notes: string | null;
  reimbursed: boolean; reimbursementDate: string | null;
  categoryId: string | null; categoryName: string | null;
  userId: string | null; userName: string | null; userAvatarColor?: string | null; createdAt: string;
}
interface Dashboard {
  totals: { totalExpenses: number; totalReimbursed: number; totalOutstanding: number; companyOutstanding: number; count: number; outstandingCount?: number };
  byCategory: { name: string; amount: number }[];
  byMonth: { month: string; expenses: number; reimbursed: number }[];
  byUser: { userId: string; name: string; total: number; outstanding: number; outstandingCount?: number }[];
  outstandingByUser: { userId: string; name: string; outstanding: number }[];
}

const EMPTY_FORM = { date: toInputDate(new Date()), amount: "", categoryId: "", notes: "", reimbursed: false, reimbursementDate: "" };

/** Position colour — the category's place in the org's list picks a palette
 *  entry. This is the fallback for a category with no saved colour. */
function catPositionColor(name: string | null | undefined, categories: Category[]): string {
  if (!name) return "var(--ink-3)";
  const i = categories.findIndex((c) => c.name === name);
  return i >= 0 ? CHART_COLORS[i % CHART_COLORS.length] : "var(--ink-3)";
}

/** Per-category accent color — same everywhere (donut, legend, table chips,
 *  category manager). The colour saved on the category wins; a category
 *  without one keeps its position colour. */
function catColorFor(name: string | null | undefined, categories: Category[]): string {
  const saved = name ? categories.find((c) => c.name === name)?.color : null;
  return saved && /^#[0-9a-f]{6}$/i.test(saved) ? saved : catPositionColor(name, categories);
}

/** Compact axis money: $950, $1.2K, $14K. */
const axisMoney = (v: number): string => compactMoney(v, { kDigits: (a) => (a >= 10000 ? 0 : 1), minus: "−" });

/** "1 expense" / "3 expenses". */
const countNoun = (n: number): string => `${n} expense${n === 1 ? "" : "s"}`;

const ICON = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function Expenses() {
  const { user } = useAuth();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Filters
  const [filters, setFilters] = useState({ from: "", to: "", userId: "", categoryId: "", reimbursed: "" });

  // Selection for bulk actions
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Standard delete-confirmation modal state for bulk expense deletion.
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Modals
  const [editing, setEditing] = useState<Expense | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showCats, setShowCats] = useState(false);

  const query = useMemo(() => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
    return qs.toString();
  }, [filters]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get<Expense[]>(`/expenses${query ? `?${query}` : ""}`),
      api.get<Dashboard>(`/expenses/dashboard${query ? `?${query}` : ""}`),
      api.get<Category[]>("/expenses/categories"),
      api.get<UserLite[]>("/users"),
    ])
      .then(([ex, d, cats, us]) => { setExpenses(ex); setDash(d); setCategories(cats); setUsers(us); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Failed to load expenses"))
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSelected(new Set()); }, [query]);

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function bulk(action: string, categoryId?: string) {
    if (selected.size === 0) return;
    // Deletion routes through the standard confirmation modal (below) rather
    // than a native confirm(), for a consistent look with the rest of the app.
    if (action === "delete") { setPendingDelete(true); return; }
    try {
      await api.post("/expenses/bulk", { ids: [...selected], action, categoryId });
      load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Bulk action failed"); }
  }
  async function confirmBulkDelete() {
    setDeleting(true);
    try {
      await api.post("/expenses/bulk", { ids: [...selected], action: "delete" });
      setPendingDelete(false); setSelected(new Set()); load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Bulk action failed"); }
    finally { setDeleting(false); }
  }

  function exportSelected() {
    const rows = expenses.filter((e) => selected.size === 0 || selected.has(e.id));
    downloadCsv(
      `expenses-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Date", "User", "Amount", "Category", "Reimbursed", "Reimbursement Date", "Notes"],
      rows.map((e) => [
        toInputDate(e.date), e.userName ?? "", e.amount, e.categoryName ?? "",
        e.reimbursed ? "Yes" : "No", e.reimbursementDate ? toInputDate(e.reimbursementDate) : "", e.notes ?? "",
      ]),
    );
  }

  if (loading && !dash) return <Spinner label="Loading expenses…" />;

  // The dashboard follows the date filter, so the charts say which window they show.
  const scopeLabel = filters.from || filters.to ? "In range" : "All time";

  return (
    <div className="page xp-page">
      <div className="page-header">
        <div>
          <h1>Expenses</h1>
          <div className="page-sub">Team spend &amp; reimbursements</div>
        </div>
        <div className="xp-actions">
          <button onClick={() => setShowCats(true)}>
            <svg {...ICON}><path d="M4 6h16M4 12h16M4 18h10" /></svg>
            Manage categories
          </button>
          <button onClick={exportSelected} title="Exports the selected rows, or every loaded row when nothing is selected">
            <svg {...ICON}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            Export CSV
          </button>
          <button className="primary" onClick={() => { setEditing(null); setShowForm(true); }}>
            <svg {...ICON} strokeWidth={2.2}><path d="M12 5v14M5 12h14" /></svg>
            New expense
          </button>
        </div>
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      {dash && (
        <StatStrip
          className="xp-stats"
          min={220}
          cells={[
            { label: "Total expenses", value: money(dash.totals.totalExpenses, { cents: true }), sub: `${dash.totals.count} records` },
            {
              label: "Total reimbursed", value: money(dash.totals.totalReimbursed, { cents: true }), tone: "success",
              sub: dash.totals.totalExpenses > 0 ? `${((dash.totals.totalReimbursed / dash.totals.totalExpenses) * 100).toFixed(1)}% of spend` : undefined,
            },
            {
              label: "Outstanding reimbursements", value: money(dash.totals.totalOutstanding, { cents: true }),
              tone: dash.totals.totalOutstanding > 0 ? "warn" : "default",
              sub: dash.totals.outstandingCount != null ? `${countNoun(dash.totals.outstandingCount)} awaiting payout` : "Awaiting payout",
            },
            { label: "Company outstanding balance", value: money(dash.totals.companyOutstanding, { cents: true }), sub: "Owed to team" },
          ]}
        />
      )}

      {dash && (
        <div className="xp-charts">
          <section className="panel xp-card">
            <div className="xp-card-head"><h3>By month</h3><span>{scopeLabel}</span></div>
            {dash.byMonth.length === 0 ? (
              <ChartEmpty icon={<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>}>
                No expenses yet — data appears here as you log spend
              </ChartEmpty>
            ) : (
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={dash.byMonth.map((m) => ({ ...m, label: monthLabel(m.month) }))} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--line-faint)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--ink-4)" }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={axisMoney} tick={{ fontSize: 11, fill: "var(--ink-4)" }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip {...chartTooltip} cursor={{ fill: "var(--chart-col-hover)" }} formatter={(v: number) => money(v, { cents: true })} />
                  <Bar dataKey="expenses" name="Expenses" fill="var(--accent)" radius={[4, 4, 1, 1]} maxBarSize={34} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </section>

          <section className="panel xp-card">
            <div className="xp-card-head"><h3>By category</h3><span>{scopeLabel}</span></div>
            {dash.byCategory.length === 0 ? (
              <ChartEmpty icon={<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21.21 15.89A10 10 0 118 2.83" /><path d="M22 12A10 10 0 0012 2v10z" /></svg>}>
                No categories to chart yet
              </ChartEmpty>
            ) : (() => {
              const catTotal = dash.byCategory.reduce((s, c) => s + c.amount, 0);
              return (
                <div className="xp-donut-wrap">
                  <div className="xp-donut">
                    <PieChart width={130} height={130}>
                      <Pie data={dash.byCategory} dataKey="amount" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={64} paddingAngle={1} stroke="none" isAnimationActive={false}>
                        {dash.byCategory.map((c, i) => <Cell key={i} fill={catColorFor(c.name, categories)} />)}
                      </Pie>
                      <Tooltip {...chartTooltip} formatter={(v: number) => money(v, { cents: true })} />
                    </PieChart>
                    <div className="xp-donut-center" aria-hidden="true">
                      <div className="xp-donut-total">{money(catTotal)}</div>
                      <div className="xp-donut-sub">{scopeLabel}</div>
                    </div>
                  </div>
                  <div className="xp-donut-legend">
                    {dash.byCategory.map((c) => (
                      <div className="xp-leg-row" key={c.name}>
                        <span className="xp-leg-dot" style={{ background: catColorFor(c.name, categories) }} />
                        <span className="xp-leg-name">{c.name}</span>
                        <span className="xp-leg-amt">{money(c.amount)}</span>
                        <span className="xp-leg-pct">{catTotal > 0 ? Math.round((c.amount / catTotal) * 100) : 0}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </section>

          <section className="panel xp-card">
            <div className="xp-card-head"><h3>Outstanding by team member</h3><span>Awaiting payout</span></div>
            {dash.byUser.length === 0 ? (
              <ChartEmpty icon={<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /></svg>}>
                No spend recorded by teammates
              </ChartEmpty>
            ) : (() => {
              const rows = [...dash.byUser].sort((a, b) => b.outstanding - a.outstanding);
              const max = Math.max(0, ...rows.map((u) => u.outstanding));
              return (
                <div className="xp-owed">
                  {rows.map((u) => {
                    const lite = users.find((x) => x.id === u.userId);
                    return (
                      <div className="xp-owed-row" key={u.userId}>
                        <div className="xp-owed-top">
                          <span className="xp-owed-name"><Avatar user={lite ?? null} name={u.name} size={22} />{u.name}</span>
                          <span className={`xp-owed-amt ${u.outstanding > 0 ? "warn" : ""}`}>{money(u.outstanding, { cents: true })}</span>
                        </div>
                        <span className="xp-owed-bar"><i style={{ width: max > 0 ? `${(u.outstanding / max) * 100}%` : 0 }} /></span>
                        <span className="xp-owed-sub">{u.outstandingCount ? `${countNoun(u.outstandingCount)} awaiting payout` : u.outstanding > 0 ? "Awaiting payout" : "Nothing outstanding"}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </section>
        </div>
      )}

      <AllExpenses
        expenses={expenses}
        categories={categories}
        users={users}
        filters={filters}
        setFilters={setFilters}
        selected={selected}
        toggle={toggle}
        setSelected={setSelected}
        bulk={bulk}
        onEdit={(e) => { setEditing(e); setShowForm(true); }}
        onNew={() => { setEditing(null); setShowForm(true); }}
      />

      {showForm && (
        <ExpenseForm
          expense={editing}
          categories={categories}
          currentUserName={editing?.userName ?? user?.name ?? ""}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); load(); }}
        />
      )}
      {showCats && (
        <CategoryManager categories={categories} onClose={() => setShowCats(false)} onChanged={load} />
      )}
      {pendingDelete && (
        <ConfirmDelete
          count={selected.size}
          itemLabel="expense"
          busy={deleting}
          onCancel={() => setPendingDelete(false)}
          onConfirm={confirmBulkDelete}
        />
      )}
    </div>
  );
}

/** Centered icon + message shown when a chart has no data (per design). */
function ChartEmpty({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="chart-empty">
      {icon}
      <span>{children}</span>
    </div>
  );
}

/** Closes a popover on outside mousedown or Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, ref, close]);
}

// ---------------------------------------------------------------------------
// All Expenses — month-grouped ledger with search, presets, column control,
// bulk actions, and running totals that track the active filters.
// ---------------------------------------------------------------------------

type Filters = { from: string; to: string; userId: string; categoryId: string; reimbursed: string };
type Preset = { name: string; filters: Filters; q: string };

const ALL_COLUMNS = [
  ["date", "Date"], ["user", "User"], ["category", "Category"], ["amount", "Amount"],
  ["status", "Status"], ["reimbursementDate", "Reimbursed on"], ["notes", "Notes"],
] as const;
type ColKey = (typeof ALL_COLUMNS)[number][0];
const DEFAULT_COLS: ColKey[] = ["date", "user", "category", "amount", "status", "notes"];
const COLS_KEY = "mh_exp_cols";
const PRESETS_KEY = "mh_exp_presets";
const MONTHS_PAGE = 6;

function loadJson<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
}

function AllExpenses({
  expenses, categories, users, filters, setFilters, selected, toggle, setSelected, bulk, onEdit, onNew,
}: {
  expenses: Expense[];
  categories: Category[];
  users: UserLite[];
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  selected: Set<string>;
  toggle: (id: string) => void;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  bulk: (action: string, categoryId?: string) => void;
  onEdit: (e: Expense) => void;
  onNew: () => void;
}) {
  const [q, setQ] = useState("");
  const [cols, setCols] = useState<ColKey[]>(() => loadJson<ColKey[]>(COLS_KEY, DEFAULT_COLS));
  const [presets, setPresets] = useState<Preset[]>(() => loadJson<Preset[]>(PRESETS_KEY, []));
  const [showCols, setShowCols] = useState(false);
  const colsRef = useRef<HTMLDivElement>(null);
  const closeCols = useCallback(() => setShowCols(false), []);
  useDismiss(showCols, colsRef, closeCols);
  const [showPresets, setShowPresets] = useState(false);
  const [presetName, setPresetName] = useState("");
  const presetsRef = useRef<HTMLDivElement>(null);
  const closePresets = useCallback(() => setShowPresets(false), []);
  useDismiss(showPresets, presetsRef, closePresets);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [monthsShown, setMonthsShown] = useState(MONTHS_PAGE);
  const [sort, setSort] = useState<{ key: ColKey; dir: "asc" | "desc" }>({ key: "date", dir: "desc" });

  const filtersActive = Boolean(q || filters.from || filters.to || filters.userId || filters.categoryId || filters.reimbursed);

  // Free-text search over user, category, notes, and amount — client-side so it
  // feels instant on top of the server-side structural filters.
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return expenses;
    return expenses.filter((e) =>
      (e.userName ?? "").toLowerCase().includes(needle) ||
      (e.categoryName ?? "").toLowerCase().includes(needle) ||
      (e.notes ?? "").toLowerCase().includes(needle) ||
      String(e.amount).includes(needle));
  }, [expenses, q]);

  // Running totals follow whatever is currently visible (filters + search).
  const totals = useMemo(() => {
    let total = 0, reimbursed = 0;
    for (const e of visible) { total += e.amount; if (e.reimbursed) reimbursed += e.amount; }
    return { total, reimbursed, outstanding: total - reimbursed, count: visible.length };
  }, [visible]);

  // Group by month (yyyy-mm), newest month first; sort rows inside each group.
  const groups = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const cmp = (a: Expense, b: Expense): number => {
      switch (sort.key) {
        case "amount": return (a.amount - b.amount) * dir;
        case "user": return (a.userName ?? "").localeCompare(b.userName ?? "") * dir;
        case "category": return (a.categoryName ?? "").localeCompare(b.categoryName ?? "") * dir;
        case "status": return (Number(a.reimbursed) - Number(b.reimbursed)) * dir;
        case "notes": return (a.notes ?? "").localeCompare(b.notes ?? "") * dir;
        default: return (new Date(a.date).getTime() - new Date(b.date).getTime()) * dir;
      }
    };
    const m = new Map<string, Expense[]>();
    for (const e of visible) {
      const k = e.date.slice(0, 7);
      (m.get(k) ?? m.set(k, []).get(k)!).push(e);
    }
    return [...m.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, rows]) => ({
        month, rows: rows.sort(cmp),
        subtotal: rows.reduce((s, e) => s + e.amount, 0),
        outstanding: rows.reduce((s, e) => s + (e.reimbursed ? 0 : e.amount), 0),
      }));
  }, [visible, sort]);

  const shownGroups = groups.slice(0, monthsShown);
  const shownIds = shownGroups.flatMap((g) => g.rows.map((e) => e.id));
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => selected.has(id));
  const someShownSelected = !allShownSelected && shownIds.some((id) => selected.has(id));

  function saveCols(next: ColKey[]) { setCols(next); try { localStorage.setItem(COLS_KEY, JSON.stringify(next)); } catch { /* ignore */ } }
  function savePresets(next: Preset[]) { setPresets(next); try { localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); } catch { /* ignore */ } }
  function savePreset() {
    const name = presetName.trim();
    if (!name || !filtersActive) return;
    savePresets([...presets.filter((p) => p.name !== name), { name, filters, q }]);
    setPresetName("");
    setShowPresets(false);
  }
  function applyPreset(name: string) {
    const p = presets.find((x) => x.name === name);
    if (p) { setFilters(p.filters); setQ(p.q); }
    setShowPresets(false);
  }
  function clearFilters() { setFilters({ from: "", to: "", userId: "", categoryId: "", reimbursed: "" }); setQ(""); }

  const monthTitle = (ym: string) =>
    new Date(`${ym}-15T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const has = (k: ColKey) => cols.includes(k);
  const onSort = (key: ColKey) =>
    setSort((p) => (p.key === key ? { key, dir: p.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "date" ? "desc" : "asc" }));
  const sortTh = (key: ColKey, label: string, right = false) => (
    <th className={`sortable ${right ? "right" : ""} ${sort.key === key ? "active" : ""}`} onClick={() => onSort(key)}
      aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <span className="xp-th">
        {label}
        {sort.key === key && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: sort.dir === "asc" ? "rotate(180deg)" : undefined }}><path d="M6 9l6 6 6-6" /></svg>
        )}
      </span>
    </th>
  );
  const colsDefault = cols.length === DEFAULT_COLS.length && DEFAULT_COLS.every((c) => cols.includes(c));

  return (
    <section className="panel xp-panel">
      {/* Panel header: title + search + presets + columns */}
      <div className="xp-head">
        <h3>All expenses</h3>
        <div className="xp-tools">
          <div className="xp-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
            <input
              type="search" placeholder="Search user, category, notes, amount" value={q}
              onChange={(e) => setQ(e.target.value)} aria-label="Search expenses"
            />
          </div>
          <div className="cv-wrap" ref={presetsRef}>
            <button className={`cv-btn ${showPresets ? "active" : ""}`} onClick={() => setShowPresets((s) => !s)} aria-expanded={showPresets} title="Saved filter presets">
              <svg {...ICON}><path d="M6 4h12v17l-6-4-6 4z" /></svg>
              Presets
            </button>
            {showPresets && (
              <div className="cv-menu xp-menu" role="dialog" aria-label="Filter presets">
                <div className="cv-list">
                  {presets.length === 0 && <div className="xp-menu-empty">No saved presets yet</div>}
                  {presets.map((p) => (
                    <div className="xp-preset" key={p.name}>
                      <button type="button" className="xp-preset-apply" onClick={() => applyPreset(p.name)}>{p.name}</button>
                      <button type="button" className="xp-preset-del" aria-label={`Delete preset ${p.name}`} title="Delete preset"
                        onClick={() => savePresets(presets.filter((x) => x.name !== p.name))}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                      </button>
                    </div>
                  ))}
                </div>
                <form className="xp-preset-save" onSubmit={(e) => { e.preventDefault(); savePreset(); }}>
                  <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Save current filters as…" aria-label="Preset name" />
                  <button type="submit" className="primary" disabled={!presetName.trim() || !filtersActive}
                    title={filtersActive ? "Save the current filters as a preset" : "Set a filter or search first"}>Save</button>
                </form>
              </div>
            )}
          </div>
          <div className="cv-wrap" ref={colsRef}>
            <button className={`cv-btn ${showCols ? "active" : ""}`} onClick={() => setShowCols((s) => !s)} aria-expanded={showCols} title="Customize columns">
              <svg {...ICON}><path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" /></svg>
              Customize
            </button>
            {showCols && (
              <div className="cv-menu xp-menu" role="dialog" aria-label="Customize columns">
                <div className="xp-menu-title">Columns</div>
                <div className="cv-list">
                  {ALL_COLUMNS.map(([k, label]) => (
                    <label key={k} className="cv-row cv-check">
                      <input type="checkbox" checked={has(k)} onChange={() => saveCols(has(k) ? cols.filter((c) => c !== k) : [...cols, k])} /> <span>{label}</span>
                    </label>
                  ))}
                </div>
                <div className="cv-foot">
                  <button type="button" className="small" disabled={colsDefault} onClick={() => saveCols(DEFAULT_COLS)}>Restore defaults</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Structural filters (server-side) */}
      <div className="xp-filters">
        <div className="xp-fld"><label>From</label><DateField value={filters.from} onChange={(v) => setFilters((f) => ({ ...f, from: v }))} ariaLabel="From date" /></div>
        <div className="xp-fld"><label>To</label><DateField value={filters.to} onChange={(v) => setFilters((f) => ({ ...f, to: v }))} ariaLabel="To date" /></div>
        <div className="xp-fld"><label>User</label>
          <Select value={filters.userId} onChange={(v) => setFilters((f) => ({ ...f, userId: v }))}
            placeholder="All users" clearable searchable ariaLabel="Filter by user"
            options={users.map((u) => ({ value: u.id, label: u.name }))} />
        </div>
        <div className="xp-fld"><label>Category</label>
          <Select value={filters.categoryId} onChange={(v) => setFilters((f) => ({ ...f, categoryId: v }))}
            placeholder="All categories" clearable ariaLabel="Filter by category"
            options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        </div>
        <div className="xp-fld"><label>Status</label>
          <Select value={filters.reimbursed} onChange={(v) => setFilters((f) => ({ ...f, reimbursed: v }))}
            placeholder="All statuses" ariaLabel="Filter by status"
            options={[
              { value: "", label: "All statuses" },
              { value: "false", label: "Outstanding" },
              { value: "true", label: "Reimbursed" },
            ]} />
        </div>
      </div>

      {/* Summary / selection actions + running totals */}
      <div className="xp-summary-row">
        <div className="xp-summary-left">
          {selected.size > 0 ? (
            <>
              <span className="xp-selcount">{selected.size} selected</span>
              <button className="small" onClick={() => bulk("reimburse")}>
                <svg {...ICON} width={13} height={13} strokeWidth={2}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>Mark reimbursed
              </button>
              <button className="small" onClick={() => bulk("unreimburse")}>
                <svg {...ICON} width={13} height={13} strokeWidth={2}><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" /></svg>Mark outstanding
              </button>
              <button className="small danger" onClick={() => bulk("delete")}>Delete</button>
              <button className="link-btn xp-clear-sel" onClick={() => setSelected(new Set())}>Clear</button>
            </>
          ) : (
            <>
              <span className="xp-showing">Showing <b>{totals.count}</b> {totals.count === 1 ? "expense" : "expenses"}</span>
              {filtersActive && <button className="link-btn xp-clear" onClick={clearFilters}>Clear filters</button>}
            </>
          )}
        </div>
        <div className="xp-totals">
          <span className="xp-stat"><span className="xp-stat-l">Total</span><b>{money(totals.total, { cents: true })}</b></span>
          <span className="xp-stat ok"><span className="xp-stat-l">Reimbursed</span><b>{money(totals.reimbursed, { cents: true })}</b></span>
          <span className="xp-stat warn"><span className="xp-stat-l">Outstanding</span><b>{money(totals.outstanding, { cents: true })}</b></span>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="xp-empty">
          <div className="xp-empty-ico">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="12" y2="16" /></svg>
          </div>
          <div className="xp-empty-t">No expenses in this range</div>
          <div className="xp-empty-b">Log your first expense or widen the date filter above.</div>
          <button className="primary" onClick={onNew}>New expense</button>
        </div>
      ) : (
      <div className="table-scroll exp-scroll">
        <table className="data-table exp-table">
          <thead>
            <tr>
              <th className="xp-cb-col">
                <input
                  type="checkbox" checked={allShownSelected} aria-label="Select all"
                  ref={(el) => { if (el) el.indeterminate = someShownSelected; }}
                  onChange={() => setSelected(allShownSelected ? new Set() : new Set(shownIds))}
                />
              </th>
              {has("date") && sortTh("date", "Date")}
              {has("user") && sortTh("user", "User")}
              {has("category") && sortTh("category", "Category")}
              {has("amount") && sortTh("amount", "Amount", true)}
              {has("status") && sortTh("status", "Status")}
              {has("reimbursementDate") && <th>Reimbursed on</th>}
              {has("notes") && sortTh("notes", "Notes")}
            </tr>
          </thead>
          <tbody>
            {shownGroups.map((g) => (
              <ExpMonthGroup
                key={g.month}
                title={monthTitle(g.month)}
                group={g}
                cols={cols}
                colSpan={cols.length + 1}
                collapsed={collapsed.has(g.month)}
                onToggleCollapse={() => setCollapsed((p) => { const n = new Set(p); n.has(g.month) ? n.delete(g.month) : n.add(g.month); return n; })}
                selected={selected}
                toggle={toggle}
                onEdit={onEdit}
                catColor={(name) => catColorFor(name, categories)}
              />
            ))}
          </tbody>
        </table>
      </div>
      )}
      {visible.length > 0 && groups.length > monthsShown && (
        <div className="xp-more">
          <button onClick={() => setMonthsShown((n) => n + MONTHS_PAGE)}>
            Show {Math.min(MONTHS_PAGE, groups.length - monthsShown)} more month{groups.length - monthsShown > 1 ? "s" : ""}
          </button>
        </div>
      )}
    </section>
  );
}

function ExpMonthGroup({
  title, group, cols, colSpan, collapsed, onToggleCollapse, selected, toggle, onEdit, catColor,
}: {
  title: string;
  group: { month: string; rows: Expense[]; subtotal: number; outstanding: number };
  cols: ColKey[];
  colSpan: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  selected: Set<string>;
  toggle: (id: string) => void;
  onEdit: (e: Expense) => void;
  catColor: (name: string | null) => string;
}) {
  const has = (k: ColKey) => cols.includes(k);
  return (
    <>
      <tr className="exp-month-row clickable" onClick={onToggleCollapse} aria-expanded={!collapsed}>
        <td colSpan={colSpan}>
          <div className="exp-month">
            <span className="exp-month-l">
              <svg className={`exp-month-caret ${collapsed ? "" : "open"}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
              <strong>{title}</strong>
              <span className="exp-month-n">{group.rows.length} expense{group.rows.length === 1 ? "" : "s"}</span>
              {group.outstanding > 0 && <span className="exp-month-out">{money(group.outstanding, { cents: true })} outstanding</span>}
            </span>
            <span className="exp-month-subtotal">{money(group.subtotal, { cents: true })}</span>
          </div>
        </td>
      </tr>
      {!collapsed && group.rows.map((e) => {
        const cc = catColor(e.categoryName);
        return (
          <tr
            key={e.id}
            className={`clickable ${e.reimbursed ? "exp-row-reimbursed" : "exp-row-outstanding"} ${selected.has(e.id) ? "row-selected" : ""}`}
            onClick={() => onEdit(e)}
          >
            <td className="xp-cb-col" onClick={(ev) => ev.stopPropagation()}>
              <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} aria-label="Select row" />
            </td>
            {has("date") && <td className="xp-num">{fmtDate(e.date)}</td>}
            {has("user") && <td>{e.userName
              ? <span className="xp-user"><Avatar user={{ name: e.userName, avatarColor: e.userAvatarColor }} size={22} />{e.userName}</span>
              : "—"}</td>}
            {has("category") && <td>{e.categoryName
              ? <span className="xp-cat-chip" style={{ "--cat": cc } as React.CSSProperties}><i />{e.categoryName}</span>
              : <span className="xp-none">—</span>}</td>}
            {has("amount") && <td className="right xp-num xp-amount">{money(e.amount, { cents: true })}</td>}
            {has("status") && (
              <td><span className={`xp-status ${e.reimbursed ? "ok" : "warn"}`}><span className="dot" aria-hidden="true" />{e.reimbursed ? "Reimbursed" : "Outstanding"}</span></td>
            )}
            {has("reimbursementDate") && <td className="xp-num xp-dim">{e.reimbursementDate ? fmtDate(e.reimbursementDate) : "—"}</td>}
            {has("notes") && <td className={`exp-notes ${e.notes ? "" : "xp-none"}`}>{e.notes || "—"}</td>}
          </tr>
        );
      })}
    </>
  );
}

function ExpenseForm({
  expense, categories, currentUserName, onClose, onSaved,
}: {
  expense: Expense | null;
  categories: Category[];
  currentUserName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState(
    expense
      ? {
          date: toInputDate(expense.date),
          amount: String(expense.amount),
          categoryId: expense.categoryId ?? "",
          notes: expense.notes ?? "",
          reimbursed: expense.reimbursed,
          reimbursementDate: expense.reimbursementDate ? toInputDate(expense.reimbursementDate) : "",
        }
      : EMPTY_FORM,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const amount = Number(f.amount);
    if (!f.date || !(amount >= 0) || Number.isNaN(amount)) { setError("Enter a valid date and amount."); return; }
    setBusy(true);
    const body = {
      date: f.date,
      amount,
      categoryId: f.categoryId || null,
      notes: f.notes || null,
      reimbursed: f.reimbursed,
      reimbursementDate: f.reimbursed ? f.reimbursementDate || null : null,
    };
    try {
      if (expense) await api.patch(`/expenses/${expense.id}`, body);
      else await api.post("/expenses", body);
      onSaved();
    } catch (e2) { setError(e2 instanceof ApiError ? e2.message : "Failed to save"); }
    finally { setBusy(false); }
  }

  return (
    <Modal
      title={expense ? "Edit expense" : "Add expense"}
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : expense ? "Save changes" : "Add expense"}</button>
      </>}
    >
      <form onSubmit={save} className="xp-form">
        <FormSection title="Expense">
          <div className="xp-form-grid">
            <div className="field"><label>Date</label><DateField value={f.date} onChange={(v) => setF((p) => ({ ...p, date: v }))} ariaLabel="Expense date" /></div>
            <div className="field"><label>Amount</label><MoneyInput decimals={2} value={f.amount} onChange={(v) => setF((p) => ({ ...p, amount: v }))} placeholder="0.00" ariaLabel="Expense amount" /></div>
            <div className="field">
              <label>Category</label>
              <Select value={f.categoryId} onChange={(v) => setF((p) => ({ ...p, categoryId: v }))}
                placeholder="Uncategorized" clearable ariaLabel="Category"
                options={categories.filter((c) => c.active || c.id === f.categoryId).map((c) => ({ value: c.id, label: c.name }))} />
            </div>
            <div className="field">
              <label>User</label>
              {/* Auto-populated with the current user and not editable. */}
              <input value={currentUserName} disabled readOnly />
            </div>
          </div>
        </FormSection>

        <FormSection title="Details">
          <div className="field"><label>Notes</label><textarea value={f.notes} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} rows={3} placeholder="Vendor, purpose or deal reference" /></div>
        </FormSection>

        <FormSection title="Reimbursement">
          <div className="xp-reimb">
            <Toggle checked={f.reimbursed} onChange={(v) => setF((p) => ({ ...p, reimbursed: v }))} ariaLabel="Reimbursed" />
            <div className="xp-reimb-text">
              <span className="xp-reimb-l">Reimbursed</span>
              <span className="xp-reimb-h">{f.reimbursed ? `Paid back${currentUserName ? ` to ${currentUserName}` : ""}` : "Outstanding until paid back"}</span>
            </div>
          </div>
          {f.reimbursed && (
            <div className="field xp-reimb-date"><label>Reimbursed on</label><DateField value={f.reimbursementDate} onChange={(v) => setF((p) => ({ ...p, reimbursementDate: v }))} ariaLabel="Reimbursed on" /></div>
          )}
        </FormSection>
        {error && <div className="error-text">{error}</div>}
      </form>
    </Modal>
  );
}

function CategoryManager({ categories, onClose, onChanged }: { categories: Category[]; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [pendingRemove, setPendingRemove] = useState<Category | null>(null);
  // Local order so drag reordering feels instant; persisted on each drop.
  const [order, setOrder] = useState<Category[]>(categories);
  useEffect(() => { setOrder(categories); }, [categories]);
  // Drag-and-drop reordering state: the row being dragged and the current drop target.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); onChanged(); }
    catch (e2) { setErr(e2 instanceof ApiError ? e2.message : "Something went wrong"); }
  }
  const add = (e: React.FormEvent) => { e.preventDefault(); if (name.trim()) run(async () => { await api.post("/expenses/categories", { name: name.trim() }); setName(""); }); };
  // null clears the saved colour, so the category goes back to its position colour.
  const setColor = (c: Category, color: string | null) => {
    if ((c.color ?? null) === color) return;
    setOrder((o) => o.map((x) => (x.id === c.id ? { ...x, color } : x)));
    run(() => api.patch(`/expenses/categories/${c.id}`, { color }));
  };
  const toggleActive = (c: Category) => run(() => api.patch(`/expenses/categories/${c.id}`, { active: !c.active }));
  function saveRename(c: Category) {
    const n = editName.trim();
    setEditId(null);
    if (n && n !== c.name) run(() => api.patch(`/expenses/categories/${c.id}`, { name: n }));
  }
  /** Move a category from one position to another (drag & drop or arrows) and persist. */
  function commitReorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    run(() => api.post("/expenses/categories/reorder", { ids: next.map((c) => c.id) }));
  }
  function onDrop(target: number) {
    if (dragIdx != null) commitReorder(dragIdx, target);
    setDragIdx(null); setOverIdx(null);
  }

  return (
    <Modal title="Expense categories" subtitle="Drag rows by the handle to reorder. Changes apply immediately to the expense forms."
      onClose={onClose} footer={<button className="primary" onClick={onClose}>Done</button>}>
      <form onSubmit={add} className="xp-cat-add">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New category, e.g. Marketing" aria-label="New category" />
        <button className="primary" disabled={!name.trim()}>Add</button>
      </form>
      {err && <div className="error-text">{err}</div>}
      <div className="xp-cat-list">
        {order.map((c, i) => (
          <div
            key={c.id}
            draggable
            onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overIdx !== i) setOverIdx(i); }}
            onDrop={(e) => { e.preventDefault(); onDrop(i); }}
            onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
            className={`xp-cat-row ${c.active ? "" : "hidden"} ${dragIdx === i ? "dragging" : ""} ${overIdx === i && dragIdx !== null && dragIdx !== i ? "drop-over" : ""}`}
          >
            <span className="cat-drag" title="Drag to reorder" aria-label="Drag to reorder">⠿</span>
            <span className="xp-cat-move">
              <button type="button" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => commitReorder(i, i - 1)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>
              </button>
              <button type="button" aria-label={`Move ${c.name} down`} disabled={i === order.length - 1} onClick={() => commitReorder(i, i + 1)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
              </button>
            </span>
            <CategoryColorPicker label={c.name} saved={c.color ?? null} color={catColorFor(c.name, order)}
              fallback={catPositionColor(c.name, order)} onPick={(col) => setColor(c, col)} />
            <span className="xp-cat-name">
              {editId === c.id ? (
                <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveRename(c); if (e.key === "Escape") setEditId(null); }}
                  onBlur={() => saveRename(c)} aria-label="Category name" />
              ) : (
                <>
                  <span className="clickable" title="Click to rename" onClick={() => { setEditId(c.id); setEditName(c.name); }}>{c.name}</span>
                  {c.expenseCount != null && <span className="xp-cat-meta">{countNoun(c.expenseCount)}</span>}
                </>
              )}
            </span>
            <Tag tone={c.active ? "success" : "neutral"}>{c.active ? "Active" : "Hidden"}</Tag>
            <span className="xp-cat-actions">
              <button className="small" onClick={() => { setEditId(c.id); setEditName(c.name); }}>Rename</button>
              <button className="small" onClick={() => toggleActive(c)}>{c.active ? "Hide" : "Show"}</button>
              <button className="small xp-cat-del" aria-label={`Delete ${c.name}`} title="Delete" onClick={() => setPendingRemove(c)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
              </button>
            </span>
          </div>
        ))}
      </div>
      {pendingRemove && (
        <ConfirmDialog
          title="Delete category"
          message={<>Delete category "{pendingRemove.name}"? Existing expenses keep their amount but become uncategorized.</>}
          confirmLabel="Delete"
          danger
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => { const c = pendingRemove; setPendingRemove(null); run(() => api.del(`/expenses/categories/${c.id}`)); }}
        />
      )}
    </Modal>
  );
}

/** Category colour swatch that opens a small popover of preset swatches (the
 *  chart palette) plus "Default", which clears the saved colour. Closes after
 *  every pick. */
function CategoryColorPicker({ label, saved, color, fallback, onPick }: {
  label: string; saved: string | null; color: string; fallback: string; onPick: (c: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  // The swatches render in a portal at a fixed position so the dialog's
  // scroll area cannot clip them; they open upward when there is no room below.
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = ref.current?.getBoundingClientRect();
    if (r) {
      const POP_H = 150, POP_W = 170;
      const below = window.innerHeight - r.bottom > POP_H + 12;
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8)), top: below ? r.bottom + 6 : Math.max(8, r.top - POP_H - 6) });
    }
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    // Capture + stop: Escape closes just the swatches, never the dialog.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey, true); };
  }, [open]);
  const current = saved ? saved.toLowerCase() : null;
  return (
    <span className="xp-cat-color" ref={ref}>
      <button type="button" className={`xp-cat-color-btn ${open ? "open" : ""}`} title="Category color"
        aria-label={`${label} color`} aria-expanded={open} onClick={toggle}>
        <span className="xp-cat-swatch" style={{ background: color }} />
      </button>
      {open && pos && createPortal(
        <div className="xp-cat-color-pop" ref={popRef} style={{ left: pos.left, top: pos.top }} role="listbox" aria-label={`${label} color`}>
          {CHART_COLORS.map((c) => (
            <button key={c} type="button" role="option" aria-selected={c.toLowerCase() === current} aria-label={c}
              className={`xp-cat-color-opt ${c.toLowerCase() === current ? "on" : ""}`} style={{ background: c, color: c }}
              onClick={() => { setOpen(false); onPick(c); }} />
          ))}
          <button type="button" role="option" aria-selected={current === null}
            className={`xp-cat-color-default ${current === null ? "on" : ""}`} title="Use the color for this category's position in the list"
            onClick={() => { setOpen(false); onPick(null); }}>
            <span className="xp-cat-swatch" style={{ background: fallback }} />Default
          </button>
        </div>,
        document.body,
      )}
    </span>
  );
}
