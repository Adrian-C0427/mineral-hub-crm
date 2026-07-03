import { describe, expect, it } from "vitest";
import { dealFacts, type DealContext } from "./ai.js";

const base: DealContext = {
  name: "Reagan County Royalties", stage: "SENT_TO_BUYERS", recordType: "OPPORTUNITY",
  state: "TX", states: ["TX"], counties: ["Reagan", "Irion"],
  operator: "Pioneer Natural Resources", assetTypes: ["Royalty"], basins: ["Permian"], formations: ["Wolfcamp"],
  acreageNma: 120.5, nra: 15.25, askPrice: 450000, ourPrice: 300000, estimatedClosingCosts: 5000,
  sellerNames: ["Smith Family Trust"], selectedBuyer: null,
  dateUnderContract: "2026-06-01", originalClosingDate: "2026-07-15",
  findBuyerByDate: "2026-06-16", finalClosingDate: "2026-07-30", notes: "Motivated seller.",
};

describe("dealFacts", () => {
  it("includes populated fields with readable labels + formatting", () => {
    const f = dealFacts(base);
    expect(f).toContain("Deal: Reagan County Royalties");
    expect(f).toContain("Stage: sent to buyers");
    expect(f).toContain("Geography: TX");
    expect(f).toContain("Counties: Reagan, Irion");
    expect(f).toContain("Ask price (to buyers): $450,000");
    expect(f).toContain("Net mineral acres (NMA): 120.5");
    expect(f).toContain("Date under contract: 2026-06-01");
  });

  it("omits missing/empty fields entirely (no blank lines, no invented data)", () => {
    const sparse: DealContext = {
      ...base, operator: null, ourPrice: null, askPrice: null, notes: null,
      basins: [], formations: [], sellerNames: [], counties: [],
    };
    const f = dealFacts(sparse);
    expect(f).not.toContain("Operator");
    expect(f).not.toContain("Ask price");
    expect(f).not.toContain("Basins");
    expect(f).not.toMatch(/^-\s*$/m); // no empty bullet lines
  });

  it("labels owned assets distinctly from opportunities", () => {
    expect(dealFacts({ ...base, recordType: "OWNED_ASSET" })).toContain("Type: Owned mineral asset");
    expect(dealFacts(base)).toContain("Type: Acquisition opportunity");
  });
});
