import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";
import { abstractLabelSql } from "../routes/gis.js";
import { abstractNumber } from "../domain/abstractLabel.js";
import { abstractNumbers, joinSurveys, parseLegalGeography, surveyName } from "../domain/researchGeo.js";
import { surveyKey } from "../domain/researchFields.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** (county, abstract number) → the survey it lies in, or null when unknown / not unique. */
export type SurveyLookup = (county: string, abstractNo: string) => string | null;

/**
 * Survey names from the GIS abstract layer for Texas counties. In Texas an
 * abstract number identifies a tract within its county, so county + number
 * names the survey; a number the layer gives more than one survey for in the
 * county is left out rather than guessed. Louisiana sections are not looked
 * up (a section number recurs in every township). No GIS schema → no lookups.
 */
/**
 * The Survey field for a record's abstracts: each abstract's survey, joined
 * (researchGeo.SURVEY_SEP) — but only when EVERY abstract names one, so a
 * record never shows some of its surveys as if they were all.
 */
export function surveysFor(lookup: SurveyLookup, county: string, abstractNos: readonly string[]): string | null {
  if (!abstractNos.length) return null;
  const names = abstractNos.map((n) => lookup(county, n));
  return names.every(Boolean) ? joinSurveys(names) : null;
}

export async function gisSurveyLookup(db: Db, counties: readonly string[]): Promise<SurveyLookup> {
  const wanted = [...new Set(counties.map((c) => c.trim().toLowerCase()).filter(Boolean))];
  const none: SurveyLookup = () => null;
  if (!wanted.length) return none;
  let rows: { abstract: string | null; survey: string | null; county: string }[];
  try {
    rows = await db.$queryRawUnsafe(
      `SELECT ${abstractLabelSql("gis_a")} AS abstract, gis_a.survey, gis_a.county FROM gis.abstracts gis_a
        WHERE coalesce(gis_a.state, 'TX') = 'TX' AND lower(gis_a.county) = ANY($1::text[]) AND gis_a.survey IS NOT NULL`,
      wanted,
    );
  } catch {
    return none; // gis schema absent (fresh database) — nothing to look up
  }
  const surveys = new Map<string, Set<string>>();
  for (const r of rows) {
    const n = abstractNumber(r.abstract);
    const s = surveyName(r.survey);
    if (!n || !s) continue;
    const k = `${r.county.toLowerCase()}|${n}`;
    surveys.set(k, (surveys.get(k) ?? new Set()).add(s));
  }
  return (county, abstractNo) => {
    const hit = surveys.get(`${county.toLowerCase()}|${abstractNumber(abstractNo)}`);
    return hit && hit.size === 1 ? [...hit][0] : null;
  };
}

/** (county, survey name) → the abstract numbers that survey covers there; empty when unknown. */
export type AbstractLookup = (county: string, survey: string) => string[];

/**
 * Abstract numbers for a survey name from the GIS abstract layer (Texas): the
 * reverse of gisSurveyLookup, matched on the survey's letters only so "J N
 * BLACK" (a county index) finds "BLACK, J N" (the layer). The caller decides
 * what to do with several abstracts per survey (the import takes only a single
 * match — anything else stays blank).
 */
export async function gisAbstractLookup(db: Db, counties: readonly string[]): Promise<AbstractLookup> {
  const wanted = [...new Set(counties.map((c) => c.trim().toLowerCase()).filter(Boolean))];
  const none: AbstractLookup = () => [];
  if (!wanted.length) return none;
  let rows: { abstract: string | null; survey: string | null; county: string }[];
  try {
    rows = await db.$queryRawUnsafe(
      `SELECT ${abstractLabelSql("gis_a")} AS abstract, gis_a.survey, gis_a.county FROM gis.abstracts gis_a
        WHERE coalesce(gis_a.state, 'TX') = 'TX' AND lower(gis_a.county) = ANY($1::text[]) AND gis_a.survey IS NOT NULL`,
      wanted,
    );
  } catch {
    return none;
  }
  const byKey = new Map<string, Set<string>>();
  for (const r of rows) {
    const n = abstractNumber(r.abstract);
    const k = surveyKey(surveyName(r.survey));
    if (!n || !k || !/\d/.test(n)) continue;
    const key = `${r.county.toLowerCase()}|${k}`;
    byKey.set(key, (byKey.get(key) ?? new Set()).add(n));
  }
  return (county, survey) => [...(byKey.get(`${county.toLowerCase()}|${surveyKey(surveyName(survey) ?? survey)}`) ?? [])];
}

/**
 * Abstract numbers for a record that names surveys but no abstract: each
 * survey must resolve to exactly ONE abstract in the county, else nothing
 * (a survey spanning several abstracts never picks one).
 */
export function abstractsForSurveys(lookup: AbstractLookup, county: string, surveys: readonly string[]): string[] {
  if (!surveys.length) return [];
  const out: string[] = [];
  for (const s of surveys) {
    const hits = lookup(county, s);
    if (hits.length !== 1) return [];
    if (!out.includes(hits[0])) out.push(hits[0]);
  }
  return out;
}

const BATCH = 500;

/**
 * Bring existing Research records to the three-field geography (boot,
 * idempotent; fills blanks only — nothing recorded is overwritten):
 *  1. Documents: `abstractIds` holds abstract NUMBERS ("A-923" → "923"),
 *     re-derived from the cell as recorded (`abstractId`, which never
 *     changes). A record with no abstract or survey but a legal description
 *     that names them explicitly takes them from it (parseLegalGeography).
 *  2. Documents and permits in Texas with no survey take the survey the GIS
 *     layer gives each of their abstracts in that county, when every one is
 *     unique (surveysFor).
 * Returns how many rows changed.
 */
export async function backfillResearchGeoFields(db: Db = prisma): Promise<number> {
  let updated = 0;

  // 1. Abstract numbers (+ blanks from the legal description).
  let cursor = "";
  for (;;) {
    const rows = await db.$queryRaw<{ id: string; abstractId: string | null; abstractIds: string[]; survey: string | null; legalDescription: string | null }[]>`
      SELECT "id", "abstractId", "abstractIds", "survey", "legalDescription" FROM "ResearchDocument"
      WHERE "id" > ${cursor} ORDER BY "id" LIMIT ${BATCH}`;
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    for (const r of rows) {
      const legal = r.legalDescription && (!r.abstractId || !r.survey) ? parseLegalGeography(r.legalDescription) : null;
      const ids = r.abstractId ? abstractNumbers(r.abstractId) : legal?.abstracts.length ? legal.abstracts : r.abstractIds;
      const survey = r.survey ?? legal?.survey ?? null;
      const sameIds = ids.length === r.abstractIds.length && ids.every((x, i) => x === r.abstractIds[i]);
      if (sameIds && survey === r.survey) continue;
      await db.researchDocument.update({ where: { id: r.id }, data: { abstractIds: ids, survey } });
      updated++;
    }
  }

  // 2. Survey names from the GIS layer (documents, then permits).
  const docs = await db.researchDocument.findMany({
    where: { survey: null, state: "TX", NOT: { abstractIds: { isEmpty: true } } },
    select: { id: true, county: true, abstractIds: true },
  });
  const permits = await db.researchPermit.findMany({
    where: { survey: null, state: "TX", abstractId: { not: null } },
    select: { id: true, county: true, abstractId: true },
  });
  if (!docs.length && !permits.length) return updated;
  const lookup = await gisSurveyLookup(db, [...docs, ...permits].map((r) => r.county));
  const group = (rows: { id: string; county: string; nums: string[] }[]) => {
    const bySurvey = new Map<string, string[]>();
    for (const r of rows) {
      const s = surveysFor(lookup, r.county, r.nums);
      if (s) bySurvey.set(s, [...(bySurvey.get(s) ?? []), r.id]);
    }
    return bySurvey;
  };
  for (const [survey, ids] of group(docs.map((d) => ({ id: d.id, county: d.county, nums: d.abstractIds })))) {
    for (let i = 0; i < ids.length; i += BATCH) {
      updated += (await db.researchDocument.updateMany({ where: { id: { in: ids.slice(i, i + BATCH) }, survey: null }, data: { survey } })).count;
    }
  }
  for (const [survey, ids] of group(permits.map((p) => ({ id: p.id, county: p.county, nums: abstractNumbers(p.abstractId) })))) {
    for (let i = 0; i < ids.length; i += BATCH) {
      updated += (await db.researchPermit.updateMany({ where: { id: { in: ids.slice(i, i + BATCH) }, survey: null }, data: { survey } })).count;
    }
  }
  return updated;
}
