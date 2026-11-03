/**
 * Party parsing stays linear on pathological cells: deeply nested brackets
 * in one uploaded cell must not stall the server (security audit 2026-11-03),
 * and the import rejects oversized party cells before parsing them.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../db.js", () => ({ prisma: {} }));

import { documentPartyFields, parsePartyCell } from "./research.js";
import { ingestResearchCsv, MAX_PARTY_CELL_CHARS } from "./researchIngest.js";

const names = (raw: string) => parsePartyCell(raw).parties.map((p) => p.name);

describe("bracket masking", () => {
  it("parses 50k-deep nested brackets quickly", () => {
    const cell = "(".repeat(50_000) + ")".repeat(50_000);
    const t = performance.now();
    documentPartyFields(cell, cell);
    expect(performance.now() - t).toBeLessThan(500);
  });
  it("still keeps separators inside brackets from splitting", () => {
    expect(names("ABC LLC (by John Smith, Member)")).toHaveLength(1);
    expect(names("JOHN DOE (C/O JANE DOE, TRUSTEE)")).toHaveLength(1);
    expect(names("ABC LLC ((nested, note)); XYZ INC")).toHaveLength(2);
  });
  it("still splits a bracket that lists several shares", () => {
    expect(names("ABC INC ET AL (85%/JOHN DOE 5%/JANE DOE 10%)").length).toBeGreaterThan(1);
  });
});

describe("import party-cell cap", () => {
  const db = {
    researchDocument: { findMany: async () => [], createMany: async (a: { data: unknown[] }) => ({ count: a.data.length }) },
    researchPermit: { findMany: async () => [] },
    $queryRawUnsafe: async () => [],
  } as unknown as PrismaClient;
  const mapping = { docType: "Type", recordingDate: "Recorded", grantor: "Grantor", grantee: "Grantee", county: "County", state: "State" };

  it("rejects an oversized grantor cell and imports the rest", async () => {
    const long = "A".repeat(MAX_PARTY_CELL_CHARS + 1);
    const csv = ["Type,Recorded,Grantor,Grantee,County,State",
      `MINERAL DEED,03/12/2026,${long},Blackrock LLC,Leon,TX`,
      "MINERAL DEED,03/13/2026,Smith,Blackrock LLC,Leon,TX"].join("\n");
    const s = await ingestResearchCsv({
      prisma: db, organizationId: "org", createdByUserId: null, category: "deeds", csv, mapping, dryRun: true, previewRows: 10,
    });
    expect(s.preview!.map((r) => r.outcome)).toEqual(["REJECTED", "IMPORTED"]);
    expect(s.preview![0].reason).toMatch(/longer than/);
  });
});
