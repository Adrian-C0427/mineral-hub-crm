import { describe, it, expect } from "vitest";
import { entityNetwork, type TxEdge } from "./researchGraph.js";

// Regression: acquisition chains vanished from merged buyer profiles.
// Root cause — chains were built on the GLOBAL org graph with a strength-
// sorted cap, so in a busy org the buyer's (weaker) chains were crowded out
// before the focus filter ran. entityNetwork now builds chains from the
// focus-centred subgraph, where the cap only competes within the buyer's own
// neighbourhood.

let seq = 0;
function edge(grantor: string, grantee: string, n = 1): TxEdge[] {
  return Array.from({ length: n }, () => ({
    id: `e${++seq}`,
    grantorNorm: grantor.toUpperCase(), grantor,
    granteeNorm: grantee.toUpperCase(), grantee,
    state: "TX", county: "Leon", abstractId: null, date: new Date("2025-01-15T00:00:00Z"), txKey: null,
  }));
}

describe("entityNetwork chain preservation", () => {
  it("keeps a weak focus chain even when the org graph has many stronger unrelated chains", () => {
    const edges: TxEdge[] = [];
    // 80 strong unrelated 2-hop chains (Ai -> Bi -> Ci, 50 tx per hop) —
    // more than the old global maxChains cap of 60.
    for (let i = 0; i < 80; i++) {
      edges.push(...edge(`Alpha${i} Minerals LLC`, `Bravo${i} Holdings LLC`, 50));
      edges.push(...edge(`Bravo${i} Holdings LLC`, `Charlie${i} Energy LLC`, 50));
    }
    // The focus buyer's single weak chain: Seller -> FOCUS -> Downstream (1 tx each).
    edges.push(...edge("Quiet Seller LP", "Focus Minerals LLC", 1));
    edges.push(...edge("Focus Minerals LLC", "Downstream Royalty LLC", 1));

    const net = entityNetwork(edges, ["FOCUS MINERALS LLC"], "Focus Minerals LLC")!;
    expect(net).not.toBeNull();
    expect(net.chains.length).toBeGreaterThan(0);
    const flat = net.chains.map((c) => c.chain.nodes.map((n) => n.norm).join(">"));
    expect(flat.some((s) => s.includes("FOCUS MINERALS LLC"))).toBe(true);
    // And the unrelated strong chains stay out of this buyer's list entirely.
    expect(flat.every((s) => s.includes("FOCUS MINERALS LLC"))).toBe(true);
  });

  it("keeps chains reachable only via a merged alias key", () => {
    const edges: TxEdge[] = [
      ...edge("Old Name Partners LP", "Historic Alias LLC", 2),
      ...edge("Historic Alias LLC", "Endpoint Energy LLC", 2),
      // The canonical name has separate, unrelated activity.
      ...edge("Some Seller LLC", "Canonical Buyer LLC", 3),
    ];
    const net = entityNetwork(edges, ["CANONICAL BUYER LLC", "HISTORIC ALIAS LLC"], "Canonical Buyer LLC")!;
    const flat = net.chains.map((c) => c.chain.nodes.map((n) => n.norm).join(">"));
    expect(flat.some((s) => s.includes("HISTORIC ALIAS LLC"))).toBe(true);
  });
});
