/**
 * Regression tests for the 2026-10-21 audit (Low): the buyer alias search
 * rebuilt the research entity index, a scan of every transaction record, on
 * each keystroke. The index is now cached per org scope for a short window,
 * concurrent callers share one build, and a failed build is never cached.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ prisma: { researchDocument: { findMany } } }));

import { researchEntityIndex, clearResearchEntityIndexCache } from "./buyers.js";

const row = (id: string, grantor: string, grantee: string) => ({
  id, grantor, grantorNorm: grantor.toUpperCase(), grantee, granteeNorm: grantee.toUpperCase(),
  grantorParties: [], granteeParties: [], grantorNorms: [], granteeNorms: [],
});

describe("research entity index cache", () => {
  beforeEach(() => {
    clearResearchEntityIndexCache();
    findMany.mockReset();
    findMany.mockResolvedValue([row("1", "Smith", "Acme Minerals")]);
  });

  it("reuses one scan for repeated and concurrent calls within the window", async () => {
    const t = 1_000_000;
    const [a, b] = await Promise.all([researchEntityIndex(["org1"], t), researchEntityIndex(["org1"], t)]);
    const c = await researchEntityIndex(["org1"], t + 30_000);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(a.size).toBeGreaterThan(0);
  });

  it("keys on the org scope regardless of order and rebuilds after the window", async () => {
    const t = 2_000_000;
    await researchEntityIndex(["org1", "org2"], t);
    await researchEntityIndex(["org2", "org1"], t + 1);
    expect(findMany).toHaveBeenCalledTimes(1);
    await researchEntityIndex(["org3"], t + 2);
    expect(findMany).toHaveBeenCalledTimes(2);
    await researchEntityIndex(["org1", "org2"], t + 61_000);
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("does not cache a failed build", async () => {
    findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(researchEntityIndex(["org1"], 3_000_000)).rejects.toThrow("db down");
    await expect(researchEntityIndex(["org1"], 3_000_001)).resolves.toBeInstanceOf(Map);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
