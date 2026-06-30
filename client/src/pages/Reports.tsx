import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { MetricCard, Spinner } from "../components/ui";
import { SortableTable, type Column } from "../components/SortableTable";
import { money, pct, fmtDate } from "../lib/format";

interface ClosedRow {
  id: string; name: string; county: string | null; state: string | null; buyer: string | null;
  askPrice: number | null; acceptedAmount: number | null; closingCosts: number | null;
  grossFee: number | null; netProfit: number | null; closedDate: string;
}
interface ReportData {
  rows: ClosedRow[];
  totals: { dealsClosed: number; grossFees: number; netProfit: number; avgProfitPerDeal: number; avgDealSize: number };
  winRate: number;
  deadInPeriod: number;
}

type Period = "THIS_MONTH" | "LAST_MONTH" | "THIS_YEAR" | "LAST_YEAR" | "CUSTOM";

function rangeFor(period: Period): { from?: string; to?: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  switch (period) {
    case "THIS_MONTH": return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
    case "LAST_MONTH": return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    case "THIS_YEAR": return { from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(new Date(Date.UTC(y, 11, 31))) };
    case "LAST_YEAR": return { from: iso(new Date(Date.UTC(y - 1, 0, 1))), to: iso(new Date(Date.UTC(y - 1, 11, 31))) };
    default: return {};
  }
}

export function Reports() {
  const [period, setPeriod] = useState<Period>("THIS_YEAR");
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [data, setData] = useState<ReportData | null>(null);
  const nav = useNavigate();

  const range = useMemo(() => (period === "CUSTOM" ? custom : rangeFor(period)), [period, custom]);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (range.from) qs.set("from", range.from);
    if (range.to) qs.set("to", range.to);
    api.get<ReportData>(`/reports/closed?${qs.toString()}`).then(setData);
  }, [range.from, range.to]);

  const columns: Column<ClosedRow>[] = [
    { key: "name", header: "Deal", type: "text", value: (r) => r.name, render: (r) => <strong>{r.name}</strong> },
    { key: "loc", header: "Location", type: "text", value: (r) => [r.county, r.state].filter(Boolean).join(", "), render: (r) => [r.county, r.state].filter(Boolean).join(", ") || "—" },
    { key: "buyer", header: "Buyer", type: "text", value: (r) => r.buyer ?? "" },
    { key: "ask", header: "Ask", type: "number", align: "right", value: (r) => r.askPrice, render: (r) => money(r.askPrice) },
    { key: "accepted", header: "Accepted", type: "number", align: "right", value: (r) => r.acceptedAmount, render: (r) => money(r.acceptedAmount) },
    { key: "gross", header: "Gross Fee", type: "number", align: "right", value: (r) => r.grossFee, render: (r) => money(r.grossFee) },
    { key: "net", header: "Net Profit", type: "number", align: "right", value: (r) => r.netProfit, render: (r) => money(r.netProfit) },
    { key: "closed", header: "Closed", type: "date", value: (r) => r.closedDate, render: (r) => fmtDate(r.closedDate) },
  ];

  const CHIPS: [Period, string][] = [
    ["THIS_MONTH", "This Month"], ["LAST_MONTH", "Last Month"], ["THIS_YEAR", "This Year"], ["LAST_YEAR", "Last Year"], ["CUSTOM", "Custom"],
  ];

  return (
    <div className="page">
      <div className="page-header"><h1>Reports</h1></div>

      <div className="chip-row" style={{ marginBottom: 14 }}>
        {CHIPS.map(([p, label]) => <span key={p} className={`chip ${period === p ? "active" : ""}`} onClick={() => setPeriod(p)}>{label}</span>)}
      </div>
      {period === "CUSTOM" && (
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="field" style={{ marginBottom: 0 }}><label>From</label><input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>To</label><input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></div>
        </div>
      )}

      {!data ? <Spinner /> : (
        <>
          <div className="metrics-row" style={{ gridTemplateColumns: "repeat(6,1fr)" }}>
            <MetricCard label="Deals Closed" value={data.totals.dealsClosed} />
            <MetricCard label="Gross Fees" value={money(data.totals.grossFees)} />
            <MetricCard label="Net Profit" value={money(data.totals.netProfit)} />
            <MetricCard label="Avg Profit/Deal" value={money(data.totals.avgProfitPerDeal)} />
            <MetricCard label="Avg Deal Size" value={money(data.totals.avgDealSize)} />
            <MetricCard label="Win Rate" value={pct(data.winRate)} hint={`vs ${data.deadInPeriod} dead`} />
          </div>

          <div className="panel">
            <h3>Closed deals in period</h3>
            <SortableTable
              columns={columns}
              rows={data.rows}
              rowKey={(r) => r.id}
              onRowClick={(r) => nav(`/deals/${r.id}`)}
              defaultSort={{ key: "closed", dir: "desc" }}
              empty="No deals closed in this period."
            />
            {data.rows.length > 0 && (
              <div className="table-scroll" style={{ marginTop: -1 }}>
                <table className="data-table">
                  <tfoot>
                    <tr>
                      <td>Totals ({data.totals.dealsClosed})</td><td></td><td></td><td></td>
                      <td className="right">{money(data.rows.reduce((s, r) => s + (r.acceptedAmount ?? 0), 0))}</td>
                      <td className="right">{money(data.totals.grossFees)}</td>
                      <td className="right">{money(data.totals.netProfit)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
