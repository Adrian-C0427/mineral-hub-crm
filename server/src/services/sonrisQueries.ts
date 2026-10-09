import { prisma } from "../db.js";
import {
  isLaFid, LA_PRODUCT_LABEL, laParishLabel, sectionLabelOf, shapeUnitProduction, ymShift,
  type UnitProduction, type UnitProductionRow,
} from "../domain/sonrisWells.js";

/**
 * Read side of the Louisiana well data (sonris.*, loaded by
 * services/sonrisWells.ts): the map's well panel, search, and the Well
 * Analysis bridge all go through here. The SQL is exported by name so it can
 * be exercised directly against a PostGIS database.
 */

/** Unit production window: the last five years of reported months. */
export const UNIT_WINDOW_MONTHS = 60;

export const LA_WELL_SQL = {
  /** One well by map fid: $1 = fid. */
  detail: `SELECT fid, serial, api, name, well_no AS "wellNo", operator, operator_id AS "operatorId",
                  field, field_id AS "fieldId", status_code AS "statusCode", status_text AS "statusText",
                  status, type, symbol, product, class_type AS "classType",
                  spud_date::text AS "spudDate", permit_date::text AS "permitDate",
                  completion_date::text AS "completionDate", status_date::text AS "statusDate",
                  md, tvd, luw, section, township, parish,
                  location_quality AS "locationQuality", location_note AS "locationNote",
                  ST_X(geom) AS lon, ST_Y(geom) AS lat
             FROM sonris.wells WHERE fid = $1`,
  /** A well's surface → bottom-hole lines: $1 = surface fid. */
  bores: `SELECT fid, wellbore_type AS type, md, tvd, ST_Length(geom::geography) * 3.28084 AS "lengthFt"
            FROM sonris.wellbores WHERE surface_fid = $1 ORDER BY fid`,
  /** Every report line of one unit: $1 = LUW code. */
  unitRows: `SELECT ym, line, oil, condensate, gas, wells, luw_name AS "luwName", luw_type AS "luwType",
                    operator, state_flag AS "stateFlag"
               FROM sonris.production WHERE luw = $1 ORDER BY ym, line`,
  /** Latest reported month across the dataset (anchors the 5-year window). */
  latestMonth: `SELECT max(ym)::int AS mx FROM sonris.production`,
  /** Wells on the map that carry this unit: $1 = LUW code. */
  unitWells: `SELECT count(*)::int AS n FROM sonris.wells WHERE luw = $1`,
  /**
   * Map search: $1 = ILIKE pattern, $2 = raw term, $3 = the term's digits when
   * it is an identifier (serial / LUW / API, dashes and spaces dropped) or ''.
   * Exact identifiers first, then name matches, then operator/field matches.
   */
  suggest: `SELECT fid, serial, api, name, well_no AS "wellNo", operator, field, luw, status_text AS "statusText", parish,
                   type, ST_X(geom) AS lon, ST_Y(geom) AS lat,
                   GREATEST(similarity(name, $2), similarity(coalesce(operator, ''), $2), similarity(coalesce(field, ''), $2)) AS score
              FROM sonris.wells
             WHERE name ILIKE $1 ESCAPE '\\' OR operator ILIKE $1 ESCAPE '\\' OR field ILIKE $1 ESCAPE '\\'
                OR ($3 <> '' AND (serial::text = $3 OR luw = $3 OR api LIKE $3 || '%'))
             ORDER BY ($3 <> '' AND (serial::text = $3 OR luw = $3 OR api LIKE $3 || '%')) DESC,
                      (name ILIKE $1 ESCAPE '\\') DESC, score DESC, name
             LIMIT 60`,
  /** Unit series for several units at once (Well Analysis): $1 = LUW codes. */
  unitMonthly: `SELECT luw, ym, sum(oil)::float8 AS oil, sum(gas)::float8 AS gas
                  FROM sonris.production WHERE luw = ANY($1::text[])
                 GROUP BY luw, ym ORDER BY luw, ym`,
};

/** Digits of a term that reads as an identifier (serial, LUW, API), else ''. */
export function identifierDigits(q: string): string {
  const t = q.trim();
  return /^\d[\d\s-]*$/.test(t) ? t.replace(/[\s-]/g, "") : "";
}

export interface LaWellRecord {
  fid: number; serial: number; api: string | null; name: string; wellNo: string | null;
  operator: string | null; operatorId: string | null; field: string | null; fieldId: string | null;
  statusCode: string; statusText: string; status: string; type: string; symbol: string;
  product: string | null; classType: string | null;
  spudDate: string | null; permitDate: string | null; completionDate: string | null; statusDate: string | null;
  md: number | null; tvd: number | null; luw: string | null; section: number | null; township: string | null; parish: string;
  locationQuality: "ok" | "flag"; locationNote: string | null; lon: number; lat: number;
}

export async function laWellRecord(fid: number): Promise<LaWellRecord | null> {
  if (!isLaFid(fid)) return null;
  const rows = await prisma.$queryRawUnsafe<LaWellRecord[]>(LA_WELL_SQL.detail, fid);
  return rows[0] ?? null;
}

export interface LaUnitSummary extends UnitProduction {
  luw: string;
  /** Wells in the map data that carry this unit code. */
  mappedWells: number;
  window: { from: number; to: number };
}

/** A unit's last-five-years production (null when the well has no unit). */
export async function laUnitProduction(luw: string | null): Promise<LaUnitSummary | null> {
  if (!luw) return null;
  const [rows, latest, mapped] = await Promise.all([
    prisma.$queryRawUnsafe<UnitProductionRow[]>(LA_WELL_SQL.unitRows, luw),
    prisma.$queryRawUnsafe<{ mx: number | null }[]>(LA_WELL_SQL.latestMonth),
    prisma.$queryRawUnsafe<{ n: number }[]>(LA_WELL_SQL.unitWells, luw),
  ]);
  const to = latest[0]?.mx ?? 0;
  const from = to ? ymShift(to, -(UNIT_WINDOW_MONTHS - 1)) : 0;
  return { luw, mappedWells: Number(mapped[0]?.n ?? 0), window: { from, to }, ...shapeUnitProduction(rows, from, to || 999912) };
}

/**
 * The /api/gis/wells/:fid payload for a Louisiana well. Carries the generic
 * well-panel keys (leaseName, abstract, survey, county, api8…) so the shared
 * client mapping still reads it, plus the Louisiana record and its unit.
 */
export function shapeLaWellDetail(
  w: LaWellRecord,
  bores: { fid: number; type: string; md: number | null; tvd: number | null; lengthFt: number }[],
  unit: LaUnitSummary | null,
) {
  return {
    state: "LA" as const,
    fid: w.fid, serial: w.serial, api: w.api ?? "", api8: null,
    name: w.name, leaseName: w.name, wellNo: w.wellNo,
    operator: w.operator, operatorId: w.operatorId, field: w.field, fieldId: w.fieldId,
    statusCode: w.statusCode, statusText: w.statusText, status: w.status, type: w.type, symbol: w.symbol,
    product: w.product, productLabel: w.product ? LA_PRODUCT_LABEL[w.product] ?? null : null, classType: w.classType,
    spudDate: w.spudDate, permitDate: w.permitDate, completionDate: w.completionDate, statusDate: w.statusDate,
    md: w.md, tvd: w.tvd,
    section: w.section, abstract: sectionLabelOf(w.section), survey: w.township, township: w.township,
    county: w.parish, parish: w.parish, location: laParishLabel(w.parish),
    lon: w.lon, lat: w.lat,
    locationQuality: w.locationQuality, locationNote: w.locationNote,
    luw: w.luw,
    bores: bores.map((b) => ({ fid: b.fid, type: b.type, md: b.md, tvd: b.tvd, lengthFt: Math.round(Number(b.lengthFt)) })),
    unit,
  };
}

export async function laWellDetail(fid: number) {
  const w = await laWellRecord(fid);
  if (!w) return null;
  const [bores, unit] = await Promise.all([
    prisma.$queryRawUnsafe<{ fid: number; type: string; md: number | null; tvd: number | null; lengthFt: number }[]>(LA_WELL_SQL.bores, w.fid),
    laUnitProduction(w.luw),
  ]);
  return shapeLaWellDetail(w, bores, unit);
}
