import { describe, expect, it } from "vitest";
import { abstractLabelSql, buildTileSql, isAbstractId, planExtentQuery, rrcWellDetail, sortAbstractOptions } from "./gis.js";

// The 2026-10 RRC refresh: bottom-hole tile layer, normalized status fields,
// and abstracts filtered by their GIS id (every abstract/survey combination
// separately) instead of a bare, collision-prone label.

describe("tile SQL after the RRC refresh", () => {
  it("adds a selectable bottom-hole layer and the status/profile/approximate fields", () => {
    const sql = buildTileSql(false, true);
    expect(sql.match(/ST_AsMVT\(bh_mvt, 'bottomholes'/g)?.length).toBe(1);
    expect(sql).toContain("FROM rrc.wellbores b");
    expect(sql).toContain("b.bh_geom && w.box");
    expect(sql).toContain('wl.profile AS profile, wl.status_flag AS "statusFlag"');
    expect(sql).toContain('coalesce(b.approximate, true) AS approximate');
    // The "?" of an unnumbered tract is never stripped any more.
    expect(sql).not.toContain("replace(");
  });

  it("before the refresh has run: no bottom holes, new columns as nulls", () => {
    const sql = buildTileSql(false, false);
    expect(sql).not.toContain("bottomholes");
    expect(sql).not.toContain("wl.profile");
    expect(sql).toContain("NULL::text AS profile");
  });

  it("keeps the TX and LA halves of every unioned layer the same width", () => {
    const sql = buildTileSql(true, true);
    const cols = (part: string) => part.slice(part.indexOf("SELECT"), part.indexOf("FROM")).split(/,(?![^(]*\))/).length;
    for (const [from, to] of [["well_mvt AS (", "bore_mvt AS ("], ["bore_mvt AS (", "bh_mvt AS ("], ["bh_mvt AS (", "dome_mvt AS ("]]) {
      const [tx, la] = sql.slice(sql.indexOf(from), sql.indexOf(to)).split("UNION ALL");
      expect(cols(la), from).toBe(cols(tx));
    }
  });
});

describe("abstract labels and ids", () => {
  it("restores an unnumbered tract's '?' from its id instead of stripping it", () => {
    const e = abstractLabelSql("a");
    expect(e).toContain("a.id LIKE 'TX-%?%'");
    expect(e).toContain("'A-' || substr(a.id, strpos(a.id, '?'))");
  });

  it("tells GIS ids from bare labels", () => {
    expect(isAbstractId("TX-289281")).toBe(true);
    expect(isAbstractId("TX-289?5")).toBe(true);
    expect(isAbstractId("TX-2897~2")).toBe(true);
    expect(isAbstractId("LA-22015-T14N-R9W-4")).toBe(true);
    expect(isAbstractId("A-281")).toBe(false);
    expect(isAbstractId("Sec 12")).toBe(false);
  });

  it("orders options numerically, each abstract/survey combination separately", () => {
    const o = (id: string, abstract: string | null, survey: string | null) => ({ id, abstract, survey, county: "Leon", state: "TX" });
    const sorted = sortAbstractOptions([o("TX-28922", "A-22", "SMITH, J"), o("TX-2895", "A-5", "BREWER, G"), o("TX-289?5", "A-?5", "STATE OF TEXAS"), o("TX-28922~2", "A-22", "JONES, K"), o("TX-289-NA-1", null, "VACANCY")]);
    expect(sorted.map((x) => x.id)).toEqual(["TX-2895", "TX-289?5", "TX-28922~2", "TX-28922", "TX-289-NA-1"]);
  });
});

describe("extent by abstract id", () => {
  it("frames abstracts by id", () => {
    const plan = planExtentQuery({ counties: "Leon", abstracts: ["TX-28925", "TX-289?5"] })!;
    expect(plan.sql).toContain("FROM gis.abstracts");
    expect(plan.sql).toContain("id = ANY($3::text[])");
    expect(plan.params).toEqual([["TX"], ["Leon"], ["TX-28925", "TX-289?5"]]);
  });

  it("frames wells by their abstract id; legacy labels still match, OR'd", () => {
    const plan = planExtentQuery({ abstracts: ["TX-28925", "A-25"], wellStatuses: "Producing" })!;
    expect(plan.sql).toBe("SELECT ST_Extent(geom)::text AS ext FROM rrc.wells WHERE (abstract_id = ANY($1::text[]) OR abstract = ANY($2::text[])) AND status = ANY($3::text[])");
    expect(plan.params).toEqual([["TX-28925"], ["A-25"], ["Producing"]]);
  });

  it("resolves a Louisiana section id to its section + township on sonris wells", () => {
    const plan = planExtentQuery({ abstracts: "LA-22081-T14N-R9W-4", wellTypes: "Gas" }, { sonris: true })!;
    expect(plan.sql).toContain("EXISTS (SELECT 1 FROM gis.abstracts la_a WHERE la_a.id = ANY($3::text[]) AND la_a.state = 'LA' AND la_a.abstract = 'Sec ' || section AND la_a.survey = township)");
  });
});

describe("well detail", () => {
  it("maps a stored row, tolerating a database without the refresh columns", () => {
    const d = rrcWellDetail({ fid: 1, api8: "28932181", api10: "4228932181", status: "Producing", status_detail: null, profile: "Horizontal" }, -96.2, 31.2);
    expect(d).toMatchObject({ fid: 1, api: "4228932181", status: "Producing", profile: "Horizontal", lon: -96.2, lat: 31.2 });
    expect(rrcWellDetail({ fid: 2 }, 0, 0)).toMatchObject({ fid: 2, statusDetail: null, profile: null, sources: null });
  });
});
