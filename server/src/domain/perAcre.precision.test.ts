import { describe, it, expect } from "vitest";
import { perAcreRates, totalFromPerAcre } from "./perAcre.js";
import { nraFromNma } from "./royalty.js";
import { normalizeNumbers } from "../routes/deals.js";
import { perAcreRates as clientPerAcreRates, nraFromNma as clientNraFromNma } from "../../../client/src/lib/perAcre";

describe("server per-acre math mirrors the client exactly", () => {
  it("rounds half cents the same way (no Math.round(n*100)/100 miss)", () => {
    expect(totalFromPerAcre(1.005, 1, null, null)).toBe(1.01);
  });
  it("gives the same $/NMA and $/NRA as the client for the reported deals", () => {
    for (const nma of [8.752, 8.7523, 0.3333]) {
      const nra = nraFromNma(nma, 0.2)!;
      expect(nra).toBe(clientNraFromNma(nma, 0.2));
      const total = totalFromPerAcre(7000, nma, null, null)!;
      expect(perAcreRates(total, nma, nra, 0.2)).toEqual(clientPerAcreRates(total, nma, nra, 0.2));
      expect(perAcreRates(total, nma, nra, 0.2).perNra).toBe(4375);
    }
  });
});

describe("normalizeNumbers — precision fixed at the API boundary", () => {
  it("keeps acreage to 4 places and money to the cent, leaves everything else alone", () => {
    const d = normalizeNumbers({ acreageNma: 8.75234, nra: 14.00374, ourPrice: 61266.104, ourCostPerNma: 7000.004, name: "x", notes: null, askPrice: null });
    expect(d).toEqual({ acreageNma: 8.7523, nra: 14.0037, ourPrice: 61266.1, ourCostPerNma: 7000, name: "x", notes: null, askPrice: null });
  });
});
