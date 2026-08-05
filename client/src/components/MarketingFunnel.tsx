import { money } from "../lib/format";

/**
 * Marketing funnel: Contacted → Interested → Offers → Highest Offer, with
 * conversion bars and the proceeds target. Shared by the Mineral Asset Sell
 * tab and the Deal Profile Buyers tab — one design, one formula.
 *
 * `costBasis` is what the proceeds target subtracts (asset: purchase price;
 * opportunity deal: our contracted price).
 */
export function MarketingFunnel({ metrics, matchCount, askPrice, costBasis }: {
  metrics: { buyersContacted: number; interested: number; offers: number; highOffer: number | null };
  matchCount: number;
  askPrice: number | null;
  costBasis: number | null;
}) {
  const contacted = metrics.buyersContacted;
  const proceeds = askPrice != null ? Math.round(askPrice * 0.97) - (costBasis ?? 0) : null;
  const pctOf = (v: number, of: number) => (of > 0 ? Math.min(100, Math.round((v / of) * 100)) : 0);
  const stages = [
    { label: "Contacted", value: String(contacted), hint: matchCount ? `of ${matchCount} matches` : "no matches yet", dim: !contacted, bar: "var(--accent)", w: pctOf(contacted, matchCount) },
    { label: "Interested", value: String(metrics.interested), hint: "replied positively", dim: !metrics.interested, bar: "var(--accent)", w: pctOf(metrics.interested, contacted) },
    { label: "Offers", value: String(metrics.offers), hint: "received", dim: !metrics.offers, bar: "#f5b04b", w: pctOf(metrics.offers, contacted) },
    { label: "Highest Offer", value: metrics.highOffer != null ? money(metrics.highOffer) : "—", hint: metrics.highOffer != null && proceeds != null ? `vs ${money(proceeds)} target` : proceeds != null ? `${money(proceeds)} target` : "no offers yet", dim: metrics.highOffer == null, bar: "var(--green)", w: metrics.highOffer != null && proceeds ? Math.min(100, Math.round((metrics.highOffer / proceeds) * 100)) : 0 },
  ];
  return (
    <div className="panel">
      <div className="section-head" style={{ alignItems: "baseline" }}>
        <h3 style={{ margin: 0 }}>Marketing Funnel</h3>
        <span className="muted" style={{ fontSize: 12 }}>Updates as you contact buyers below</span>
      </div>
      <div className="mf-grid">
        {stages.map((st) => (
          <div key={st.label} className="mf-stage">
            <div className="ddx-label">{st.label}</div>
            <div className="mf-row"><span className={`mf-v ${st.dim ? "dim" : ""}`}>{st.value}</span><span className="mf-h">{st.hint}</span></div>
            <div className="mf-bar"><div style={{ width: `${st.w}%`, background: st.bar }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
