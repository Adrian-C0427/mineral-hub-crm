import { describe, it, expect } from "vitest";
import { askFromAcceptedOffer, legacyCostBasisToKeep, sameAsk } from "./acceptedOfferPricing.js";

describe("askFromAcceptedOffer — the accepted offer becomes the asking price, per-acre through the one formula", () => {
  it("the spec's example: $7,000/NMA on 10 NMA / 8 NRA → $70,000, $7,000/NMA, $8,750/NRA", () => {
    expect(askFromAcceptedOffer(70_000, { acreageNma: 10, nra: 8, royaltyRate: "1/10" })).toEqual({ askPrice: 70_000, askPricePerNma: 7_000, askPricePerNra: 8_750 });
    // Same figures with no royalty recorded (rates fall back to plain division).
    expect(askFromAcceptedOffer(70_000, { acreageNma: 10, nra: 8, royaltyRate: null })).toEqual({ askPrice: 70_000, askPricePerNma: 7_000, askPricePerNra: 8_750 });
  });
  it("keeps the total and leaves per-acre blank when acreage is missing", () => {
    expect(askFromAcceptedOffer(70_000, { acreageNma: null, nra: null, royaltyRate: null })).toEqual({ askPrice: 70_000, askPricePerNma: null, askPricePerNra: null });
    expect(askFromAcceptedOffer(70_000, { acreageNma: 10, nra: null, royaltyRate: "1/8" })).toMatchObject({ askPricePerNma: 7_000, askPricePerNra: null }); // no NRA recorded → no $/NRA
  });
  it("rounds to the cent and never drifts", () => {
    expect(askFromAcceptedOffer(100_000.004, { acreageNma: 3, nra: 3, royaltyRate: "1/8" })).toEqual({ askPrice: 100_000, askPricePerNma: 33_333.33, askPricePerNra: 33_333.33 });
  });
  it("sameAsk tells a no-op from a change", () => {
    const a = { askPrice: 70_000, askPricePerNma: 7_000, askPricePerNra: 8_750 };
    expect(sameAsk(a, { ...a })).toBe(true);
    expect(sameAsk(a, { ...a, askPrice: 70_001 })).toBe(false);
  });
  it("a legacy deal with no cost basis keeps its old asking price as Our Price", () => {
    expect(legacyCostBasisToKeep({ ourPrice: null, purchasePrice: null, askPrice: 50_000 })).toBe(50_000);
    expect(legacyCostBasisToKeep({ ourPrice: 40_000, purchasePrice: null, askPrice: 50_000 })).toBeNull();
    expect(legacyCostBasisToKeep({ ourPrice: null, purchasePrice: 30_000, askPrice: 50_000 })).toBeNull();
    expect(legacyCostBasisToKeep({ ourPrice: null, purchasePrice: null, askPrice: null })).toBeNull();
  });
});
