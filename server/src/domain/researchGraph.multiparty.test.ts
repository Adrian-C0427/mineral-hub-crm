import { describe, expect, it } from "vitest";
import { splitParties } from "./research.js";
import {
  aggregateRelationships, classifyEntities, coBuyerPartnerships, buildChains,
  entityNetwork, expandDocToEdges, type TransferDocRow,
} from "./researchGraph.js";

// ---------------------------------------------------------------------------
// Multi-party grantors/grantees (co-buyer detection) — the group stays ONE
// transaction while every participant keeps its own relationship history.
// ---------------------------------------------------------------------------

describe("splitParties", () => {
  it("splits strictly on commas, semicolons, and forward slashes", () => {
    expect(splitParties("Company A, Company B")).toEqual(["Company A", "Company B"]);
    expect(splitParties("Company A; Company B / Company C")).toEqual(["Company A", "Company B", "Company C"]);
  });
  it("never splits on other joiners — & and AND are part of the name", () => {
    expect(splitParties("SMITH & SONS LLC")).toEqual(["SMITH & SONS LLC"]);
    expect(splitParties("BIG STAR AND LONE PINE MINERALS")).toEqual(["BIG STAR AND LONE PINE MINERALS"]);
  });
  it("drops empty parts and de-duplicates by normalized entity", () => {
    expect(splitParties("Company A,, ;/ Company A LLC")).toEqual(["Company A"]);
    expect(splitParties("")).toEqual([]);
    expect(splitParties(null)).toEqual([]);
  });
});

let seq = 0;
const doc = (o: Partial<TransferDocRow>): TransferDocRow => ({
  id: `doc${seq++}`,
  grantor: "Seller Co", grantorNorm: "SELLER",
  grantee: "Buyer Co", granteeNorm: "BUYER",
  grantorParties: [], granteeParties: [], grantorNorms: [], granteeNorms: [],
  state: "TX", county: "Leon", abstractId: null,
  recordingDate: new Date("2026-01-15"), instrumentNumber: null,
  ...o,
});

const groupDoc = (o: Partial<TransferDocRow>) => doc({
  grantor: "Company A; Company B", grantorNorm: "COMPANY A COMPANY B",
  grantorParties: ["Company A", "Company B"], grantorNorms: ["COMPANY A", "COMPANY B"],
  grantee: "Company C", granteeNorm: "COMPANY C",
  granteeParties: ["Company C"], granteeNorms: ["COMPANY C"],
  ...o,
});

describe("expandDocToEdges", () => {
  it("expands (A + B) → C into two participant edges sharing ONE document id", () => {
    const edges = expandDocToEdges(groupDoc({ id: "d1" }));
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((e) => e.id))).toEqual(new Set(["d1"]));
    expect(edges.map((e) => `${e.grantorNorm}→${e.granteeNorm}`).sort())
      .toEqual(["COMPANY A→COMPANY C", "COMPANY B→COMPANY C"]);
  });
  it("splits legacy rows (no stored arrays) from the raw string at read time", () => {
    const edges = expandDocToEdges(doc({
      id: "legacy", grantor: "Company A / Company B", grantorNorm: "COMPANY A COMPANY B",
    }));
    expect(edges.map((e) => e.grantorNorm).sort()).toEqual(["COMPANY A", "COMPANY B"]);
  });
  it("keeps single-party names with & intact", () => {
    const edges = expandDocToEdges(doc({ grantor: "Smith & Sons LLC", grantorNorm: "SMITH & SONS" }));
    expect(edges).toHaveLength(1);
    expect(edges[0].grantor).toBe("Smith & Sons LLC");
  });
});

describe("transaction counting with participant groups", () => {
  it("records participation for every party without inflating anyone's totals", () => {
    // ONE recorded instrument: (A + B) → C.
    const edges = expandDocToEdges(groupDoc({ id: "one" }));
    const rels = aggregateRelationships(edges);
    expect(rels).toHaveLength(2); // A→C and B→C relationship histories
    const stats = classifyEntities(rels);
    expect(stats.get("COMPANY C")!.acquisitions).toBe(1);   // one transaction, not two
    expect(stats.get("COMPANY A")!.dispositions).toBe(1);
    expect(stats.get("COMPANY B")!.dispositions).toBe(1);
    expect(new Set(edges.map((e) => e.id)).size).toBe(1);   // totals count documents
  });

  it("entityNetwork counts the focus entity's group transaction once", () => {
    const edges = expandDocToEdges(groupDoc({ id: "g1" }));
    const net = entityNetwork(edges, ["COMPANY C"])!;
    expect(net.acquisitions).toBe(1);
    expect(net.topGrantors.map((g) => g.norm).sort()).toEqual(["COMPANY A", "COMPANY B"]);
  });
});

describe("coBuyerPartnerships with multi-party groups", () => {
  it("detects co-grantor and co-grantee partnerships with role counts and dates", () => {
    const edges = [
      // (A + B) convey together twice…
      ...expandDocToEdges(groupDoc({ id: "s1", recordingDate: new Date("2025-03-01") })),
      ...expandDocToEdges(groupDoc({ id: "s2", grantee: "Company D", granteeNorm: "COMPANY D", granteeParties: ["Company D"], granteeNorms: ["COMPANY D"], recordingDate: new Date("2026-06-01") })),
      // …and (A + B) also acquire together once.
      ...expandDocToEdges(doc({
        id: "b1", grantor: "Origin LLC", grantorNorm: "ORIGIN",
        grantee: "Company A, Company B", granteeNorm: "COMPANY A COMPANY B",
        granteeParties: ["Company A", "Company B"], granteeNorms: ["COMPANY A", "COMPANY B"],
        recordingDate: new Date("2025-01-10"),
      })),
    ];
    const parts = coBuyerPartnerships(edges);
    const ab = parts.find((p) => p.members.map((m) => m.norm).join("+") === "COMPANY A+COMPANY B")!;
    expect(ab.sharedDispositions).toBe(2);
    expect(ab.sharedAcquisitions).toBe(1);
    expect(ab.count).toBe(3);                       // total partnership transactions
    expect(ab.firstDate).toBe("2025-01-10");        // first recorded together
    expect(ab.lastDate).toBe("2026-06-01");         // most recent together
  });
});

describe("acquisition chains through partnership participants", () => {
  it("keeps chains flowing through each member of a group", () => {
    // (A + B) → C, then C → D: both A→C→D and B→C→D paths exist.
    const edges = [
      ...expandDocToEdges(groupDoc({ id: "h1" })),
      ...expandDocToEdges(doc({
        id: "h2", grantor: "Company C", grantorNorm: "COMPANY C",
        grantee: "Company D", granteeNorm: "COMPANY D",
        recordingDate: new Date("2026-05-01"),
      })),
    ];
    const chains = buildChains(aggregateRelationships(edges));
    const paths = chains.map((c) => c.nodes.map((n) => n.norm).join(">"));
    expect(paths).toContain("COMPANY A>COMPANY C>COMPANY D");
    expect(paths).toContain("COMPANY B>COMPANY C>COMPANY D");
  });
});
