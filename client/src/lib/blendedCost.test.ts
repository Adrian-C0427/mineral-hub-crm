import { describe, it, expect } from "vitest";
import { blendedCost, dealNma, dealNra, type BlendedDeal } from "./blendedCost";

const deal = (p: Partial<BlendedDeal>): BlendedDeal => ({
  recordType: "OPPORTUNITY", ourPrice: null, purchasePrice: null, acreageNma: null, nra: null, royaltyRate: null, ...p,
});

describe("blendedCost", () => {
  it("is the weighted average (Σ cost ÷ Σ acres), not the mean of per-acre prices", () => {
    // The spec's example: $150,000 over 20 NMA / 15 NRA → $7,500/NMA, $10,000/NRA.
    const rows = [
      deal({ ourPrice: 100_000, acreageNma: 10, nra: 10 }),
      deal({ ourPrice: 50_000, acreageNma: 10, nra: 5 }),
    ];
    const b = blendedCost(rows);
    expect(b.perNma).toBe(7_500);
    expect(b.perNra).toBe(10_000);
    // Mean of the two per-NMA prices would be $7,500 too, so check a skewed set:
    const skewed = blendedCost([deal({ ourPrice: 1_000_000, acreageNma: 100 }), deal({ ourPrice: 10_000, acreageNma: 1 })]);
    expect(skewed.perNma).toBe(10_000); // (1,010,000 ÷ 101), not (10,000 + 10,000) ÷ 2
  });

  it("derives the missing acreage from the other at the deal's royalty, custom rates included", () => {
    // 10 NMA at 1/4 → 20 NRA (NRA normalized to a 1/8 royalty).
    expect(dealNra(deal({ acreageNma: 10, royaltyRate: "1/4" }))).toBe(20);
    // Custom 20% royalty: 10 NMA → 16 NRA; and back.
    expect(dealNra(deal({ acreageNma: 10, royaltyRate: "20%" }))).toBe(16);
    expect(dealNma(deal({ nra: 16, royaltyRate: "20%" }))).toBe(10);
    const b = blendedCost([deal({ ourPrice: 80_000, acreageNma: 10, royaltyRate: "1/4" })]);
    expect(b.perNma).toBe(8_000);
    expect(b.perNra).toBe(4_000);
    expect(b.convertedNra).toBe(1); // reported, so the sub-line can say the NRA was converted
    expect(b.convertedNma).toBe(0);
  });

  it("counts every listed deal on its own figures (formerly grouped deals are ordinary rows)", () => {
    const b = blendedCost([deal({ ourPrice: 40_000, acreageNma: 4, nra: 8 }), deal({ ourPrice: 20_000, acreageNma: 2, nra: 4 })]);
    expect(b.perNma).toBe(10_000);
    expect(b.perNra).toBe(5_000);
    expect(b.priced).toBe(2);
  });

  it("leaves out priced deals with no acreage instead of inflating the rate, and reports them", () => {
    const b = blendedCost([
      deal({ ourPrice: 100_000, acreageNma: 10 }),
      deal({ ourPrice: 50_000 }), // priced, no acreage at all
      deal({ acreageNma: 40 }), // acreage, no price: contributes nothing
    ]);
    expect(b.perNma).toBe(10_000);
    expect(b.skippedNma).toBe(1);
    expect(b.priced).toBe(2);
    expect(b.cost).toBe(150_000);
    expect(b.perNra).toBeNull(); // no royalty rate → NRA unknown for both
    expect(b.skippedNra).toBe(2);
  });

  it("returns N/A (null) when the applicable acreage is zero or unavailable", () => {
    expect(blendedCost([]).perNma).toBeNull();
    expect(blendedCost([deal({ ourPrice: 5_000, acreageNma: 0 })]).perNma).toBeNull();
    expect(blendedCost([deal({ ourPrice: 5_000, acreageNma: -3 })]).perNma).toBeNull();
  });

  it("takes an owned asset's purchase price as its cost when it has no Our Price", () => {
    const b = blendedCost([deal({ recordType: "OWNED_ASSET", purchasePrice: 30_000, acreageNma: 3 })]);
    expect(b.perNma).toBe(10_000);
  });
});
