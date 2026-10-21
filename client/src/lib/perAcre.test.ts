import { describe, it, expect } from "vitest";
import { acreageLinked, nraFromNma, perAcreRates } from "./perAcre";
import { syncPriceGroup, priceGroupFromStored } from "../components/DealEconomics";

describe("perAcreRates — one formula for $/NMA and $/NRA", () => {
  it("gives the same $/NRA for every deal priced at the same $/NMA and royalty (the reported case)", () => {
    // Three deals at $7,000/NMA, 1/5 royalty: NMA 8.752, 8.752 and 8.7523.
    for (const nma of [8.752, 8.752, 8.7523]) {
      const nra = nraFromNma(nma, 0.2)!;              // 14.0032 / 14.0032 / 14.0037
      const total = Math.round(7000 * nma * 100) / 100; // $61,264.00 / $61,264.00 / $61,266.10
      const r = perAcreRates(total, nma, nra, 0.2);
      expect(r.perNma).toBe(7000);
      expect(r.perNra).toBe(4375); // through the royalty: 7,000 ÷ 1.6 — never 4,374.99
    }
  });

  it("falls back to total ÷ NRA when the NRA was entered on its own (not the NMA converted)", () => {
    const r = perAcreRates(61264, 8.752, 20, 0.2);
    expect(acreageLinked(8.752, 20, 0.2)).toBe(false);
    expect(r.perNma).toBe(7000);
    expect(r.perNra).toBe(3063.2);
  });

  it("is N/A without a total or a positive acreage, and handles a missing royalty", () => {
    expect(perAcreRates(null, 10, 20, 0.2)).toEqual({ perNma: null, perNra: null });
    expect(perAcreRates(1000, 0, 20, null)).toEqual({ perNma: null, perNra: 50 });
    expect(perAcreRates(1000, 10, null, null)).toEqual({ perNma: 100, perNra: null });
  });
});

describe("price groups follow the same rule while editing", () => {
  it("typing $7,000/NMA at 1/5 shows exactly $4,375/NRA whatever the acreage", () => {
    for (const nma of [8.752, 8.7523, 0.3333]) {
      const nra = nraFromNma(nma, 0.2);
      const g = syncPriceGroup({ perNma: "7000", perNra: "", total: "", source: "perNma" }, nma, nra, 0.2);
      expect(g.perNra).toBe("4375");
      expect(Number(g.total)).toBe(Math.round(7000 * nma * 100) / 100);
    }
  });

  it("reloading a stored rate-driven price keeps the typed rate as the driver", () => {
    const nma = 8.7523, nra = nraFromNma(nma, 0.2);
    const g = priceGroupFromStored(7000, 4375, 61266.1, nma, nra, 0.2);
    expect(g.source).toBe("perNma");
    expect(g.perNma).toBe("7000");
    expect(g.perNra).toBe("4375");
  });
});
