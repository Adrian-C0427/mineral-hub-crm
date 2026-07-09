import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  PieChart, Pie, Cell,
} from "recharts";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { MetricCard, Spinner, Banner, Modal, ConfirmDelete } from "../components/ui";
import { Select } from "../components/Select";
import { money, fmtDate, toInputDate } from "../lib/format";
import { downloadCsv } from "../lib/csv";
import { CHART_COLORS, COLOR_EXPENSE, monthLabel, chartTooltip } from "../lib/charts";
import type { UserLite } from "../types";

interface Category { id: string; name: string; active: boolean }
interface Expense {
  id: string; date: string; amount: number; notes: string | null;
  reimbursed: boolean; reimbursementDate: string | null;
  categoryId: string | null; categoryName: string | null;
  userId: string | null; userName: string | null; createdAt: string;
}
interface Dashboard {
  totals: { totalExpenses: number; totalReimbursed: number; totalOutstanding: number; companyOutstanding: number; count: number };
  byCategory: { name: string; amount: number }[];
  byMonth: { month: string; expenses: number; reimbursed: number }[];
  byUser: { userId: string; name: string; total: number; outstanding: number }[];
  outstandingByUser: { userId: string; name: string; outstanding: number }[];
}

const EMPTY_FORM = { date: toInputDate(new Date()), amount: "", categoryId: "", notes: "", reimbursed: false, reimbursementDate: "" };

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

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 style={{ marginBottom: 0 }}>Expenses</h1>
          <div className="xp-sub">Team spend &amp; reimbursements</div>
        </div>
        <div className="row">
          <button className="small" onClick={() => setShowCats(true)}>Manage categories</button>
          <button className="small" onClick={exportSelected} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            Export all (CSV)
          </button>
          <button className="primary" onClick={() => { setEditing(null); setShowForm(true); }}>+ New expense</button>
        </div>
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      {/* KPIs */}
      {dash && (
        <div className="metrics-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
          <MetricCard label="Total Expenses" value={money(dash.totals.totalExpenses)} hint={`${dash.totals.count} records`} />
          <MetricCard label="Total Reimbursed" value={money(dash.totals.totalReimbursed)} />
          <MetricCard label="Outstanding Reimbursements" value={money(dash.totals.totalOutstanding)} />
          <MetricCard label="Company Outstanding Balance" value={money(dash.totals.companyOutstanding)} />
        </div>
      )}

      {/* Charts */}
      {dash && (
        <div className="xp-charts">
          <div className="panel xp-chart">
            <h3>Expenses by Month</h3>
            {dash.byMonth.length === 0 ? (
              <ChartEmpty icon={<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>}>
                No expenses yet — data appears here as you log spend
              </ChartEmpty>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={dash.byMonth.map((m) => ({ ...m, label: monthLabel(m.month) }))}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => money(v)} tick={{ fontSize: 11 }} width={70} />
                  <Tooltip {...chartTooltip} formatter={(v: number) => money(v)} />
                  <Bar dataKey="expenses" name="Expenses" fill={COLOR_EXPENSE} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="panel xp-chart">
            <h3>Expenses by Category</h3>
            {dash.byCategory.length === 0 ? (
              <ChartEmpty icon={<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21.21 15.89A10 10 0 118 2.83" /><path d="M22 12A10 10 0 0012 2v10z" /></svg>}>
                No categories to chart yet
              </ChartEmpty>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={dash.byCategory} dataKey="amount" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={(e) => e.name}>
                    {dash.byCategory.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip {...chartTooltip} formatter={(v: number) => money(v)} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="panel xp-chart">
            <h3>Expenses by User</h3>
            {dash.byUser.length === 0 ? (
              <ChartEmpty icon={<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /></svg>}>
                No spend recorded by teammates
              </ChartEmpty>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={dash.byUser} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis type="number" tickFormatter={(v) => money(v)} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={110} />
                  <Tooltip {...chartTooltip} formatter={(v: number) => money(v)} />
                  <Legend />
                  <Bar dataKey="total" name="Total" fill={CHART_COLORS[0]} radius={[0, 3, 3, 0]} />
                  <Bar dataKey="outstanding" name="Outstanding" fill={CHART_COLORS[2]} radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
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
  useEffect(() => {
    if (!showCols) return;
    const onDoc = (e: MouseEvent) => { if (colsRef.current && !colsRef.current.contains(e.target as Node)) setShowCols(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowCols(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [showCols]);
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
      .map(([month, rows]) => ({ month, rows: rows.sort(cmp), subtotal: rows.reduce((s, e) => s + e.amount, 0) }));
  }, [visible, sort]);

  const shownGroups = groups.slice(0, monthsShown);
  const shownIds = shownGroups.flatMap((g) => g.rows.map((e) => e.id));
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => selected.has(id));

  function saveCols(next: ColKey[]) { setCols(next); try { localStorage.setItem(COLS_KEY, JSON.stringify(next)); } catch { /* ignore */ } }
  function savePresets(next: Preset[]) { setPresets(next); try { localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); } catch { /* ignore */ } }
  function savePreset() {
    const name = prompt("Preset name:")?.trim();
    if (!name) return;
    savePresets([...presets.filter((p) => p.name !== name), { name, filters, q }]);
  }
  function applyPreset(name: string) {
    const p = presets.find((x) => x.name === name);
    if (p) { setFilters(p.filters); setQ(p.q); }
  }

  const monthTitle = (ym: string) =>
    new Date(`${ym}-15T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const has = (k: ColKey) => cols.includes(k);
  const onSort = (key: ColKey) =>
    setSort((p) => (p.key === key ? { key, dir: p.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "date" ? "desc" : "asc" }));
  const sortInd = (key: ColKey) => (sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");

  return (
    <div className="panel xp-panel">
      {/* Panel header: title + search + presets + columns */}
      <div className="xp-head">
        <h3>All expenses</h3>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <div className="xp-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <input
              type="search" placeholder="Search user, category, notes, amount…" value={q}
              onChange={(e) => setQ(e.target.value)} aria-label="Search expenses"
            />
          </div>
          <Select value="" width={150} placeholder="Presets…" ariaLabel="Apply a saved filter preset"
            onChange={(v) => { if (v) applyPreset(v); }}
            options={presets.map((p) => ({ value: p.name, label: p.name }))} />
          <button className="small" onClick={savePreset} disabled={!filtersActive} title="Save the current filters as a preset">Save preset</button>
          <div className="cv-wrap" ref={colsRef}>
            <button className={`small cv-btn ${showCols ? "active" : ""}`} onClick={() => setShowCols((s) => !s)} title="Customize columns">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>
              Customize View
            </button>
            {showCols && (
              <div className="cv-menu" role="dialog" aria-label="Customize columns">
                <div className="cv-head"><strong>Columns</strong><span className="muted" style={{ fontSize: 12 }}>Show &amp; hide</span></div>
                <div className="cv-list">
                  {ALL_COLUMNS.map(([k, label]) => (
                    <label key={k} className="cv-row cv-check" style={{ justifyContent: "flex-start" }}>
                      <input type="checkbox" checked={has(k)} onChange={() => saveCols(has(k) ? cols.filter((c) => c !== k) : [...cols, k])} /> <span>{label}</span>
                    </label>
                  ))}
                </div>
                <div className="cv-foot">
                  <button type="button" className="small" disabled={cols.length === DEFAULT_COLS.length && DEFAULT_COLS.every((c) => cols.includes(c))} onClick={() => saveCols(DEFAULT_COLS)}>Restore default</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filter bar: structural filters + inline running totals */}
      <div className="xp-filterbar">
        <div className="xp-fld"><div className="xp-lbl">From</div><input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} /></div>
        <div className="xp-fld"><div className="xp-lbl">To</div><input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} /></div>
        <div className="xp-fld"><div className="xp-lbl">User</div>
          <Select value={filters.userId} onChange={(v) => setFilters((f) => ({ ...f, userId: v }))}
            placeholder="All" clearable searchable ariaLabel="Filter by user" width={190}
            options={users.map((u) => ({ value: u.id, label: u.name }))} />
        </div>
        <div className="xp-fld"><div className="xp-lbl">Category</div>
          <Select value={filters.categoryId} onChange={(v) => setFilters((f) => ({ ...f, categoryId: v }))}
            placeholder="All" clearable ariaLabel="Filter by category" width={190}
            options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        </div>
        <div className="xp-fld"><div className="xp-lbl">Status</div>
          <Select value={filters.reimbursed} onChange={(v) => setFilters((f) => ({ ...f, reimbursed: v }))}
            placeholder="All" ariaLabel="Filter by status" width={160}
            options={[
              { value: "", label: "All" },
              { value: "false", label: "Outstanding" },
              { value: "true", label: "Reimbursed" },
            ]} />
        </div>
        {filtersActive && (
          <button className="small" style={{ alignSelf: "flex-end" }} onClick={() => { setFilters({ from: "", to: "", userId: "", categoryId: "", reimbursed: "" }); setQ(""); }}>Clear all</button>
        )}
        <div className="xp-summary">
          <span>Showing <b>{totals.count}</b> expenses</span>
          <span>Total <b>{money(totals.total)}</b></span>
          <span className="ok">Reimbursed <b>{money(totals.reimbursed)}</b></span>
          <span className="warn">Outstanding <b>{money(totals.outstanding)}</b></span>
        </div>
      </div>

      {/* Bulk action bar */}
      <div className="xp-bulkbar">
        <span className="xp-selcount">{selected.size} selected</span>
        <span className="xp-vdiv" />
        <button className="small" disabled={selected.size === 0} onClick={() => bulk("reimburse")}>✓ Mark reimbursed</button>
        <button className="small" disabled={selected.size === 0} onClick={() => bulk("unreimburse")}>↺ Mark not reimbursed</button>
        <button className="small danger" style={{ marginLeft: "auto" }} disabled={selected.size === 0} onClick={() => bulk("delete")}>Delete</button>
      </div>

      {visible.length === 0 ? (
        <div className="xp-empty">
          <div className="xp-empty-ico">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="12" y2="16" /></svg>
          </div>
          <div className="xp-empty-t">No expenses in this range</div>
          <div style={{ fontSize: 12.5 }}>Log your first expense or widen the date filter above.</div>
          <button className="primary" style={{ marginTop: 6 }} onClick={onNew}>+ New expense</button>
        </div>
      ) : (
      <div className="table-scroll exp-scroll">
        <table className="data-table exp-table">
          <thead>
            <tr>
              <th className="center" style={{ width: 36 }}>
                <input
                  type="checkbox" checked={allShownSelected} aria-label="Select all"
                  onChange={() => setSelected(allShownSelected ? new Set() : new Set(shownIds))}
                />
              </th>
              {has("date") && <th className="sortable" onClick={() => onSort("date")}>Date{sortInd("date")}</th>}
              {has("user") && <th className="sortable" onClick={() => onSort("user")}>User{sortInd("user")}</th>}
              {has("category") && <th className="sortable" onClick={() => onSort("category")}>Category{sortInd("category")}</th>}
              {has("amount") && <th className="sortable right" onClick={() => onSort("amount")}>Amount{sortInd("amount")}</th>}
              {has("status") && <th className="sortable" onClick={() => onSort("status")}>Status{sortInd("status")}</th>}
              {has("reimbursementDate") && <th>Reimbursed on</th>}
              {has("notes") && <th className="sortable" onClick={() => onSort("notes")}>Notes{sortInd("notes")}</th>}
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
              />
            ))}
          </tbody>
        </table>
      </div>
      )}
      {visible.length > 0 && groups.length > monthsShown && (
        <div className="row" style={{ justifyContent: "center", padding: "10px 20px 16px" }}>
          <button className="small" onClick={() => setMonthsShown((n) => n + MONTHS_PAGE)}>
            Show {Math.min(MONTHS_PAGE, groups.length - monthsShown)} more month{groups.length - monthsShown > 1 ? "s" : ""}
          </button>
        </div>
      )}
    </div>
  );
}

function ExpMonthGroup({
  title, group, cols, colSpan, collapsed, onToggleCollapse, selected, toggle, onEdit,
}: {
  title: string;
  group: { month: string; rows: Expense[]; subtotal: number };
  cols: ColKey[];
  colSpan: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  selected: Set<string>;
  toggle: (id: string) => void;
  onEdit: (e: Expense) => void;
}) {
  const has = (k: ColKey) => cols.includes(k);
  return (
    <>
      <tr className="exp-month-row clickable" onClick={onToggleCollapse}>
        <td colSpan={colSpan}>
          <span className="exp-month-caret">{collapsed ? "▸" : "▾"}</span>
          <strong>{title}</strong>
          <span className="muted" style={{ marginLeft: 8 }}>{group.rows.length} expense{group.rows.length === 1 ? "" : "s"}</span>
          <span className="exp-month-subtotal">{money(group.subtotal)}</span>
        </td>
      </tr>
      {!collapsed && group.rows.map((e) => (
        <tr
          key={e.id}
          className={`clickable ${e.reimbursed ? "exp-row-reimbursed" : "exp-row-outstanding"} ${selected.has(e.id) ? "row-selected" : ""}`}
          onClick={() => onEdit(e)}
        >
          <td className="center" onClick={(ev) => ev.stopPropagation()}>
            <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} aria-label="Select row" />
          </td>
          {has("date") && <td>{fmtDate(e.date)}</td>}
          {has("user") && <td>{e.userName ?? "—"}</td>}
          {has("category") && <td>{e.categoryName ?? "—"}</td>}
          {has("amount") && <td className="right">{money(e.amount)}</td>}
          {has("status") && (
            <td><span className={`badge ${e.reimbursed ? "resp-offer" : "resp-pending"}`}>{e.reimbursed ? "Reimbursed" : "Outstanding"}</span></td>
          )}
          {has("reimbursementDate") && <td>{e.reimbursementDate ? fmtDate(e.reimbursementDate) : "—"}</td>}
          {has("notes") && <td className="exp-notes">{e.notes || "—"}</td>}
        </tr>
      ))}
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
      footer={<><button className="small" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button></>}
    >
      <form onSubmit={save}>
        <div className="grid-2">
          <div className="field"><label>Date</label><input type="date" value={f.date} onChange={(e) => setF((p) => ({ ...p, date: e.target.value }))} /></div>
          <div className="field"><label>Amount</label><input type="number" min="0" step="0.01" value={f.amount} onChange={(e) => setF((p) => ({ ...p, amount: e.target.value }))} placeholder="0.00" /></div>
        </div>
        <div className="field">
          <label>User</label>
          {/* Auto-populated with the current user and not editable. */}
          <input value={currentUserName} disabled readOnly />
        </div>
        <div className="field">
          <label>Category</label>
          <Select value={f.categoryId} onChange={(v) => setF((p) => ({ ...p, categoryId: v }))}
            placeholder="Uncategorized" clearable ariaLabel="Category"
            options={categories.filter((c) => c.active || c.id === f.categoryId).map((c) => ({ value: c.id, label: c.name }))} />
        </div>
        <div className="field"><label>Notes</label><textarea value={f.notes} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} rows={3} /></div>
        <div className="field">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={f.reimbursed} onChange={(e) => setF((p) => ({ ...p, reimbursed: e.target.checked }))} /> Reimbursed
          </label>
        </div>
        {f.reimbursed && (
          <div className="field"><label>Reimbursement date</label><input type="date" value={f.reimbursementDate} onChange={(e) => setF((p) => ({ ...p, reimbursementDate: e.target.value }))} /></div>
        )}
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
  const toggleActive = (c: Category) => run(() => api.patch(`/expenses/categories/${c.id}`, { active: !c.active }));
  const remove = (c: Category) => { if (confirm(`Delete category "${c.name}"? Existing expenses keep their amount but become uncategorized.`)) run(() => api.del(`/expenses/categories/${c.id}`)); };
  function saveRename(c: Category) {
    const n = editName.trim();
    setEditId(null);
    if (n && n !== c.name) run(() => api.patch(`/expenses/categories/${c.id}`, { name: n }));
  }
  /** Move a category from one position to another (drag & drop) and persist. */
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
    <Modal title="Expense categories" onClose={onClose} footer={<button className="primary" onClick={onClose}>Done</button>}>
      <form onSubmit={add} className="row" style={{ alignItems: "flex-end", marginBottom: 12 }}>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>New category</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Marketing" /></div>
        <button className="primary" disabled={!name.trim()}>Add</button>
      </form>
      {err && <div className="error-text">{err}</div>}
      <div className="table-scroll">
        <table className="data-table">
          <thead><tr><th style={{ width: 44 }}></th><th>Name</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {order.map((c, i) => (
              <tr
                key={c.id}
                draggable
                onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overIdx !== i) setOverIdx(i); }}
                onDrop={(e) => { e.preventDefault(); onDrop(i); }}
                onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                className={`cat-row ${dragIdx === i ? "dragging" : ""} ${overIdx === i && dragIdx !== null && dragIdx !== i ? "drop-over" : ""}`}
              >
                <td>
                  <span className="cat-drag" title="Drag to reorder" aria-label="Drag to reorder" style={{ cursor: "grab", userSelect: "none", color: "var(--text-dim)" }}>⠿</span>
                </td>
                <td>
                  {editId === c.id ? (
                    <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveRename(c); if (e.key === "Escape") setEditId(null); }}
                      onBlur={() => saveRename(c)} style={{ width: 200 }} />
                  ) : (
                    <span className="clickable" title="Click to rename" onClick={() => { setEditId(c.id); setEditName(c.name); }}>{c.name}</span>
                  )}
                </td>
                <td><span className={`badge ${c.active ? "resp-offer" : "resp-no"}`}>{c.active ? "Active" : "Hidden"}</span></td>
                <td className="right">
                  <button className="small" onClick={() => { setEditId(c.id); setEditName(c.name); }}>Rename</button>
                  <button className="small" style={{ marginLeft: 6 }} onClick={() => toggleActive(c)}>{c.active ? "Hide" : "Show"}</button>
                  <button className="small danger" style={{ marginLeft: 6 }} onClick={() => remove(c)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Drag rows by the handle to reorder. Changes apply immediately to the expense forms.</p>
    </Modal>
  );
}
