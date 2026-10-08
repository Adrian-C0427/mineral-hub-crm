import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoyaltyRate, royaltyValue, royaltyLabel, nraFromNma, nmaFromNra, ROYALTY_RATE_OPTIONS } from "./royalty.js";
import { totalFromPerAcre } from "./perAcre.js";
import { dealNetProfit } from "./metrics.js";

describe("parseRoyaltyRate", () => {
  it("reads every accepted form of 18.75% as the same decimal interest", () => {
    for (const input of ["3/16", "18.75%", "0.1875", "18.75", " 18.75 % ", "3 / 16", "6/32", ".1875"]) {
      const p = parseRoyaltyRate(input);
      expect(p.ok, input).toBe(true);
      if (p.ok) expect(p.value, input).toBe(0.1875);
    }
  });

  it("stores a standard rate as its preset fraction, a custom fraction as typed, anything else as a percent", () => {
    const canon = (s: string) => { const p = parseRoyaltyRate(s); return p.ok ? p.canonical : null; };
    expect(canon("3/16")).toBe("3/16");
    expect(canon("18.75%")).toBe("18.75%");  // a typed percent stays a percent
    expect(canon("0.1875")).toBe("18.75%");
    expect(canon("0.125")).toBe("12.5%");
    expect(canon("2/16")).toBe("1/8");       // a fraction equal to a preset IS the preset
    expect(canon("3/20")).toBe("3/20");      // custom fraction kept as written
    expect(canon("3 / 20")).toBe("3/20");
    expect(canon("0.1775")).toBe("17.75%");  // custom decimal → percent
    expect(canon("17.75")).toBe("17.75%");
    expect(canon("22%")).toBe("22%");
    expect(canon("0.00390625")).toBe("0.390625%"); // 8-place decimal interest survives
    expect(canon("100%")).toBe("100%");
    expect(canon("1")).toBe("100%");         // a bare 1 is the whole interest
  });

  it("rejects garbage and anything outside (0, 1] with a clear message", () => {
    for (const bad of ["", "   ", "abc", "1/0", "0", "0%", "0/8", "-1/8", "150%", "5/4", "250", "1/8 royalty", "18.75%%", "1..2", "NaN", "Infinity"]) {
      const p = parseRoyaltyRate(bad);
      expect(p.ok, bad).toBe(false);
      if (!p.ok) expect(p.error.length).toBeGreaterThan(0);
    }
  });

  it("keeps every stored standard value working unchanged", () => {
    const expected: Record<string, number> = { "1/16": 0.0625, "1/8": 0.125, "3/16": 0.1875, "1/6": 0.16666667, "1/5": 0.2, "9/40": 0.225, "1/4": 0.25 };
    for (const o of ROYALTY_RATE_OPTIONS) {
      const p = parseRoyaltyRate(o);
      expect(p.ok && p.canonical).toBe(o);
      expect(royaltyValue(o)).toBe(expected[o]);
    }
    expect(royaltyValue("25%")).toBe(0.25); // legacy percent strings
    expect(royaltyValue(null)).toBeNull();
    expect(royaltyValue("unknown")).toBeNull(); // legacy free text: no math, shown as-is
    expect(royaltyLabel("unknown")).toBe("unknown");
  });

  it("labels fractions with their percent and percents as themselves", () => {
    expect(royaltyLabel("3/16")).toBe("3/16 · 18.75%");
    expect(royaltyLabel("1/6")).toBe("1/6 · 16.666667%");
    expect(royaltyLabel("18.75%")).toBe("18.75%");
    expect(royaltyLabel("0.1875")).toBe("18.75%");
    expect(royaltyLabel("")).toBe("");
  });
});

describe("calculations with a custom royalty rate", () => {
  it("NMA ↔ NRA at a custom 18.75% match the 3/16 preset exactly (NRA normalized to 1/8)", () => {
    for (const r of ["3/16", "18.75%", "0.1875", "18.75"]) {
      expect(nraFromNma(10, royaltyValue(r)), r).toBe(15);
      expect(nmaFromNra(15, royaltyValue(r)), r).toBe(10);
    }
    expect(nraFromNma(10, royaltyValue("1/8"))).toBe(10);
    expect(nraFromNma(10, royaltyValue("1/4"))).toBe(20);
    expect(nraFromNma(40, royaltyValue("17.5%"))).toBe(56); // 40 × 0.175 × 8
    expect(nraFromNma(10, royaltyValue("garbage"))).toBeNull();
  });

  it("worked example: price and profit from a custom-rate deal", () => {
    // 10 NMA at 18.75% → 15 NRA; Our cost $2,000/NRA → $30,000.
    const nra = nraFromNma(10, royaltyValue("18.75%"));
    const ourPrice = totalFromPerAcre(null, 10, 2000, nra);
    expect(ourPrice).toBe(30_000);
    // Accepted offer $40,000, closing costs $1,234.56 → $8,765.44 net profit.
    expect(dealNetProfit(40_000, { ourPrice, askPrice: 45_000, estimatedClosingCosts: 1234.56 })).toBe(8765.44);
  });
});

// The client mirrors (client/src/lib/royalty.ts, money.ts, perAcre.ts) must
// agree with the server on every input — they are separate files because the
// two builds don't share code, so this keeps them from drifting.
describe("client mirrors agree with the server", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientLib = (f: string) => path.resolve(here, "../../../client/src/lib", f);
  const load = async (f: string): Promise<Record<string, (...a: unknown[]) => unknown>> => import(clientLib(f));

  it("royalty parser", async () => {
    const client = await load("royalty.ts");
    const inputs = ["3/16", "18.75%", "0.1875", "18.75", "6/32", "3/20", "1/6", "9/40", "0.00390625", "1", "100%",
      "", "abc", "1/0", "0", "150%", "5/4", "1/8 royalty", " 22.5 % ", ".2", null, undefined];
    for (const i of inputs) {
      expect(client.parseRoyaltyRate(i), String(i)).toEqual(parseRoyaltyRate(i as string));
      expect(client.royaltyValue(i), String(i)).toEqual(royaltyValue(i as string));
      expect(client.royaltyLabel(i), String(i)).toEqual(royaltyLabel(i as string));
    }
  });

  it("money rounding and NMA ↔ NRA", async () => {
    const cm = await load("money.ts");
    const sm = await import("./money.js");
    for (const n of [1.005, -1.005, 2.675, 0.1 + 0.2, 1e-7, 123456.785, -0.004, 1e21]) {
      expect(cm.roundMoney(n), String(n)).toBe(sm.roundMoney(n));
      expect(cm.roundTo(n, 4), String(n)).toBe(sm.roundTo(n, 4));
    }
    expect(cm.sumMoney([0.1, 0.2, null, 1.005])).toBe(sm.sumMoney([0.1, 0.2, null, 1.005]));
    const cp = await load("perAcre.ts");
    for (const [a, r] of [[10, 0.1875], [3.3333, 0.2], [40, 0.175], [7, 1 / 6]] as const) {
      expect(cp.nraFromNma(a, r)).toBe(nraFromNma(a, r));
      expect(cp.nmaFromNra(a, r)).toBe(nmaFromNra(a, r));
    }
  });
});
