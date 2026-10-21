import { describe, it, expect } from "vitest";
import { normState, titleCounty } from "./researchIngest.js";
import { aggregateRelationships, buildFocusChains, expandDocToEdges, sideParties, type TxEdge } from "./researchGraph.js";
import { normalizeEntity } from "./research.js";
import { resolveGroupAlias } from "../services/researchConsistencyBackfill.js";

describe("geography normalization (County, ST)", () => {
  it("maps state names and codes to one USPS code", () => {
    for (const v of ["TX", "tx", "Texas", "TEXAS", "Tex.", "State of Texas"]) expect(normState(v)).toBe("TX");
    expect(normState("Louisiana")).toBe("LA");
    expect(normState("New Mexico")).toBe("NM");
    expect(normState("Oklahoma")).toBe("OK");
  });
  it("stores one county spelling whatever the clerk wrote", () => {
    for (const v of ["Leon", "LEON", "leon", "Leon County", "LEON COUNTY", "Leon Co.", "Leon County, TX", "Leon, Texas", "leon county, tx"]) {
      expect(titleCounty(v)).toBe("Leon");
    }
    expect(titleCounty("ST. LANDRY PARISH")).toBe("St. Landry");
    expect(titleCounty("san augustine")).toBe("San Augustine");
  });
  it("keeps proper casing the county lists use", () => {
    expect(titleCounty("MCMULLEN")).toBe("McMullen");
    expect(titleCounty("McMullen")).toBe("McMullen");
    expect(titleCounty("DEWITT")).toBe("DeWitt");
    expect(titleCounty("DeWitt")).toBe("DeWitt");
    expect(titleCounty("De Witt")).toBe("De Witt");
    expect(titleCounty("LA SALLE")).toBe("La Salle");
    expect(titleCounty("LASALLE")).toBe("LaSalle");
    expect(titleCounty("Lamar")).toBe("Lamar");
    expect(titleCounty("LANDRY")).toBe("Landry");
  });
  it("never confuses a county named like a state with the state suffix", () => {
    expect(titleCounty("Texas")).toBe("Texas"); // Texas County, OK/MO
    expect(titleCounty("Washington County")).toBe("Washington");
  });
});

describe("multi-party records: each participant is its own entity", () => {
  it("splits a combined cell into individual parties, never a group", () => {
    const parties = sideParties("ABC Minerals LLC; XYZ Resources LLC", "ABC MINERALS XYZ RESOURCES", [], []);
    expect(parties.map((p) => p.norm)).toEqual(["ABC MINERALS", "XYZ RESOURCES"]);
    expect(parties.map((p) => p.name)).toEqual(["ABC Minerals LLC", "XYZ Resources LLC"]);
  });
  it("keeps a person written surname-first as ONE party", () => {
    for (const v of ["Garcia, Maria", "Smith, John et ux", "Thompson, Robert et al", "O'Brien, Mary Ann", "SMITH, JOHN R JR"]) {
      expect(sideParties(v, null, [], []).length, v).toBe(1);
    }
    expect(sideParties("Garcia, Maria", null, [], [])[0].norm).toBe("GARCIA MARIA");
    // ...but two organisations, a suffix, or two multi-word names still split / stay as before
    expect(sideParties("Company A, Company B", null, [], []).length).toBe(2);
    expect(sideParties("Jones Family Trust, Smith John", null, [], []).length).toBe(2);
    expect(sideParties("Blackrock Minerals, LLC", "BLACKROCK MINERALS", [], [])[0].name).toBe("Blackrock Minerals, LLC");
  });
  it("keeps every party of a long heir list", () => {
    const names = Array.from({ length: 25 }, (_, i) => `Heir ${i + 1} Smith`);
    expect(sideParties(names.join("; "), null, [], []).length).toBe(25);
  });
  it("a group alias reduces to the one party that is the buyer, or is dropped", () => {
    expect(resolveGroupAlias("ABC Minerals LLC; XYZ Resources LLC", "ABC Minerals")).toEqual({ keep: "ABC Minerals LLC", wasGroup: true });
    expect(resolveGroupAlias("Foo Royalty LP, Bar Energy Inc", "ABC Minerals")).toEqual({ keep: null, wasGroup: true });
    expect(resolveGroupAlias("ABC Minerals, LLC", "ABC Minerals")).toEqual({ keep: "ABC Minerals, LLC", wasGroup: false });
  });
});

const doc = (id: string, grantor: string, grantee: string, date = "2024-03-01"): TxEdge[] =>
  expandDocToEdges({
    id, grantor, grantorNorm: normalizeEntity(grantor), grantee, granteeNorm: normalizeEntity(grantee),
    grantorParties: [], granteeParties: [], grantorNorms: [], granteeNorms: [],
    state: "TX", county: "Leon", abstractId: null, recordingDate: new Date(date), instrumentNumber: id,
  });

describe("acquisition chains walk outward from the buyer", () => {
  it("finds the buyer's chain when it was one of several grantees", () => {
    const edges = [
      ...doc("1", "Source Ranch", "Mid Holdings"),
      ...doc("2", "Mid Holdings", "ABC Minerals LLC; XYZ Resources LLC"),
      ...doc("3", "ABC Minerals LLC", "Downstream Fund"),
    ];
    const chains = buildFocusChains(aggregateRelationships(edges), new Set(["ABC MINERALS"]));
    const sigs = chains.map((c) => c.chain.nodes.map((n) => n.norm).join(">"));
    expect(sigs).toContain("SOURCE RANCH>MID HOLDINGS>ABC MINERALS>DOWNSTREAM FUND");
    expect(chains.every((c) => c.chain.nodes.some((n) => n.norm === "ABC MINERALS"))).toBe(true);
    const full = chains.find((c) => c.chain.nodes.length === 4)!;
    expect(full.position).toBe(2);
    expect(sigs).not.toContain("SOURCE RANCH>MID HOLDINGS>XYZ RESOURCES"); // the co-buyer's chain is not this buyer's
  });
  it("is not crowded out by stronger chains between neighbours", () => {
    const edges: TxEdge[] = [...doc("w1", "Quiet Seller", "Focus Minerals"), ...doc("w2", "Focus Minerals", "Flip Buyer")];
    for (let i = 0; i < 500; i++) {
      for (let k = 0; k < 20; k++) edges.push(...doc(`s${i}-${k}`, `Big Seller ${i}`, "Neighbour Royalty"));
      edges.push(...doc(`n${i}`, "Neighbour Royalty", `Big Buyer ${i}`));
    }
    edges.push(...doc("link", "Flip Buyer", "Neighbour Royalty"));
    const chains = buildFocusChains(aggregateRelationships(edges), new Set(["FOCUS MINERALS"]), { maxChains: 50 });
    expect(chains.length).toBeGreaterThan(0);
    expect(chains.every((c) => c.chain.nodes.some((n) => n.norm === "FOCUS MINERALS"))).toBe(true);
    expect(chains.some((c) => c.chain.nodes[0].norm === "QUIET SELLER")).toBe(true);
  });
  it("reaches a buyer that sits below a cycle, where no source-root exists", () => {
    const edges = [...doc("a", "Alpha", "Beta"), ...doc("b", "Beta", "Alpha"), ...doc("c", "Beta", "Focus Minerals")];
    const chains = buildFocusChains(aggregateRelationships(edges), new Set(["FOCUS MINERALS"]));
    expect(chains.map((c) => c.chain.nodes.map((n) => n.norm).join(">"))).toContain("ALPHA>BETA>FOCUS MINERALS");
  });
});
