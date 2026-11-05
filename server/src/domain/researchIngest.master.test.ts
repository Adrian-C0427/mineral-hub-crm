/**
 * Research import — county master files: PERCENT SOLD, survey ↔ abstract
 * pairs, source details, survey-only abstracts, and the "update existing
 * records" mode (in-place updates archived first; rows the file leaves out
 * tagged, never deleted).
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../db.js", () => ({ prisma: {} }));

import { ingestResearchCsv } from "./researchIngest.js";

const GIS = [
  { abstract: "A-80", survey: "BLACK, J N", county: "Leon" },
  { abstract: "A-542", survey: "MYERS, J", county: "Leon" },
  { abstract: "A-600", survey: "MYERS, J", county: "Leon" }, // J Myers spans two abstracts: never picked
];

const existing = (over: Record<string, unknown>) => ({
  id: "doc-1", state: "TX", county: "Leon", instrumentNumber: "2025-474610", recordingDate: new Date("2025-01-02T00:00:00Z"),
  docTypeRaw: "MINERAL DEED", docType: "MINERAL_DEED", docClass: "TRANSACTION",
  grantor: "MAXIMA MINERALS III LP", grantee: "NEW HORIZON OIL & GAS LTD", grantorAsRecorded: null, granteeAsRecorded: null,
  grantorParties: ["MAXIMA MINERALS III LP"], granteeParties: ["NEW HORIZON OIL & GAS LTD"],
  interestPct: null, volume: "2041", page: "46", abstractId: "80", abstractIds: ["80"], survey: "J. N. Black Survey",
  surveys: [], surveyAsRecorded: null, percentSold: null, percentSoldRaw: null, shareBasis: null, granteeStatedTotalPct: null,
  docFlags: [], countsAsAcquisition: true, tracts: null, txGroupKey: null, sourceRow: null,
  ...over,
});

function fakeDb(rows: ReturnType<typeof existing>[] = []) {
  const created: Record<string, unknown>[] = [];
  const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
  const archived: unknown[][] = [];
  const order: string[] = [];
  const db = {
    researchDocument: {
      findMany: async () => rows,
      createMany: async (a: { data: Record<string, unknown>[] }) => { created.push(...a.data); return { count: a.data.length }; },
      update: async (a: { where: { id: string }; data: Record<string, unknown> }) => { order.push(`update:${a.where.id}`); updates.push(a); return {}; },
    },
    researchPermit: { findMany: async () => [] },
    researchIngestRun: { create: async () => ({ id: "run-9" }), update: async () => ({}) },
    researchIngestRow: { createMany: async () => ({ count: 0 }) },
    $queryRawUnsafe: async (_sql: string, counties: string[]) => GIS.filter((g) => counties.includes(g.county.toLowerCase())),
    $executeRawUnsafe: async (_sql: string, ...params: unknown[]) => { order.push(`archive:${(params[2] as string[]).join(",")}`); archived.push(params); return 1; },
  };
  return { db: db as unknown as PrismaClient, created, updates, archived, order };
}

const HEADER = "GRANTOR,GRANTEE,DOC TYPE,RECORDED DATE,INSTRUMENT NUMBER,VOLUME,PAGE,ABSTRACT,COUNTY,STATE,PERCENT SOLD,SURVEY NAME,NOTES";
const mapping = {
  grantor: "GRANTOR", grantee: "GRANTEE", docType: "DOC TYPE", recordingDate: "RECORDED DATE", instrumentNumber: "INSTRUMENT NUMBER",
  volume: "VOLUME", page: "PAGE", abstractId: "ABSTRACT", county: "COUNTY", state: "STATE", percentSold: "PERCENT SOLD", survey: "SURVEY NAME",
};
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");
const ROW_1 = 'MAXIMA MINERALS III LP,"NEW HORIZON OIL & GAS LTD (30%); BERGSTROM PLACE MINERALS LLC (36%) [66% TOTAL]",MINERAL DEED,1/2/2025,2025-474610,2041,46,80,Leon,TX,66%,J N BLACK,checked';

describe("master-file columns", () => {
  it("stores percent sold apart from the shares, the tag, the pairs and every source column", async () => {
    const { db, created } = fakeDb();
    const s = await ingestResearchCsv({
      prisma: db, organizationId: "org", createdByUserId: null, category: "deeds", mapping,
      csv: csv(ROW_1, 'SMITH JOHN,ACME MINERALS LLC (100%),MINERAL DEED,1/3/2025,2025-474611,,,80; 542,Leon,TX,87.5%,J N BLACK; J MYERS,'),
    });
    expect(s.imported).toBe(2);
    expect(s.unmappedColumns).toEqual(["NOTES"]);
    const [a, b] = created;
    expect(a).toMatchObject({ percentSold: 66, percentSoldRaw: "66%", shareBasis: "absolute", granteeStatedTotalPct: 66, interestPct: 66 });
    expect(a.sourceRow).toMatchObject({ "PERCENT SOLD": "66%", NOTES: "checked" });
    expect(b).toMatchObject({ percentSold: 87.5, shareBasis: "of-conveyed", surveys: ["J. N. Black Survey", "J. Myers Survey"] });
    expect(b.tracts).toEqual([{ abstract: "80", survey: "J N BLACK" }, { abstract: "542", survey: "J MYERS" }]);
    expect(typeof b.txGroupKey).toBe("string");
  });

  it("flags corrections, keeps them, and never counts them as acquisitions", async () => {
    const { db, created } = fakeDb();
    await ingestResearchCsv({
      prisma: db, organizationId: "org", createdByUserId: null, category: "deeds", mapping,
      csv: csv("ESTATE OF JANE DOE,ACME LLC,COR MINERAL DEED,1/2/2025,2025-1,,,80,Leon,TX,100%,J N BLACK,"),
    });
    expect(created[0]).toMatchObject({ docFlags: ["correction", "estate-or-trust-seller"], countsAsAcquisition: false });
  });

  it("fills an abstract from the survey layer only when the survey has exactly one", async () => {
    const { db, created } = fakeDb();
    await ingestResearchCsv({
      prisma: db, organizationId: "org", createdByUserId: null, category: "deeds", mapping,
      csv: csv("A,B LLC,MINERAL DEED,1/2/2025,2025-2,,,,Leon,TX,100%,J N BLACK,", "C,D LLC,MINERAL DEED,1/2/2025,2025-3,,,,Leon,TX,100%,J MYERS,"),
    });
    expect(created[0]).toMatchObject({ abstractIds: ["80"], abstractSource: "survey-lookup", abstractId: null });
    expect(created[1]).toMatchObject({ abstractIds: [], abstractSource: null });
  });
});

describe("update existing records (master file)", () => {
  it("previews updates, new rows and the existing records the file leaves out", async () => {
    const left = existing({ id: "doc-2", instrumentNumber: "2025-474700", recordingDate: new Date("2025-01-02T12:00:00Z") });
    const { db } = fakeDb([existing({}), left]);
    const s = await ingestResearchCsv({
      prisma: db, organizationId: "org", createdByUserId: null, category: "deeds", mapping, dryRun: true, previewRows: 5, replaceExisting: true,
      csv: csv(ROW_1, "A,B LLC,MINERAL DEED,1/2/2025,2025-999,,,80,Leon,TX,100%,J N BLACK,"),
    });
    expect(s).toMatchObject({ updated: 1, imported: 1, outsideFile: 1 });
    expect(s.preview![0]).toMatchObject({ outcome: "UPDATED" });
    expect(s.preview![0].reason).toContain("percent sold");
  });

  it("archives before it updates, keeps the id, and tags (never deletes) the left-out record", async () => {
    const left = existing({ id: "doc-2", instrumentNumber: "2025-474700" });
    const { db, created, updates, order } = fakeDb([existing({}), left]);
    const s = await ingestResearchCsv({
      prisma: db, organizationId: "org", createdByUserId: null, category: "deeds", mapping, replaceExisting: true, csv: csv(ROW_1),
    });
    expect(s).toMatchObject({ updated: 1, imported: 0, outsideFile: 1 });
    expect(created).toHaveLength(0);
    expect(order).toEqual(["archive:doc-1", "update:doc-1", "archive:doc-2", "update:doc-2"]);
    const u = updates.find((x) => x.where.id === "doc-1")!.data;
    expect(u).toMatchObject({ percentSold: 66, updatedByRunId: "run-9" });
    expect(u).not.toHaveProperty("ingestRunId"); // the creating import stays with the record
    expect(u).not.toHaveProperty("organizationId");
    expect(updates.find((x) => x.where.id === "doc-2")!.data).toMatchObject({ docFlags: ["outside-master-list"], countsAsAcquisition: false });
  });

  it("an unchanged row is reported unchanged; a repeated instrument is rejected", async () => {
    const { db } = fakeDb([]);
    const s = await ingestResearchCsv({
      prisma: db, organizationId: "org", createdByUserId: null, category: "deeds", mapping, dryRun: true, previewRows: 5, replaceExisting: true,
      csv: csv(ROW_1, ROW_1.replace("MAXIMA", "OTHER")),
    });
    expect(s.rejected).toBe(2);
    expect(s.preview![0].reason).toMatch(/more than once/);
  });
});
