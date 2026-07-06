import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { num } from "../../lib/format";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS, ASSET_TYPE_OPTIONS } from "../../lib/options";
import { SearchableMultiSelect } from "../../components/SearchableMultiSelect";
import { GeoFields } from "../../components/GeoFields";
import { PortalMap } from "./PortalMap";
import { PortalShell } from "./PortalOffering";
import { portalGet, portalPost, type FC, type PortalDeal, type PortalOrg } from "./portalApi";

const EMPTY_FC: FC = { type: "FeatureCollection", features: [] };

type SortKey = "featured" | "newest" | "nra" | "name";

/**
 * Public marketplace — every published PUBLIC offering for the org, with
 * search, multi-select filters, card/list views, an overview map, and the
 * "Don't see what you're looking for?" lead-capture form.
 */
export function PortalMarketplace() {
  const { orgSlug = "" } = useParams();
  const navigate = useNavigate();
  const [org, setOrg] = useState<PortalOrg | null>(null);
  const [deals, setDeals] = useState<PortalDeal[]>([]);
  const [features, setFeatures] = useState<FC>(EMPTY_FC);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [view, setView] = useState<"cards" | "list">("cards");
  const [sort, setSort] = useState<SortKey>("featured");
  const [fStates, setFStates] = useState<string[]>([]);
  const [fCounties, setFCounties] = useState<string[]>([]);
  const [fBasins, setFBasins] = useState<string[]>([]);
  const [fFormations, setFFormations] = useState<string[]>([]);
  const [fAssetTypes, setFAssetTypes] = useState<string[]>([]);
  const [fOperators, setFOperators] = useState<string[]>([]);
  const [nraMin, setNraMin] = useState("");
  const [nraMax, setNraMax] = useState("");

  useEffect(() => {
    portalGet<{ org: PortalOrg; deals: PortalDeal[] }>(`/${encodeURIComponent(orgSlug)}`)
      .then((d) => { setOrg(d.org); setDeals(d.deals); })
      .catch((e) => setError(e.message));
    portalGet<FC>(`/${encodeURIComponent(orgSlug)}/features`).then(setFeatures).catch(() => {});
  }, [orgSlug]);

  // Filter option lists derive from the live listings so they never dangle.
  const options = useMemo(() => {
    const uniq = (xs: string[]) => [...new Set(xs)].sort();
    return {
      states: uniq(deals.flatMap((d) => d.states)),
      counties: uniq(deals.flatMap((d) => d.counties)),
      operators: uniq(deals.map((d) => d.operator ?? "").filter(Boolean)),
    };
  }, [deals]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const min = Number(nraMin) || 0, max = Number(nraMax) || Infinity;
    const hit = (d: PortalDeal) =>
      (!needle || [d.name, d.summary ?? "", d.operator ?? "", ...d.counties, ...d.basins, ...d.formations].join(" ").toLowerCase().includes(needle)) &&
      (!fStates.length || d.states.some((s) => fStates.includes(s))) &&
      (!fCounties.length || d.counties.some((c) => fCounties.includes(c))) &&
      (!fBasins.length || d.basins.some((b) => fBasins.includes(b))) &&
      (!fFormations.length || d.formations.some((f) => fFormations.includes(f))) &&
      (!fAssetTypes.length || d.assetTypes.some((t) => fAssetTypes.includes(t))) &&
      (!fOperators.length || (d.operator != null && fOperators.includes(d.operator))) &&
      (d.nra == null ? min === 0 : d.nra >= min && d.nra <= max);
    const rows = deals.filter(hit);
    const cmp: Record<SortKey, (a: PortalDeal, b: PortalDeal) => number> = {
      featured: (a, b) => Number(b.featured) - Number(a.featured) || +new Date(b.listedAt) - +new Date(a.listedAt),
      newest: (a, b) => +new Date(b.listedAt) - +new Date(a.listedAt),
      nra: (a, b) => (b.nra ?? 0) - (a.nra ?? 0),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return rows.sort(cmp[sort]);
  }, [deals, q, fStates, fCounties, fBasins, fFormations, fAssetTypes, fOperators, nraMin, nraMax, sort]);

  if (error) return <PortalShell><div className="panel" style={{ textAlign: "center", padding: 48 }}><h2>Portal unavailable</h2><p className="muted">{error}</p></div></PortalShell>;

  return (
    <PortalShell org={org ?? undefined}>
      <div className="portal-hero panel" style={{ alignItems: "center" }}>
        <div>
          <h1 style={{ margin: "0 0 6px" }}>Available Mineral Opportunities</h1>
          <p className="muted" style={{ margin: 0 }}>{deals.length} active offering{deals.length === 1 ? "" : "s"} · Browse, filter, and reach out — we move fast.</p>
        </div>
        <input
          type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, county, basin, formation, operator…"
          style={{ maxWidth: 380, width: "100%" }} aria-label="Search opportunities"
        />
      </div>

      {/* Filters */}
      <div className="panel">
        <div className="dd-grid">
          {/* Marketplace filters scope to what's actually published (data-driven
              options), routed through the same component for consistent UX. */}
          <GeoFields
            states={fStates} onStatesChange={setFStates}
            counties={fCounties} onCountiesChange={setFCounties}
            countyOptions={options.counties.length ? options.counties : undefined}
            labels={{ state: "State", county: "County" }}
          />
          <div className="field"><label>Basin</label><SearchableMultiSelect options={[...TEXAS_BASIN_OPTIONS]} value={fBasins} onChange={setFBasins} placeholder="Any basin" /></div>
          <div className="field"><label>Formation</label><SearchableMultiSelect options={[...TEXAS_FORMATION_OPTIONS]} value={fFormations} onChange={setFFormations} placeholder="Any formation" /></div>
          <div className="field"><label>Asset type</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} value={fAssetTypes} onChange={setFAssetTypes} placeholder="Any type" /></div>
          <div className="field"><label>Operator</label><SearchableMultiSelect options={options.operators} value={fOperators} onChange={setFOperators} placeholder="Any operator" /></div>
          <div className="field"><label>NRA min</label><input type="number" min="0" value={nraMin} onChange={(e) => setNraMin(e.target.value)} placeholder="0" /></div>
          <div className="field"><label>NRA max</label><input type="number" min="0" value={nraMax} onChange={(e) => setNraMax(e.target.value)} placeholder="No max" /></div>
        </div>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <span className="muted">{filtered.length} of {deals.length} opportunities</span>
          <div className="row" style={{ gap: 8 }}>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={{ width: "auto" }}>
              <option value="featured">Featured first</option>
              <option value="newest">Newest</option>
              <option value="nra">Largest NRA</option>
              <option value="name">Name A–Z</option>
            </select>
            <button className={`small ${view === "cards" ? "primary" : ""}`} onClick={() => setView("cards")}>▦ Cards</button>
            <button className={`small ${view === "list" ? "primary" : ""}`} onClick={() => setView("list")}>☰ List</button>
          </div>
        </div>
      </div>

      {/* Overview map */}
      <div className="panel">
        <div className="section-head"><h3 style={{ margin: 0 }}>Where these opportunities are</h3><span className="muted">Click a highlighted property to open its offering</span></div>
        <PortalMap features={features} height={380} onSelect={(slug) => navigate(`/offer/${slug}`)} />
      </div>

      {/* Listings */}
      {filtered.length === 0 ? (
        <div className="panel" style={{ textAlign: "center", padding: 40 }}>
          <p className="muted" style={{ margin: 0 }}>No opportunities match those filters — try broadening, or tell us what you're looking for below.</p>
        </div>
      ) : view === "cards" ? (
        <div className="portal-cards">
          {filtered.map((d) => (
            <div key={d.slug} className="panel portal-card clickable" onClick={() => navigate(`/offer/${d.slug}`)}>
              {d.featured && <span className="badge resp-offer">Featured</span>}
              <h3 style={{ margin: "6px 0 2px" }}>{d.name}</h3>
              <div className="muted" style={{ fontSize: 13 }}>{d.counties.map((c) => `${c} County`).join(", ")}{d.states.length ? ` · ${d.states.join(", ")}` : ""}</div>
              <div className="portal-card-facts">
                {d.nra != null && <span><strong>{num(d.nra)}</strong> NRA</span>}
                {d.assetTypes.length > 0 && <span>{d.assetTypes.join("/")}</span>}
                {d.basins.length > 0 && <span>{d.basins[0]}</span>}
                {d.operator && <span>{d.operator}</span>}
              </div>
              {d.summary && <p className="muted portal-card-summary">{d.summary}</p>}
              <span className="portal-card-cta">View offering →</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel">
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Opportunity</th><th>County</th><th>State</th><th className="right">NRA</th><th>Asset</th><th>Basin</th><th>Operator</th></tr></thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.slug} className="clickable" onClick={() => navigate(`/offer/${d.slug}`)}>
                    <td><strong>{d.name}</strong>{d.featured ? " ★" : ""}</td>
                    <td>{d.counties.join(", ")}</td>
                    <td>{d.states.join(", ")}</td>
                    <td className="right">{d.nra != null ? num(d.nra) : "—"}</td>
                    <td>{d.assetTypes.join("/") || "—"}</td>
                    <td>{d.basins.join(", ") || "—"}</td>
                    <td>{d.operator ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <LeadCapture orgSlug={orgSlug} />
    </PortalShell>
  );
}

// ---------------------------------------------------------------------------
// "Don't see an opportunity that fits your needs?" — lead capture
// ---------------------------------------------------------------------------

function LeadCapture({ orgSlug }: { orgSlug: string }) {
  const [f, setF] = useState({
    companyName: "", contactName: "", email: "", phone: "", preferredContact: "either" as "email" | "phone" | "either",
    states: [] as string[], counties: [] as string[], basins: [] as string[], formations: [] as string[], assetTypes: [] as string[],
    minAcreage: "", maxAcreage: "", minPrice: "", maxPrice: "", additionalCriteria: "",
  });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!f.companyName.trim() || !f.contactName.trim() || !f.email.trim()) { setError("Company, contact name, and email are required."); return; }
    setBusy(true);
    try {
      await portalPost(`/${encodeURIComponent(orgSlug)}/leads`, {
        companyName: f.companyName, contactName: f.contactName, email: f.email, phone: f.phone,
        preferredContact: f.preferredContact,
        buyBox: {
          states: f.states, counties: f.counties, basins: f.basins, formations: f.formations, assetTypes: f.assetTypes,
          minAcreage: f.minAcreage ? Number(f.minAcreage) : null, maxAcreage: f.maxAcreage ? Number(f.maxAcreage) : null,
          minPrice: f.minPrice ? Number(f.minPrice) : null, maxPrice: f.maxPrice ? Number(f.maxPrice) : null,
        },
        additionalCriteria: f.additionalCriteria,
      });
      setDone(true);
    } catch (e2) { setError(e2 instanceof Error ? e2.message : "Submission failed"); }
    finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="panel portal-lead" style={{ textAlign: "center", padding: 40 }}>
        <h2 style={{ marginTop: 0 }}>Thank you — we've got it.</h2>
        <p className="muted" style={{ marginBottom: 0 }}>Your acquisition criteria are in front of our team. We'll reach out as soon as a matching opportunity surfaces.</p>
      </div>
    );
  }

  return (
    <div className="panel portal-lead">
      <h2 style={{ marginTop: 0 }}>Don't See an Opportunity That Fits Your Needs?</h2>
      <p className="muted">Tell us what you're looking for. We source new mineral and royalty opportunities every week — when something matches your buy box, you'll be the first call.</p>
      <form onSubmit={submit}>
        <div className="muted portal-lead-section">Contact information</div>
        <div className="dd-grid">
          <div className="field"><label>Company name *</label><input value={f.companyName} onChange={(e) => set("companyName")(e.target.value)} /></div>
          <div className="field"><label>Contact name *</label><input value={f.contactName} onChange={(e) => set("contactName")(e.target.value)} /></div>
          <div className="field"><label>Email *</label><input type="email" value={f.email} onChange={(e) => set("email")(e.target.value)} /></div>
          <div className="field"><label>Phone</label><input value={f.phone} onChange={(e) => set("phone")(e.target.value)} /></div>
          <div className="field"><label>Preferred contact</label>
            <select value={f.preferredContact} onChange={(e) => set("preferredContact")(e.target.value as typeof f.preferredContact)}>
              <option value="either">Either</option><option value="email">Email</option><option value="phone">Phone</option>
            </select>
          </div>
        </div>
        <div className="muted portal-lead-section">Your buy box</div>
        <div className="dd-grid">
          <GeoFields
            states={f.states} onStatesChange={set("states")}
            counties={f.counties} onCountiesChange={set("counties")}
            labels={{ state: "States", county: "Counties" }}
          />
          <div className="field"><label>Basins</label><SearchableMultiSelect options={[...TEXAS_BASIN_OPTIONS]} value={f.basins} onChange={set("basins")} placeholder="Any" /></div>
          <div className="field"><label>Formations</label><SearchableMultiSelect options={[...TEXAS_FORMATION_OPTIONS]} value={f.formations} onChange={set("formations")} placeholder="Any" /></div>
          <div className="field"><label>Asset types</label><SearchableMultiSelect options={[...ASSET_TYPE_OPTIONS]} value={f.assetTypes} onChange={set("assetTypes")} placeholder="Any" /></div>
          <div className="field"><label>Min acreage</label><input type="number" min="0" value={f.minAcreage} onChange={(e) => set("minAcreage")(e.target.value)} /></div>
          <div className="field"><label>Max acreage</label><input type="number" min="0" value={f.maxAcreage} onChange={(e) => set("maxAcreage")(e.target.value)} /></div>
          <div className="field"><label>Min deal size ($)</label><input type="number" min="0" value={f.minPrice} onChange={(e) => set("minPrice")(e.target.value)} /></div>
          <div className="field"><label>Max deal size ($)</label><input type="number" min="0" value={f.maxPrice} onChange={(e) => set("maxPrice")(e.target.value)} /></div>
        </div>
        <div className="field">
          <label>Anything else? (NRA range, abstracts, surveys, operator or well-status preferences, notes)</label>
          <textarea rows={3} value={f.additionalCriteria} onChange={(e) => set("additionalCriteria")(e.target.value)} />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className="primary" disabled={busy} style={{ marginTop: 8 }}>{busy ? "Submitting…" : "Submit my criteria"}</button>
      </form>
    </div>
  );
}
