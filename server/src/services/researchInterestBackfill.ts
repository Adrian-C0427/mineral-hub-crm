import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";
import { documentPartyFields, extractInterest } from "../domain/research.js";
import { normalizeCompany } from "../serializers.js";

/**
 * Conveyed-interest backfill for records imported before interests were
 * extracted. County indexes often write the share into the party cell
 * ("ABC MINERALS LLC – 50%"), which made "ABC MINERALS LLC 50%" and
 * "ABC MINERALS LLC 25%" look like two different buyers.
 *
 * Runs at startup and is idempotent and LOSSLESS:
 *  - Research documents: re-derives every party field through the same
 *    documentPartyFields() the importer uses. The original cell is copied to
 *    grantorAsRecorded / granteeAsRecorded before the display name is cleaned,
 *    the share lands in interestPct / partyInterests, and nothing is deleted.
 *    A repaired row is never selected again (its *AsRecorded is set).
 *    Rows whose stored participants include a bare legal suffix (a comma
 *    before "LLC" once made "ABC, LLC" two parties, "ABC" and "LLC") are
 *    re-derived the same way; they stop matching once fixed.
 *  - Buyer profiles CREATED FROM RESEARCH whose name carried the share, and any
 *    buyer alias carrying one (aliases are recorded research spellings): the
 *    share is removed from the name and each change is written to the buyer's
 *    activity log with the previous name. Buyers a user created are never
 *    renamed.
 * Logs counts only — never names (party names are often private individuals).
 */

/** Cheap SQL prefilter: a digit followed by %, PCT/PERCENT, or a digit/digit
 *  fraction. The TypeScript extractor makes the actual decision. */
const CANDIDATE = String.raw`[0-9] *(%|pct|percent|per cent)|[0-9] */ *[0-9]`;
const BATCH = 500;
/** Participant keys that are only a legal suffix / party noise ("LLC"). */
const SUFFIX_NORMS = ["LLC", "L L C", "LP", "L P", "LLP", "LTD", "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LC", "PLLC",
  "ET UX", "ET AL", "ET VIR", "ETUX", "ETAL", "ETVIR"];

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function backfillResearchDocumentInterests(db: PrismaClient = prisma): Promise<number> {
  let updated = 0;
  let cursor = "";
  for (;;) {
    const rows = await db.$queryRaw<{
      id: string; grantor: string | null; grantee: string | null;
      grantorParties: string[]; granteeParties: string[]; grantorNorms: string[]; granteeNorms: string[];
    }[]>`
      SELECT "id", "grantor", "grantee", "grantorParties", "granteeParties", "grantorNorms", "granteeNorms"
      FROM "ResearchDocument"
      WHERE "id" > ${cursor}
        AND "grantorAsRecorded" IS NULL AND "granteeAsRecorded" IS NULL
        AND ("grantor" ~* ${CANDIDATE} OR "grantee" ~* ${CANDIDATE}
             OR "grantorNorms" && ${SUFFIX_NORMS}::text[] OR "granteeNorms" && ${SUFFIX_NORMS}::text[])
      ORDER BY "id" LIMIT ${BATCH}`;
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    const writes: Prisma.PrismaPromise<unknown>[] = [];
    for (const r of rows) {
      const pf = documentPartyFields(r.grantor, r.grantee);
      const unchanged = pf.grantorAsRecorded == null && pf.granteeAsRecorded == null &&
        same(pf.grantorParties, r.grantorParties) && same(pf.granteeParties, r.granteeParties) &&
        same(pf.grantorNorms, r.grantorNorms) && same(pf.granteeNorms, r.granteeNorms);
      if (unchanged) continue; // nothing to separate in this row
      writes.push(db.researchDocument.update({
        where: { id: r.id },
        data: {
          grantor: pf.grantor, grantee: pf.grantee,
          // As recorded: exactly the stored cell, for the side(s) that changed.
          grantorAsRecorded: pf.grantorAsRecorded != null ? r.grantor : null,
          granteeAsRecorded: pf.granteeAsRecorded != null ? r.grantee : null,
          grantorNorm: pf.grantorNorm, granteeNorm: pf.granteeNorm,
          grantorParties: pf.grantorParties, granteeParties: pf.granteeParties,
          grantorNorms: pf.grantorNorms, granteeNorms: pf.granteeNorms,
          interestPct: pf.interestPct,
          partyInterests: pf.partyInterests.length ? (pf.partyInterests as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        },
      }));
    }
    if (writes.length) {
      await db.$transaction(writes);
      updated += writes.length;
    }
  }
  return updated;
}

/** Name with the conveyed-interest share removed, or null when it has none. */
function cleanedName(name: string): string | null {
  const ex = extractInterest(name);
  return ex.pct != null && ex.name ? ex.name : null;
}

export async function backfillBuyerInterestNames(db: PrismaClient = prisma): Promise<number> {
  const buyers = await db.$queryRaw<{ id: string; organizationId: string | null; name: string; companyName: string; aliases: string[]; source: string | null }[]>`
    SELECT "id", "organizationId", "name", "companyName", "aliases", "source" FROM "Buyer"
    WHERE ("source" = 'research' AND "companyName" ~* ${CANDIDATE})
       OR array_to_string("aliases", '|') ~* ${CANDIDATE}`;
  let updated = 0;
  for (const b of buyers) {
    const newCompany = b.source === "research" ? cleanedName(b.companyName) : null;
    const company = newCompany ?? b.companyName;
    const seen = new Set<string>([company.trim().toUpperCase()]);
    const aliases: string[] = [];
    for (const a of b.aliases) {
      const v = cleanedName(a) ?? a;
      const k = v.trim().toUpperCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      aliases.push(v);
    }
    const aliasesChanged = aliases.length !== b.aliases.length || aliases.some((a, i) => a !== b.aliases[i]);
    if (!newCompany && !aliasesChanged) continue;
    await db.$transaction([
      db.buyer.update({
        where: { id: b.id },
        data: {
          ...(newCompany ? {
            companyName: newCompany,
            normalizedCompany: normalizeCompany(newCompany),
            ...(b.name === b.companyName ? { name: newCompany } : {}),
          } : {}),
          ...(aliasesChanged ? { aliases } : {}),
        },
      }),
      db.activityLog.create({
        data: {
          organizationId: b.organizationId, buyerId: b.id, eventType: "BUYER_NAME_CLEANED",
          summary: newCompany
            ? `Buyer name tidied: the recorded interest share was moved out of the name ("${b.companyName}" → "${newCompany}")`
            : "Buyer aliases tidied: recorded interest shares were moved out of the alias spellings",
        },
      }),
    ]);
    updated++;
  }
  return updated;
}

/** Boot entry point: both passes, counts logged. */
export async function backfillTransactionInterests(): Promise<void> {
  const documents = await backfillResearchDocumentInterests();
  const buyers = await backfillBuyerInterestNames();
  if (documents || buyers) {
    // eslint-disable-next-line no-console
    console.log(`[research] conveyed-interest backfill: ${documents} record(s), ${buyers} buyer profile(s) updated`);
  }
}
