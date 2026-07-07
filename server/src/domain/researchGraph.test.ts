import { describe, expect, it } from "vitest";
import {
  aggregateRelationships, coBuyerPartnerships, classifyEntity, classifyEntities,
  buildChains, chainTableRows, buildGraph, entityNetwork, type TxEdge,
} from "./researchGraph.js";

let seq = 0;
const edge = (o: Partial<TxEdge>): TxEdge => ({
  id: `d${seq++}`,
  grantorNorm: "ABC MINERALS", grantor: "ABC Minerals LLC",
  granteeNorm: "XYZ ENERGY", grantee: "XYZ Energy",
  state: "TX", county: "Leon", abstractId: "A-1",
  date: new Date("2026-01-01"), txKey: null, ...o,
});

describe("aggregateRelationships", () => {
  it("collapses repeated transfers into one weighted relationship", () => {
    const edges = [
      edge({ county: "Leon", date: new Date("2026-01-01") }),
      edge({ county: "Freestone", abstractId: "A-2", date: new Date("2026-03-01") }),
      edge({ county: "Leon", date: new Date("2026-02-01") }),
    ];
    const rels = aggregateRelationships(edges);
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      grantorNorm: "ABC MINERALS", granteeNorm: "XYZ ENERGY", count: 3,
      firstDate: "2026-01-01", lastDate: "2026-03-01",
    });
    expect(rels[0].counties).toEqual(["Freestone", "Leon"]);
    expect(rels[0].abstracts).toEqual(["A-1", "A-2"]);
    expect(rels[0].txIds).toHaveLength(3);
  });

  it("keeps distinct pairs separate and sorts by count", () => {
    const edges = [
      edge({ granteeNorm: "XYZ ENERGY", grantee: "XYZ Energy" }),
      edge({ granteeNorm: "XYZ ENERGY", grantee: "XYZ Energy" }),
      edge({ grantorNorm: "XYZ ENERGY", grantor: "XYZ Energy", granteeNorm: "ACME ROYALTIES", grantee: "Acme Royalties" }),
    ];
    const rels = aggregateRelationships(edges);
    expect(rels).toHaveLength(2);
    expect(rels[0]).toMatchObject({ grantorNorm: "ABC MINERALS", granteeNorm: "XYZ ENERGY", count: 2 });
    expect(rels[1]).toMatchObject({ grantorNorm: "XYZ ENERGY", granteeNorm: "ACME ROYALTIES", count: 1 });
  });

  it("drops self-loops (normalization artefacts)", () => {
    const rels = aggregateRelationships([edge({ grantorNorm: "SAME CO", granteeNorm: "SAME CO" })]);
    expect(rels).toHaveLength(0);
  });

  it("picks the most common display name for a key", () => {
    const edges = [
      edge({ grantee: "XYZ Energy" }),
      edge({ grantee: "XYZ Energy" }),
      edge({ grantee: "XYZ Energy, LLC" }),
    ];
    expect(aggregateRelationships(edges)[0].grantee).toBe("XYZ Energy");
  });
});

describe("coBuyerPartnerships", () => {
  it("finds recurring co-buyers on shared instruments", () => {
    const edges = [
      // instrument I1: A and B buy together
      edge({ txKey: "TX|Leon|I1", granteeNorm: "ENTITY A", grantee: "Entity A" }),
      edge({ txKey: "TX|Leon|I1", granteeNorm: "ENTITY B", grantee: "Entity B" }),
      // instrument I2: A and B again
      edge({ txKey: "TX|Leon|I2", granteeNorm: "ENTITY A", grantee: "Entity A" }),
      edge({ txKey: "TX|Leon|I2", granteeNorm: "ENTITY B", grantee: "Entity B" }),
      // instrument I3: A, C, D
      edge({ txKey: "TX|Leon|I3", granteeNorm: "ENTITY A", grantee: "Entity A" }),
      edge({ txKey: "TX|Leon|I3", granteeNorm: "ENTITY C", grantee: "Entity C" }),
      edge({ txKey: "TX|Leon|I3", granteeNorm: "ENTITY D", grantee: "Entity D" }),
    ];
    const parts = coBuyerPartnerships(edges);
    expect(parts[0].members.map((m) => m.norm)).toEqual(["ENTITY A", "ENTITY B"]);
    expect(parts[0].count).toBe(2);
    const triple = parts.find((p) => p.members.length === 3)!;
    expect(triple.members.map((m) => m.norm)).toEqual(["ENTITY A", "ENTITY C", "ENTITY D"]);
    expect(triple.count).toBe(1);
  });

  it("ignores solo buyers and edges without a txKey", () => {
    const edges = [
      edge({ txKey: "TX|Leon|SOLO", granteeNorm: "ENTITY A" }),
      edge({ txKey: null, granteeNorm: "ENTITY B" }),
    ];
    expect(coBuyerPartnerships(edges)).toHaveLength(0);
  });
});

describe("classifyEntity", () => {
  it("labels a pure acquirer as a terminal hold platform", () => {
    expect(classifyEntity({ acquisitions: 5, dispositions: 0, distinctGrantors: 4, distinctGrantees: 0 })).toBe("TERMINAL_HOLD");
  });
  it("labels a pure grantor as a seller", () => {
    expect(classifyEntity({ acquisitions: 0, dispositions: 3, distinctGrantors: 0, distinctGrantees: 2 })).toBe("SELLER");
  });
  it("labels broad fan-in / narrow fan-out as an aggregator", () => {
    expect(classifyEntity({ acquisitions: 8, dispositions: 3, distinctGrantors: 6, distinctGrantees: 1 })).toBe("AGGREGATOR");
  });
  it("labels a single-downstream reseller as a feeder", () => {
    expect(classifyEntity({ acquisitions: 3, dispositions: 4, distinctGrantors: 2, distinctGrantees: 1 })).toBe("FEEDER");
  });
  it("labels a recurring two-sided mover as a distributor", () => {
    expect(classifyEntity({ acquisitions: 5, dispositions: 5, distinctGrantors: 4, distinctGrantees: 4 })).toBe("DISTRIBUTOR");
  });
  it("labels a single acquisition with no resale as a one-time buyer", () => {
    expect(classifyEntity({ acquisitions: 1, dispositions: 0, distinctGrantors: 1, distinctGrantees: 0 })).toBe("ONE_TIME_BUYER");
  });
});

describe("classifyEntities", () => {
  it("computes flow stats across the whole graph", () => {
    const rels = aggregateRelationships([
      edge({ grantorNorm: "A", granteeNorm: "B" }),
      edge({ grantorNorm: "A", granteeNorm: "B" }),
      edge({ grantorNorm: "B", granteeNorm: "C" }),
    ]);
    const stats = classifyEntities(rels);
    expect(stats.get("B")).toMatchObject({ acquisitions: 2, dispositions: 1, distinctGrantors: 1, distinctGrantees: 1 });
    expect(stats.get("A")!.dispositions).toBe(2);
    expect(stats.get("C")!.acquisitions).toBe(1);
  });
});

describe("buildChains", () => {
  const chainEdges = () => [
    ...Array.from({ length: 3 }, () => edge({ grantorNorm: "A", grantor: "A Co", granteeNorm: "B", grantee: "B Co" })),
    ...Array.from({ length: 2 }, () => edge({ grantorNorm: "B", grantor: "B Co", granteeNorm: "C", grantee: "C Co" })),
    ...Array.from({ length: 2 }, () => edge({ grantorNorm: "C", grantor: "C Co", granteeNorm: "D", grantee: "D Co" })),
  ];

  it("traces a multi-hop acquisition path and reports strength", () => {
    const chains = buildChains(aggregateRelationships(chainEdges()));
    expect(chains).toHaveLength(1);
    expect(chains[0].nodes.map((n) => n.norm)).toEqual(["A", "B", "C", "D"]);
    expect(chains[0].length).toBe(3);
    expect(chains[0].strength).toBe(2);      // bottleneck hop
    expect(chains[0].totalCount).toBe(7);    // 3 + 2 + 2
  });

  it("drops strict-prefix sub-chains, keeping the maximal path", () => {
    const chains = buildChains(aggregateRelationships(chainEdges()));
    // Only A→B→C→D, not A→B→C.
    expect(chains.every((c) => c.nodes.length === 4)).toBe(true);
  });

  it("does not loop on cycles", () => {
    const edges = [
      edge({ grantorNorm: "A", granteeNorm: "B" }),
      edge({ grantorNorm: "B", granteeNorm: "A" }),
    ];
    const chains = buildChains(aggregateRelationships(edges));
    expect(chains.every((c) => new Set(c.nodes.map((n) => n.norm)).size === c.nodes.length)).toBe(true);
  });

  it("respects the depth cap", () => {
    const chains = buildChains(aggregateRelationships(chainEdges()), { maxDepth: 2 });
    expect(chains[0].length).toBe(2);
    expect(chains[0].nodes.map((n) => n.norm)).toEqual(["A", "B", "C"]);
  });
});

describe("chainTableRows", () => {
  it("splits a chain into feeder / mid-tier / terminus", () => {
    const edges = [
      ...Array.from({ length: 2 }, () => edge({ grantorNorm: "F", grantor: "Feeder Co", granteeNorm: "M", grantee: "Mid Co" })),
      ...Array.from({ length: 2 }, () => edge({ grantorNorm: "M", grantor: "Mid Co", granteeNorm: "T", grantee: "Terminus Co" })),
    ];
    const [row] = chainTableRows(buildChains(aggregateRelationships(edges)));
    expect(row.terminus).toBe("Terminus Co");
    expect(row.feeders).toContain("Feeder Co");
    expect(row.path).toBe("Feeder Co → Mid Co → Terminus Co");
  });
});

describe("buildGraph", () => {
  it("caps nodes by activity and keeps internal edges", () => {
    const rels = aggregateRelationships([
      edge({ grantorNorm: "A", granteeNorm: "B" }),
      edge({ grantorNorm: "B", granteeNorm: "C" }),
    ]);
    const g = buildGraph(rels, 2);
    expect(g.nodes).toHaveLength(2);
    // Only edges between the two kept (most-active) nodes survive.
    expect(g.edges.every((e) => g.nodes.some((n) => n.norm === e.fromNorm) && g.nodes.some((n) => n.norm === e.toNorm))).toBe(true);
  });
});

describe("entityNetwork", () => {
  it("focuses the analysis on one entity", () => {
    const edges = [
      // ABC → XYZ (focus buys 2)
      edge({ grantorNorm: "ABC", grantor: "ABC", granteeNorm: "XYZ", grantee: "XYZ Energy" }),
      edge({ grantorNorm: "ABC", grantor: "ABC", granteeNorm: "XYZ", grantee: "XYZ Energy" }),
      // XYZ → ACME (focus sells 1)
      edge({ grantorNorm: "XYZ", grantor: "XYZ Energy", granteeNorm: "ACME", grantee: "Acme" }),
      // co-buy: XYZ + PARTNER on instrument I9
      edge({ txKey: "TX|Leon|I9", grantorNorm: "SRC", granteeNorm: "XYZ", grantee: "XYZ Energy" }),
      edge({ txKey: "TX|Leon|I9", grantorNorm: "SRC", granteeNorm: "PARTNER", grantee: "Partner Co" }),
    ];
    const net = entityNetwork(edges, ["XYZ"], "XYZ Energy")!;
    expect(net.name).toBe("XYZ Energy");
    expect(net.topGrantors.map((g) => g.norm)).toContain("ABC");
    expect(net.topGrantees.map((g) => g.norm)).toEqual(["ACME"]);
    expect(net.coBuyers.map((c) => c.norm)).toEqual(["PARTNER"]);
    expect(net.acquisitions).toBeGreaterThanOrEqual(2);
    expect(net.dispositions).toBe(1);
    expect(net.graph.nodes.some((n) => n.norm === "XYZ")).toBe(true);
  });

  it("returns null when no focus keys are given", () => {
    expect(entityNetwork([], [])).toBeNull();
  });
});
