/**
 * Research import — location fields. A dry run (the import preview) against a
 * fake database: Abstract, Survey Name and County land as three separate,
 * standardized values; a blank survey is filled from the GIS abstract layer
 * only where county + abstract number name exactly one survey; a combined
 * location column mapped to all three gives each field its own part.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../db.js", () => ({ prisma: {} }));

import { ingestResearchCsv } from "./researchIngest.js";
import { gisSurveyLookup } from "../services/researchGeoFill.js";

const GIS = [
  { abstract: "A-923", survey: "WARNICK, J", county: "Leon" },
  { abstract: "A-311", survey: "RAGSDALE, T", county: "Leon" },
  { abstract: "A-15", survey: "SMITH, A", county: "Leon" },
  { abstract: "A-15", survey: "JONES, B", county: "Leon" }, // two surveys for one number: not unique
];
function fakeDb() {
  const created: unknown[] = [];
  const db = {
    researchDocument: { findMany: async () => [], createMany: async (a: { data: unknown[] }) => { created.push(...a.data); return { count: a.data.length }; } },
    researchPermit: { findMany: async () => [] },
    $queryRawUnsafe: async (_sql: string, counties: string[]) => GIS.filter((g) => counties.includes(g.county.toLowerCase())),
  };
  return { db: db as unknown as PrismaClient, created };
}

const csv = (header: string, ...rows: string[]) => [header, ...rows].join("\n");
const mapping = { docType: "Type", recordingDate: "Recorded", grantor: "Grantor", grantee: "Grantee", abstractId: "Abstract", survey: "Survey", county: "County" };

describe("import preview: Abstract / Survey Name / County", () => {
  it("stores and shows the abstract number, the standardized survey and County, ST", async () => {
    const { db } = fakeDb();
    const s = await ingestResearchCsv({
      prisma: db, organizationId: "org", createdByUserId: null, category: "deeds", dryRun: true, previewRows: 5, mapping,
      csv: csv("Type,Recorded,Grantor,Grantee,Abstract,Survey,County",
        'Mineral Deed,03/12/2026,Smith,Blackrock LLC,A-923,"WARNICK, J","Leon County, Texas"',
        "Mineral Deed,03/13/2026,Jones,Blackrock LLC,ABST 0923,,Leon County Texas",
        "Mineral Deed,03/14/2026,Brown,Blackrock LLC,A-15,,Leon County TX",
        "Mineral Deed,03/15/2026,Green,Blackrock LLC,,,Leon County TX"),
    });
    expect(s.imported).toBe(4);
    const geo = s.preview!.map((r) => [r.data.abstract, r.data.surveyName, r.data.countyLabel]);
    expect(geo).toEqual([
      ["923", "J. Warnick Survey", "Leon, TX"],
      ["923", "J. Warnick Survey", "Leon, TX"], // survey from the GIS layer (county + number)
      ["15", "", "Leon, TX"], // two surveys for A-15 in Leon: left blank, not guessed
      ["", "", "Leon, TX"], // nothing to look up
    ]);
    // The source cells stay in the review trail exactly as mapped.
    expect(s.preview![1].data).toMatchObject({ abstractId: "ABST 0923", survey: "", county: "Leon County Texas" });
  });

  it("a record over several abstracts lists every survey — only when each one is known", async () => {
    const { db } = fakeDb();
    const s = await ingestResearchCsv({
      prisma: db, organizationId: "org", createdByUserId: null, category: "deeds", dryRun: true, previewRows: 5, mapping,
      csv: csv("Type,Recorded,Grantor,Grantee,Abstract,Survey,County",
        'Mineral Deed,03/12/2026,Smith,Blackrock LLC,"A-923, A-311",,"Leon County, Texas"',
        'Mineral Deed,03/13/2026,Jones,Blackrock LLC,"A-923, A-15",,"Leon County, Texas"',
        'Mineral Deed,03/14/2026,Brown,Blackrock LLC,923,"WARNICK, J; RAGSDALE, T","Leon County, Texas"'),
    });
    expect(s.preview!.map((r) => [r.data.abstract, r.data.surveyName])).toEqual([
      ["923, 311", "J. Warnick Survey; T. Ragsdale Survey"],
      ["923, 15", ""], // A-15 isn't unique: no partial list
      ["923", "J. Warnick Survey; T. Ragsdale Survey"], // a survey cell listing two
    ]);
  });

  it("a combined location column mapped to all three fields", async () => {
    const { db } = fakeDb();
    const loc = "Abstract 923 · J. Warnick Survey · Leon County, Texas";
    const s = await ingestResearchCsv({
      prisma: db, organizationId: "org", createdByUserId: null, category: "deeds", dryRun: true, previewRows: 5,
      mapping: { ...mapping, abstractId: "Location", survey: "Location", county: "Location" },
      csv: csv("Type,Recorded,Grantor,Grantee,Location", `Mineral Deed,03/12/2026,Smith,Blackrock LLC,"${loc}"`),
    });
    expect(s.preview![0].data).toMatchObject({ abstract: "923", surveyName: "J. Warnick Survey", countyLabel: "Leon, TX" });
  });

  it("writes the three fields separately (the combined text is kept as the legal description)", async () => {
    const { db, created } = fakeDb();
    (db as unknown as { researchIngestRun: unknown }).researchIngestRun = { create: async () => ({ id: "run1" }), update: async () => ({}) };
    (db as unknown as { researchIngestRow: unknown }).researchIngestRow = { createMany: async () => ({ count: 1 }) };
    const loc = "A-923 J. WARNICK SURVEY, LEON COUNTY, TX";
    await ingestResearchCsv({
      prisma: db, organizationId: "org", createdByUserId: null, category: "deeds",
      mapping: { ...mapping, abstractId: "Location", survey: "Location", county: "Location" },
      csv: csv("Type,Recorded,Grantor,Grantee,Location", `Mineral Deed,03/12/2026,Smith,Blackrock LLC,"${loc}"`),
    });
    expect(created[0]).toMatchObject({ abstractId: "923", abstractIds: ["923"], survey: "J. Warnick Survey", county: "Leon", state: "TX", legalDescription: loc });
  });
});

describe("gisSurveyLookup", () => {
  it("answers only for a county + number with exactly one survey", async () => {
    const { db } = fakeDb();
    const lookup = await gisSurveyLookup(db, ["Leon"]);
    expect(lookup("Leon", "923")).toBe("J. Warnick Survey");
    expect(lookup("leon", "A-923")).toBe("J. Warnick Survey");
    expect(lookup("Leon", "15")).toBeNull();
    expect(lookup("Freestone", "923")).toBeNull();
  });
  it("no GIS schema → no lookups", async () => {
    const db = { $queryRawUnsafe: async () => { throw new Error("relation gis.abstracts does not exist"); } } as unknown as PrismaClient;
    expect((await gisSurveyLookup(db, ["Leon"]))("Leon", "923")).toBeNull();
  });
});
