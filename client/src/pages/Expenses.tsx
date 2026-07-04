import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  PieChart, Pie, Cell,
} from "recharts";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { MetricCard, Spinner, Banner, Modal } from "../components/ui";
import { SortableTable, type Column } from "../components/SortableTable";
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
  function toggleAll() {
    setSelected((prev) => (prev.size === expenses.length ? new Set() : new Set(expenses.map((e) => e.id))));
  }

  async function bulk(action: string, categoryId?: string) {
    if (selected.size === 0) return;
    if (action === "delete" && !confirm(`Delete ${selected.size} expense(s)? This cannot be undone.`)) return;
    try {
      await api.post("/expenses/bulk", { ids: [...selected], action, categoryId });
      load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Bulk action failed"); }
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

  const columns: Column<Expense>[] = [
    {
      key: "sel", header: "", value: () => "",
      render: (e) => <input type="checkbox" checked={selected.has(e.id)} onClick={(ev) => ev.stopPropagation()} onChange={() => toggle(e.id)} />,
      width: "34px",
    },
    { key: "date", header: "Date", type: "date", value: (e) => e.date, render: (e) => fmtDate(e.date) },
    { key: "user", header: "User", type: "text", value: (e) => e.userName ?? "" },
    { key: "category", header: "Category", type: "text", value: (e) => e.categoryName ?? "", render: (e) => e.categoryName ?? "—" },
    { key: "amount", header: "Amount", type: "number", align: "right", value: (e) => e.amount, render: (e) => money(e.amount) },
    {
      key: "reimbursed", header: "Reimbursed", type: "text", value: (e) => (e.reimbursed ? "Yes" : "No"),
      render: (e) => <span className={`badge ${e.reimbursed ? "resp-offer" : "resp-pending"}`}>{e.reimbursed ? "Reimbursed" : "Outstanding"}</span>,
    },
    { key: "notes", header: "Notes", type: "text", value: (e) => e.notes ?? "", render: (e) => e.notes || "—" },
  ];

  if (loading && !dash) return <Spinner label="Loading expenses…" />;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Expenses</h1>
        <div className="row">
          <button className="small" onClick={() => setShowCats(true)}>Manage categories</button>
          <button className="primary" onClick={() => { setEditing(null); setShowForm(true); }}>+ Add expense</button>
        </div>
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      {dash && dash.totals.count === 0 && (
        <Banner kind="info">
          No expenses recorded yet — use <strong>+ Add expense</strong> to start tracking company spend and reimbursements.
        </Banner>
      )}

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
        <div className="chart-grid">
          <div className="panel">
            <h3>Expenses by Month</h3>
            {dash.byMonth.length === 0 ? <p className="muted">No data.</p> : (
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

          <div className="panel">
            <h3>Expenses by Category</h3>
            {dash.byCategory.length === 0 ? <p className="muted">No data.</p> : (
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

          <div className="panel">
            <h3>Expenses by User</h3>
            {dash.byUser.length === 0 ? <p className="muted">No data.</p> : (
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

      {/* Outstanding balance by user */}
      {dash && dash.outstandingByUser.length > 0 && (
        <div className="panel">
          <h3>Outstanding Balance by User</h3>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>User</th><th className="right">Outstanding</th></tr></thead>
              <tbody>
                {dash.outstandingByUser.map((u) => (
                  <tr key={u.userId}><td>{u.name}</td><td className="right">{money(u.outstanding)}</td></tr>
                ))}
                <tr><td><strong>Company total</strong></td><td className="right"><strong>{money(dash.totals.companyOutstanding)}</strong></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="panel">
        <div className="section-head"><h3 style={{ margin: 0 }}>All expenses</h3></div>
        <div className="row" style={{ flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
          <div className="field" style={{ marginBottom: 0 }}><label>From</label><input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>To</label><input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>User</label>
            <select value={filters.userId} onChange={(e) => setFilters((f) => ({ ...f, userId: e.target.value }))}>
              <option value="">All</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}><label>Category</label>
            <select value={filters.categoryId} onChange={(e) => setFilters((f) => ({ ...f, categoryId: e.target.value }))}>
              <option value="">All</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}><label>Status</label>
            <select value={filters.reimbursed} onChange={(e) => setFilters((f) => ({ ...f, reimbursed: e.target.value }))}>
              <option value="">All</option>
              <option value="false">Outstanding</option>
              <option value="true">Reimbursed</option>
            </select>
          </div>
          {(filters.from || filters.to || filters.userId || filters.categoryId || filters.reimbursed) && (
            <button className="small" style={{ alignSelf: "flex-end" }} onClick={() => setFilters({ from: "", to: "", userId: "", categoryId: "", reimbursed: "" })}>Clear</button>
          )}
        </div>

        {/* Bulk action bar */}
        <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 8, alignItems: "center" }}>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={expenses.length > 0 && selected.size === expenses.length} onChange={toggleAll} /> Select all
          </label>
          <span className="muted" style={{ fontSize: 13 }}>{selected.size} selected</span>
          <button className="small" disabled={selected.size === 0} onClick={() => bulk("reimburse")}>Mark reimbursed</button>
          <button className="small" disabled={selected.size === 0} onClick={() => bulk("unreimburse")}>Mark not reimbursed</button>
          <select className="small" disabled={selected.size === 0} defaultValue="" onChange={(e) => { if (e.target.value) { bulk("setCategory", e.target.value); e.target.value = ""; } }}>
            <option value="">Change category…</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="small" onClick={exportSelected}>Export {selected.size > 0 ? "selected" : "all"} (CSV)</button>
          <button className="small danger" disabled={selected.size === 0} onClick={() => bulk("delete")}>Delete</button>
        </div>

        <SortableTable
          columns={columns}
          rows={expenses}
          rowKey={(e) => e.id}
          onRowClick={(e) => { setEditing(e); setShowForm(true); }}
          defaultSort={{ key: "date", dir: "desc" }}
          empty="No expenses match these filters."
        />
      </div>

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
    </div>
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
          <select value={f.categoryId} onChange={(e) => setF((p) => ({ ...p, categoryId: e.target.value }))}>
            <option value="">Uncategorized</option>
            {categories.filter((c) => c.active || c.id === f.categoryId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
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

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try { await api.post("/expenses/categories", { name: name.trim() }); setName(""); onChanged(); }
    catch (e2) { setErr(e2 instanceof ApiError ? e2.message : "Failed"); }
  }
  async function toggleActive(c: Category) { await api.patch(`/expenses/categories/${c.id}`, { active: !c.active }); onChanged(); }
  async function remove(c: Category) {
    if (!confirm(`Delete category "${c.name}"? Existing expenses keep their amount but become uncategorized.`)) return;
    await api.del(`/expenses/categories/${c.id}`); onChanged();
  }

  return (
    <Modal title="Expense categories" onClose={onClose} footer={<button className="primary" onClick={onClose}>Done</button>}>
      <form onSubmit={add} className="row" style={{ alignItems: "flex-end", marginBottom: 10 }}>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>New category</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Marketing" /></div>
        <button className="primary" disabled={!name.trim()}>Add</button>
      </form>
      {err && <div className="error-text">{err}</div>}
      <div className="table-scroll">
        <table className="data-table">
          <thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td><span className={`badge ${c.active ? "resp-offer" : "resp-no"}`}>{c.active ? "Active" : "Hidden"}</span></td>
                <td className="right">
                  <button className="small" onClick={() => toggleActive(c)}>{c.active ? "Hide" : "Show"}</button>
                  <button className="small danger" style={{ marginLeft: 6 }} onClick={() => remove(c)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
