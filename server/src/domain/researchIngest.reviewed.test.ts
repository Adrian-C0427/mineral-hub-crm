/**
 * Research import — a deeds file reviewed row by row as mineral transfers.
 * The general instrument types the county index also uses for surface deals
 * import under the closest transfer type; everything else classifies as before.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../db.js", () => ({ prisma: {} }));

import { classifyDocType, classifyReviewedDocType } from "./research.js";
import { ingestResearchCsv } from "./researchIngest.js";

const kind = (raw: string) => {
  const c = classifyReviewedDocType(raw);
  return c && `${c.docType}/${c.docClass}`;
};

describe("classifyReviewedDocType", () => {
  it("files general transfer types under the closest type", () => {
    expect(kind("WARRANTY DEED")).toBe("WARRANTY_MINERAL_DEED/TRANSACTION");
    expect(kind("SPECIAL W/D")).toBe("WARRANTY_MINERAL_DEED/TRANSACTION");
    expect(kind("GENERAL W/D")).toBe("WARRANTY_MINERAL_DEED/TRANSACTION");
    expect(kind("QUIT CLAIM DEED")).toBe("QUITCLAIM_MINERAL_DEED/TRANSACTION");
    for (const t of ["DEED", "GIFT DEED", "SHERIFF'S DEED"]) expect(kind(t)).toBe("MINERAL_DEED/TRANSACTION");
    for (const t of ["ASSIGNMENT", "ASSIGNMENT & BILL OF SALE", "ASGMT &BILL SALE", "DEED & ASSIGN"]) expect(kind(t)).toBe("ASSIGNMENT/TRANSACTION");
    for (const t of ["CONVEYANCE", "CONV OF INTEREST"]) expect(kind(t)).toBe("MINERAL_CONVEYANCE/TRANSACTION");
    // A production payment is an O&G conveyance, recognised without the review switch.
    expect(kind("CONV PROD PAYMNT")).toBe("OG_CONVEYANCE/TRANSACTION");
    for (const t of ["CORRECTION", "STIPULATION OF INTEREST"]) expect(kind(t)).toBe("OTHER/TRANSACTION");
  });
  it("leaves types the plain classifier already knows unchanged", () => {
    for (const t of ["MINERAL DEED", "MIN & ROYALTY DEED", "MINERAL CONVEYNC", "ASG MINERAL INTR", "ASSIGNMENT OF LEASE", "OIL & GAS LEASE"]) {
      expect(classifyReviewedDocType(t)).toEqual(classifyDocType(t));
    }
  });
  it("still rejects financing, plats, easements and non-O&G leases", () => {
    for (const t of ["DEED OF TRUST", "RELEASE OF LIEN", "EASEMENT", "PLAT", "GRAZING LEASE", ""]) expect(kind(t)).toBeNull();
  });
  it("is opt-in: the plain classifier still skips general types", () => {
    expect(classifyDocType("WARRANTY DEED")).toBeNull();
    expect(classifyDocType("ASSIGNMENT")).toBeNull();
  });
});

describe("import with reviewedTransfers", () => {
  const db = {
    researchDocument: { findMany: async () => [], createMany: async (a: { data: unknown[] }) => ({ count: a.data.length }) },
    researchPermit: { findMany: async () => [] },
    $queryRawUnsafe: async () => [],
  } as unknown as PrismaClient;
  const mapping = { docType: "Type", recordingDate: "Recorded", grantor: "Grantor", grantee: "Grantee", county: "County", state: "State" };
  const csv = ["Type,Recorded,Grantor,Grantee,County,State",
    "WARRANTY DEED,03/12/2026,Smith,Blackrock LLC,Leon,TX",
    "ASSIGNMENT,03/13/2026,Jones,Blackrock LLC,Leon,TX",
    "DEED OF TRUST,03/14/2026,Brown,First Bank,Leon,TX",
    "ASSIGNMENT OF LEASE,03/15/2026,EAP LLC,Timberloch Resources LLC,Leon,TX",
    "MINERAL DEED,03/16/2026,Green,Blackrock LLC,Leon,TX"].join("\n");
  const run = (category: "deeds" | "leases", reviewedTransfers?: boolean) => ingestResearchCsv({
    prisma: db, organizationId: "org", createdByUserId: null, category, csv, mapping, dryRun: true, previewRows: 10, reviewedTransfers,
  });

  it("imports the reviewed general types and still skips the rest", async () => {
    const s = await run("deeds", true);
    expect(s.preview!.map((r) => [r.data.docType, r.outcome])).toEqual([
      ["WARRANTY DEED", "IMPORTED"], ["ASSIGNMENT", "IMPORTED"], ["DEED OF TRUST", "REJECTED"],
      ["ASSIGNMENT OF LEASE", "REJECTED"], ["MINERAL DEED", "IMPORTED"],
    ]);
    expect(s.preview![3].reason).toBe("Lease document — import under Leases");
  });
  it("without the switch, general types are skipped as before", async () => {
    const s = await run("deeds");
    expect(s.imported).toBe(1);
    expect(s.preview!.filter((r) => r.outcome === "REJECTED").map((r) => r.reason)).toContain('Not mineral-related: "WARRANTY DEED"');
  });
  it("has no effect on a Leases import", async () => {
    const s = await run("leases", true);
    expect(s.preview!.map((r) => r.outcome)).toEqual(["REJECTED", "REJECTED", "REJECTED", "IMPORTED", "REJECTED"]);
  });
});
