import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { MetricCard, Banner, StageBadge, Spinner } from "../components/ui";
import { money, fmtDate, prettyStage } from "../lib/format";
import { NotificationsPanel } from "../components/NotificationsPanel";

interface DashboardData {
  metrics: { activeDeals: number; projectedProfit: number; closedProfitYtd: number; avgDealSize: number; offersPending: number };
  overdue: { id: string; name: string; findBuyerByDate: string | null }[];
  activeByStage: { id: string; name: string; stage: string; profitEst: number | null }[];
  upcomingFollowUps: { dealId: string; buyerName: string; dealName: string; date: string | null }[];
  recentActivity: { id: string; summary: string; createdAt: string }[];
  topBuyers: { id: string; name: string; companyName: string; volume: number }[];
  profitByMonth: { month: string; profit: number; projected: number }[];
}

export function Dashboard() {
  const [d, setD] = useState<DashboardData | null>(null);

  useEffect(() => { api.get<DashboardData>("/dashboard").then(setD); }, []);
  if (!d) return <Spinner />;

  const maxProfit = Math.max(1, ...d.profitByMonth.map((m) => Math.max(m.profit, m.projected)));
  // Brand-new workspace: no active deals and nothing closed yet. Guide the
  // first steps instead of presenting a wall of zeros.
  const firstRun = d.metrics.activeDeals === 0 && d.metrics.closedProfitYtd === 0 && d.recentActivity.length === 0;

  return (
    <div className="page">
      <div className="page-header"><h1>Dashboard</h1></div>

      <NotificationsPanel />

      {firstRun && (
        <div className="panel">
          <div className="panel-title"><h3>Get started</h3></div>
          <p className="muted" style={{ marginTop: 0 }}>
            Welcome to Mineral Hub! These metrics fill in as you work — here's where most teams begin:
          </p>
          <div className="row">
            <Link to="/deals/active" className="primary" style={{ padding: "8px 14px", borderRadius: 8 }}>1 · Create your first deal</Link>
            <Link to="/buyers" style={{ padding: "8px 14px", border: "1px solid var(--border)", borderRadius: 8 }}>2 · Add or import buyers</Link>
            <Link to="/valuation" style={{ padding: "8px 14px", border: "1px solid var(--border)", borderRadius: 8 }}>3 · Import well production data</Link>
          </div>
        </div>
      )}

      <div className="metrics-row">
        <MetricCard label="Active Deals" value={d.metrics.activeDeals} />
        <MetricCard label="Projected Profit" value={money(d.metrics.projectedProfit)} />
        <MetricCard label="Closed Profit YTD" value={money(d.metrics.closedProfitYtd)} />
        <MetricCard label="Avg Deal Size" value={money(d.metrics.avgDealSize)} />
        <MetricCard label="Offers Pending" value={d.metrics.offersPending} />
      </div>

      {d.overdue.length > 0 && (
        <Banner kind="warn">
          <strong>{d.overdue.length} deal{d.overdue.length > 1 ? "s" : ""} overdue</strong> — past the Find Buyer By date with no buyer assigned:{" "}
          {d.overdue.map((o, i) => (
            <span key={o.id}>{i > 0 ? ", " : ""}<Link to={`/deals/${o.id}`}>{o.name}</Link></span>
          ))}
        </Banner>
      )}

      <div className="grid-2">
        <div className="panel">
          <div className="panel-title"><h3>Active deals by stage</h3></div>
          {d.activeByStage.length === 0 ? <p className="muted">No active deals.</p> : d.activeByStage.map((x) => (
            <div className="list-row" key={x.id}>
              <Link to={`/deals/${x.id}`}>{x.name}</Link>
              <div className="row">
                <StageBadge stage={x.stage} />
                <span className="muted">{money(x.profitEst)}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="panel-title"><h3>Upcoming follow-ups</h3></div>
          {d.upcomingFollowUps.length === 0 ? <p className="muted">No follow-ups scheduled.</p> : d.upcomingFollowUps.map((f, i) => (
            <div className="list-row" key={i}>
              <span>{f.buyerName} · <Link to={`/deals/${f.dealId}`}>{f.dealName}</Link></span>
              <span className="muted">{fmtDate(f.date)}</span>
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="panel-title"><h3>Recent activity</h3></div>
          {d.recentActivity.length === 0 ? <p className="muted">Nothing yet.</p> : d.recentActivity.map((a) => (
            <div className="list-row" key={a.id}>
              <span>{a.summary}</span>
              <span className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDate(a.createdAt)}</span>
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="panel-title"><h3>Top buyers YTD</h3></div>
          {d.topBuyers.length === 0 ? <p className="muted">No closed volume yet.</p> : d.topBuyers.map((b, i) => (
            <div className="list-row" key={b.id}>
              <Link to={`/buyers/${b.id}`}>{i + 1}. {b.name} <span className="muted">· {b.companyName}</span></Link>
              <span>{money(b.volume)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <h3>Profit by month</h3>
          <div className="row" style={{ gap: 14, fontSize: 12 }}>
            <span className="row" style={{ gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--green)" }} /> Realized</span>
            <span className="row" style={{ gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--accent)", opacity: 0.6 }} /> Projected</span>
          </div>
        </div>
        {d.profitByMonth.every((m) => m.profit === 0 && m.projected === 0) ? (
          // All-zero year: identical baseline slivers would read as (flat) data.
          <p className="muted" style={{ margin: "8px 0 0" }}>
            No closed or projected profit this year yet — bars appear as deals close or get an accepted offer with a closing date.
          </p>
        ) : (
          <div className="bar-chart">
            {d.profitByMonth.map((m) => (
              <div className="bar-col" key={m.month} title={`Realized ${money(m.profit)} · Projected ${money(m.projected)}`}>
                <div className="bar-pair">
                  <div className="bar" style={{ height: `${(m.profit / maxProfit) * 100}%` }} />
                  <div className="bar bar-projected" style={{ height: `${(m.projected / maxProfit) * 100}%` }} />
                </div>
                <div className="bar-label">{m.month}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
