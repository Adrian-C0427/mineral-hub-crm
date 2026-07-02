import { describe, expect, it } from "vitest";
import {
  buildResearchBuyer, classifyMatch, mergePlan, nameSimilarity, summaryFor,
  type ResearchDocLite, type ExistingBuyerLite, type ExistingBuyerForMerge,
} from "./researchBuyers.js";

const doc = (o: Partial<ResearchDocLite>): ResearchDocLite => ({
  grantee: "Blackrock Minerals LLC", granteeNorm: "BLACKROCK MINERALS",
  state: "TX", county: "Leon", abstractId: "A-289", docType: "MINERAL_DEED",
  recordingDate: new Date("2026-03-01"), ...o,
});

describe("buildResearchBuyer", () => {
  it("aggregates a grantee's rows into a buyer proposal", () => {
    const rows = [
      doc({}),
      doc({ grantee: "Blackrock Minerals, L.L.C.", county: "Freestone", abstractId: "A-112", docType: "OG_LEASE", recordingDate: new Date("2026-04-10") }),
      doc({ county: "Leon", abstractId: "A-289", recordingDate: new Date("2026-02-01") }),
    ];
    const b = buildResearchBuyer(rows)!;
    expect(b.normalizedCompany).toBe("BLACKROCK MINERALS");
    expect(b.companyName).toBe("Blackrock Minerals LLC"); // most common raw form
    expect(b.aliases).toContain("Blackrock Minerals, L.L.C.");
    expect(b.counties).toEqual(["Freestone", "Leon"]);
    expect(b.states).toEqual(["TX"]);
    expect(b.transactionCount).toBe(3);
    expect(b.firstSeen).toBe("2026-02-01");
    expect(b.lastSeen).toBe("2026-04-10");
    expect(b.transactionTypes).toEqual(expect.arrayContaining(["Mineral Deed", "Og Lease"]));
    expect(b.concentration[0]).toMatchObject({ county: "Leon", state: "TX", count: 2 });
  });
  it("returns null for empty input", () => {
    expect(buildResearchBuyer([])).toBeNull();
  });
});

describe("nameSimilarity", () => {
  it("scores identical/near/unrelated names", () => {
    expect(nameSimilarity("Blackrock Minerals LLC", "BLACKROCK MINERALS L.L.C.")).toBe(1); // suffix-normalized equal
    expect(nameSimilarity("Blackrock Minerals", "Blackrock Minerals Partners")).toBeGreaterThan(0.6); // subsidiary
    expect(nameSimilarity("Apex Energy", "Apex Enrgy")).toBeGreaterThan(0.6); // misspelling
    expect(nameSimilarity("Blackrock Minerals", "Cedar Creek Royalty")).toBeLessThan(0.4);
  });
});

describe("classifyMatch", () => {
  const existing: ExistingBuyerLite[] = [
    { id: "b1", companyName: "Blackrock Minerals LLC", normalizedCompany: "BLACKROCK MINERALS", aliases: [] },
    { id: "b2", companyName: "Apex Energy Partners LP", normalizedCompany: "APEX ENERGY PARTNERS", aliases: ["Apex Energy"] },
  ];
  const proposal = (name: string) => buildResearchBuyer([doc({ grantee: name, granteeNorm: null })])!;

  it("exact match on normalized name", () => {
    expect(classifyMatch(proposal("BLACKROCK MINERALS, LLC"), existing)).toEqual({ outcome: "exact", buyerId: "b1" });
  });
  it("exact match via an existing alias", () => {
    expect(classifyMatch(proposal("Apex Energy"), existing)).toMatchObject({ outcome: "exact", buyerId: "b2" });
  });
  it("possible match on similar name", () => {
    const r = classifyMatch(proposal("Blackrock Mineral Holdings"), existing);
    expect(r.outcome).toBe("possible");
    if (r.outcome === "possible") { expect(r.buyerId).toBe("b1"); expect(r.confidence).toBeGreaterThanOrEqual(0.6); }
  });
  it("new when nothing is close", () => {
    expect(classifyMatch(proposal("Guadalupe Royalty Trust"), existing)).toEqual({ outcome: "new" });
  });
});

describe("mergePlan (additive, non-destructive)", () => {
  const imported = buildResearchBuyer([
    doc({ county: "Leon", state: "TX" }),
    doc({ county: "Robertson", state: "TX", grantee: "Blackrock Minerals LLC" }),
    doc({ county: "Eddy", state: "NM", grantee: "Blackrock Minerals LLC" }),
  ])!;

  it("only appends missing counties/states/aliases", () => {
    const existing: ExistingBuyerForMerge = {
      aliases: [], source: null, researchSummary: null,
      buyBoxCounties: ["Leon"], buyBoxStates: ["TX"],
    };
    const plan = mergePlan(existing, imported);
    expect(plan.addCounties).toEqual(expect.arrayContaining(["Robertson", "Eddy"]));
    expect(plan.addCounties).not.toContain("Leon"); // already present
    expect(plan.addStates).toEqual(["NM"]); // TX already present
    expect(plan.markResearch).toBe(true); // source was unset
    expect(plan.changed).toBe(true);
  });
  it("no changes when everything already present and source set", () => {
    const existing: ExistingBuyerForMerge = {
      aliases: ["Blackrock Minerals LLC"], source: "user",
      researchSummary: summaryFor(imported),
      buyBoxCounties: ["Leon", "Robertson", "Eddy"], buyBoxStates: ["TX", "NM"],
    };
    const plan = mergePlan(existing, imported);
    expect(plan.changed).toBe(false);
    expect(plan.markResearch).toBe(false); // don't relabel a user-created buyer
  });
  it("accumulates transaction counts across merges in the summary", () => {
    const existing: ExistingBuyerForMerge = {
      aliases: [], source: "research", buyBoxCounties: [], buyBoxStates: [],
      researchSummary: { counties: ["Leon"], states: ["TX"], abstracts: [], transactionTypes: [], transactionCount: 5, firstSeen: "2025-01-01", lastSeen: "2025-06-01" },
    };
    const plan = mergePlan(existing, imported);
    expect(plan.summary.transactionCount).toBe(5 + imported.transactionCount);
    expect(plan.summary.firstSeen).toBe("2025-01-01"); // earliest preserved
  });
});
