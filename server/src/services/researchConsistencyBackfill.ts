import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";
import { PARTY_RULES_VERSION, documentPartyFields, parsePartyCell } from "../domain/research.js";
import { normState, titleCounty } from "../domain/researchIngest.js";
import { nameSimilarity } from "../domain/researchBuyers.js";

/**
 * One-time, idempotent cleanup of research records and buyer profiles imported
 * before the current normalization rules. Runs at startup, in small batches,
 * and only ever rewrites rows that would come out differently today:
 *
 *  1. Geography: state → USPS code ("Texas"/"TEXAS" → "TX"), county → the bare
 *     title-cased name ("LEON COUNTY" / "Leon, TX" → "Leon"), on research
 *     documents, permits and import runs, so "Leon, Texas" and "Leon, TX" are
 *     one place everywhere that groups or filters by county.
 *  2. Participants: every row derived under an older parser (partyRulesVersion
 *     below PARTY_RULES_VERSION) is re-derived through the same
 *     documentPartyFields() the importer uses — names, keys, conveyed
 *     interests and annotations alike — then stamped with the current
 *     version, so each rule change costs one pass. The recorded cell is never
 *     changed.
 *  3. Buyer aliases: an alias that names SEVERAL parties ("ABC LLC; XYZ LP",
 *     a whole grantee cell saved as one alias) can never match a transaction
 *     and makes the profile look like a group. It is replaced by the one
 *     party that is this buyer (a spelling of its name) or dropped, and the
 *     change is written to the buyer's activity log. Names a user typed for
 *     a single party are untouched.
 *
 * Logs counts only — never names.
 */

const BATCH = 500;

type Db = PrismaClient | Prisma.TransactionClient;

export async function backfillResearchGeography(db: Db = prisma): Promise<number> {
  let updated = 0;
  for (const table of ["ResearchDocument", "ResearchPermit"] as const) {
    let cursor = "";
    for (;;) {
      const rows = await db.$queryRaw<{ id: string; state: string; county: string }[]>(
        Prisma.sql`SELECT "id", "state", "county" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" > ${cursor} ORDER BY "id" LIMIT ${BATCH}`,
      );
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;
      const writes: Prisma.Sql[] = [];
      for (const r of rows) {
        const state = r.state ? normState(r.state) : r.state;
        const county = r.county ? titleCounty(r.county) : r.county;
        if (state === r.state && county === r.county) continue;
        writes.push(Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET "state" = ${state}, "county" = ${county} WHERE "id" = ${r.id}`);
      }
      for (const w of writes) await db.$executeRaw(w);
      updated += writes.length;
    }
  }
  const runs = await db.$queryRaw<{ id: string; state: string | null; county: string | null }[]>`
    SELECT "id", "state", "county" FROM "ResearchIngestRun" WHERE "state" IS NOT NULL OR "county" IS NOT NULL`;
  for (const r of runs) {
    const state = r.state ? normState(r.state) : r.state;
    const county = r.county ? titleCounty(r.county) : r.county;
    if (state === r.state && county === r.county) continue;
    await db.$executeRaw`UPDATE "ResearchIngestRun" SET "state" = ${state}, "county" = ${county} WHERE "id" = ${r.id}`;
    updated++;
  }
  return updated;
}

export async function backfillResearchParticipants(db: Db = prisma): Promise<number> {
  let updated = 0;
  let cursor = "";
  for (;;) {
    // Every row whose party fields predate the current parser rules.
    const rows = await db.$queryRaw<{ id: string; grantor: string | null; grantee: string | null; grantorAsRecorded: string | null; granteeAsRecorded: string | null; grantorParties: string[]; granteeParties: string[]; partyInterests: unknown }[]>`
      SELECT "id", "grantor", "grantee", "grantorAsRecorded", "granteeAsRecorded", "grantorParties", "granteeParties", "partyInterests" FROM "ResearchDocument"
      WHERE "id" > ${cursor} AND "partyRulesVersion" < ${PARTY_RULES_VERSION}
      ORDER BY "id" LIMIT ${BATCH}`;
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    const writes: Prisma.PrismaPromise<unknown>[] = [];
    const unchanged: string[] = [];
    for (const r of rows) {
      // Derive from the cell as recorded when we still have it (the display
      // cell may already be cleaned), exactly as a fresh import would.
      const pf = documentPartyFields(r.grantorAsRecorded ?? r.grantor, r.granteeAsRecorded ?? r.grantee);
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
      const sameDetail = JSON.stringify(pf.partyInterests.length ? pf.partyInterests : null) === JSON.stringify(r.partyInterests ?? null);
      if (same(pf.grantorParties, r.grantorParties) && same(pf.granteeParties, r.granteeParties) && sameDetail) { unchanged.push(r.id); continue; }
      writes.push(db.researchDocument.update({
        where: { id: r.id },
        data: {
          grantor: pf.grantor, grantee: pf.grantee,
          grantorAsRecorded: pf.grantorAsRecorded != null ? (r.grantorAsRecorded ?? r.grantor) : r.grantorAsRecorded,
          granteeAsRecorded: pf.granteeAsRecorded != null ? (r.granteeAsRecorded ?? r.grantee) : r.granteeAsRecorded,
          grantorNorm: pf.grantorNorm, granteeNorm: pf.granteeNorm,
          grantorParties: pf.grantorParties, granteeParties: pf.granteeParties,
          grantorNorms: pf.grantorNorms, granteeNorms: pf.granteeNorms,
          interestPct: pf.interestPct,
          partyInterests: pf.partyInterests.length ? (pf.partyInterests as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          partyRulesVersion: PARTY_RULES_VERSION,
        },
      }));
    }
    // Rows already current are only stamped, so the next boot skips them.
    if (unchanged.length) writes.push(db.researchDocument.updateMany({ where: { id: { in: unchanged } }, data: { partyRulesVersion: PARTY_RULES_VERSION } }));
    if (writes.length) {
      await (db as PrismaClient).$transaction(writes);
      updated += writes.length - (unchanged.length ? 1 : 0);
    }
  }
  return updated;
}

/** The single party of `alias` that is this buyer, or null when the alias
 *  names several parties none of which is the buyer. */
export function resolveGroupAlias(alias: string, companyName: string): { keep: string | null; wasGroup: boolean } {
  const { parties } = parsePartyCell(alias);
  if (parties.length <= 1) return { keep: alias, wasGroup: false };
  const best = parties
    .map((p) => ({ name: p.name, score: nameSimilarity(companyName, p.name) }))
    .sort((a, b) => b.score - a.score)[0];
  return { keep: best && best.score >= 0.8 ? best.name : null, wasGroup: true };
}

export async function backfillBuyerGroupAliases(db: Db = prisma): Promise<number> {
  const buyers = await db.$queryRaw<{ id: string; organizationId: string | null; companyName: string; aliases: string[] }[]>`
    SELECT "id", "organizationId", "companyName", "aliases" FROM "Buyer"
    WHERE array_to_string("aliases", '|') ~* '[,;/&]| and '`;
  let updated = 0;
  for (const b of buyers) {
    const seen = new Set<string>([b.companyName.trim().toUpperCase()]);
    const aliases: string[] = [];
    let changed = false;
    let dropped = 0;
    for (const a of b.aliases) {
      const { keep, wasGroup } = resolveGroupAlias(a, b.companyName);
      if (wasGroup) changed = true;
      if (!keep) { dropped++; continue; }
      const k = keep.trim().toUpperCase();
      if (!k || seen.has(k)) { if (keep !== a) changed = true; continue; }
      seen.add(k);
      aliases.push(keep);
    }
    if (!changed) continue;
    await (db as PrismaClient).$transaction([
      db.buyer.update({ where: { id: b.id }, data: { aliases } }),
      db.activityLog.create({
        data: {
          organizationId: b.organizationId, buyerId: b.id, eventType: "BUYER_ALIAS_CLEANED",
          summary: dropped
            ? `Buyer aliases tidied: ${dropped} alias${dropped === 1 ? "" : "es"} naming several parties of one record removed (a group is not an alias)`
            : "Buyer aliases tidied: aliases naming several parties of one record reduced to this buyer's own name",
          metadata: { before: b.aliases, after: aliases },
        },
      }),
    ]);
    updated++;
  }
  return updated;
}

/** Boot entry point: all three passes, counts logged. */
export async function backfillResearchConsistency(): Promise<void> {
  const geography = await backfillResearchGeography();
  const participants = await backfillResearchParticipants();
  const aliases = await backfillBuyerGroupAliases();
  if (geography || participants || aliases) {
    // eslint-disable-next-line no-console
    console.log(`[research] consistency backfill: ${geography} geography row(s), ${participants} participant row(s), ${aliases} buyer alias list(s) updated`);
  }
}
