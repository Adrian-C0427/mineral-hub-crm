import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";
import type { PartyInterest } from "../domain/research.js";
import { splitSurveys } from "../domain/researchGeo.js";
import {
  countsAsAcquisition, DERIVED_FIELDS_VERSION, documentFlags, shareBasis, statedTotalPct, txGroupKey,
} from "../domain/researchFields.js";
import { abstractsForSurveys, gisAbstractLookup } from "./researchGeoFill.js";

type Db = PrismaClient | Prisma.TransactionClient;
const BATCH = 500;

interface Row {
  id: string; docClass: string; docTypeRaw: string; state: string; county: string; recordingDate: Date;
  grantor: string | null; grantorAsRecorded: string | null; grantee: string | null; granteeAsRecorded: string | null;
  grantorNorm: string | null; granteeNorm: string | null; abstractIds: string[]; abstractSource: string | null;
  survey: string | null; surveys: string[]; docFlags: string[]; percentSold: number | null; partyInterests: unknown;
}

/**
 * Bring every Research record's derived master-file fields to the current
 * definitions (domain/researchFields.ts) — once per row, versioned through
 * `derivedVersion` (boot, idempotent, additive: nothing recorded is changed):
 *   surveys[] (split from the stored Survey), flags + whether it counts as an
 *   acquisition, the "[x% TOTAL]" tag, the share basis, the same-day group key,
 *   and — for a Texas record naming surveys but no abstract — the abstract the
 *   county survey layer gives, when each survey has exactly one.
 * One bulk UPDATE per batch. Returns how many rows were written.
 */
export async function backfillResearchDerivedFields(db: Db = prisma): Promise<number> {
  let written = 0;
  let cursor = "";
  for (;;) {
    const rows = await db.$queryRaw<Row[]>`
      SELECT "id", "docClass"::text AS "docClass", "docTypeRaw", "state", "county", "recordingDate",
             "grantor", "grantorAsRecorded", "grantee", "granteeAsRecorded", "grantorNorm", "granteeNorm",
             "abstractIds", "abstractSource", "survey", "surveys", "docFlags", "percentSold", "partyInterests"
        FROM "ResearchDocument"
       WHERE "id" > ${cursor} AND "derivedVersion" < ${DERIVED_FIELDS_VERSION}
       ORDER BY "id" LIMIT ${BATCH}`;
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    const needAbstract = rows.filter((r) => r.state === "TX" && !r.abstractIds.length && (r.surveys.length || r.survey));
    const lookup = needAbstract.length ? await gisAbstractLookup(db, needAbstract.map((r) => r.county)) : null;

    const out = rows.map((r) => {
      const surveys = r.surveys.length ? r.surveys : splitSurveys(r.survey);
      let abstractIds = r.abstractIds;
      let abstractSource = r.abstractSource ?? (abstractIds.length ? "recorded" : null);
      if (lookup && r.state === "TX" && !abstractIds.length && surveys.length) {
        const ids = abstractsForSurveys(lookup, r.county, surveys);
        if (ids.length) { abstractIds = ids; abstractSource = "survey-lookup"; }
      }
      const flags = documentFlags(r.docTypeRaw, r.grantorAsRecorded ?? r.grantor, r.docFlags);
      return {
        id: r.id,
        surveys,
        abstractIds,
        abstractSource,
        docFlags: flags,
        countsAsAcquisition: countsAsAcquisition(flags),
        granteeStatedTotalPct: statedTotalPct(r.granteeAsRecorded ?? r.grantee),
        shareBasis: shareBasis(r.percentSold, (r.partyInterests as PartyInterest[] | null) ?? []),
        txGroupKey: txGroupKey({
          docClass: r.docClass, state: r.state, county: r.county, recordingDate: r.recordingDate,
          grantorNorm: r.grantorNorm, granteeNorm: r.granteeNorm, abstractIds,
        }),
      };
    });
    written += await db.$executeRawUnsafe(
      `UPDATE "ResearchDocument" d SET
         "surveys" = ARRAY(SELECT jsonb_array_elements_text(x.surveys)),
         "abstractIds" = ARRAY(SELECT jsonb_array_elements_text(x."abstractIds")),
         "abstractSource" = x."abstractSource",
         "docFlags" = ARRAY(SELECT jsonb_array_elements_text(x."docFlags")),
         "countsAsAcquisition" = x."countsAsAcquisition",
         "granteeStatedTotalPct" = x."granteeStatedTotalPct",
         "shareBasis" = x."shareBasis",
         "txGroupKey" = x."txGroupKey",
         "derivedVersion" = $2
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id text, surveys jsonb, "abstractIds" jsonb, "abstractSource" text, "docFlags" jsonb,
         "countsAsAcquisition" boolean, "granteeStatedTotalPct" double precision, "shareBasis" text, "txGroupKey" text)
       WHERE d.id = x.id`,
      JSON.stringify(out), DERIVED_FIELDS_VERSION,
    );
  }
  return written;
}
