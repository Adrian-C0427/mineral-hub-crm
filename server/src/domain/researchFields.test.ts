import { describe, it, expect } from "vitest";
import {
  countsAsAcquisition, docTypeFlags, documentFlags, pairTracts, parsePercentSold, sellerFlags, shareBasis,
  statedTotalPct, surveyKey, surveyList, txGroupKey,
} from "./researchFields.js";
import { classifyDocType } from "./research.js";
import type { PartyInterest } from "./research.js";

const grantees = (...pcts: number[]): PartyInterest[] =>
  pcts.map((pct, i) => ({ side: "GRANTEE", party: `P${i}`, norm: `P${i}`, pct, text: `${pct}%` }));

describe("percent sold", () => {
  it("reads one value in the shapes county lists use", () => {
    expect(parsePercentSold("66%")).toMatchObject({ pct: 66, multi: false, invalid: false });
    expect(parsePercentSold("42.4266%").pct).toBe(42.4266);
    expect(parsePercentSold(" 87.5 % ").pct).toBe(87.5);
    expect(parsePercentSold("1/2").pct).toBe(50);
    expect(parsePercentSold("").raw).toBeNull();
  });
  it("keeps several values verbatim and never picks one", () => {
    const p = parsePercentSold("66.67%; 33.33%");
    expect(p).toEqual({ pct: null, raw: "66.67%; 33.33%", multi: true, invalid: false });
  });
  it("leaves an unreadable or out-of-range cell as recorded, without a number", () => {
    expect(parsePercentSold("all")).toMatchObject({ pct: null, raw: "all", invalid: true });
    expect(parsePercentSold("150%")).toMatchObject({ pct: null, invalid: true });
  });
});

describe("share basis (grantee shares vs percent sold)", () => {
  it("absolute when the shares add up to percent sold", () => {
    expect(shareBasis(66, grantees(30, 9, 6, 3.6, 1.5, 1.5, 3, 2.1, 1.8, 1.8, 1.5, 1.2, 0.6, 0.6, 0.6, 0.6, 0.6))).toBe("absolute");
  });
  it("of-conveyed when the shares add up to 100 and percent sold is lower", () => {
    expect(shareBasis(87.5, grantees(100))).toBe("of-conveyed");
    expect(shareBasis(50, grantees(33.3333, 66.6667))).toBe("of-conveyed");
  });
  it("unknown when neither holds; null when there is nothing to compare", () => {
    expect(shareBasis(62.88, grantees(3.375, 7))).toBe("unknown");
    expect(shareBasis(null, grantees(50, 50))).toBeNull();
    expect(shareBasis(100, [])).toBeNull();
  });
  it("reads the [x% TOTAL] tag", () => {
    expect(statedTotalPct("NEW HORIZON (30%); BERGSTROM (36%) [66% TOTAL]")).toBe(66);
    expect(statedTotalPct("A LLC (TOTAL 75%)")).toBe(75);
    expect(statedTotalPct("A LLC (50%)")).toBeNull();
  });
});

describe("flags and acquisitions", () => {
  it("flags re-recordings and non-purchases by instrument type", () => {
    expect(docTypeFlags("COR MINERAL DEED")).toEqual(["correction"]);
    expect(docTypeFlags("CORR MINERAL CONVEYN")).toEqual(["correction"]);
    expect(docTypeFlags("C C MINERAL DEED")).toEqual(["certified-copy"]);
    expect(docTypeFlags("Mineral Deed (Certified Copy)")).toEqual(["certified-copy"]);
    expect(docTypeFlags("AMD ASG ORR ROY INTR")).toEqual(["amendment"]);
    expect(docTypeFlags("GIFT DEED")).toEqual(["gift"]);
    expect(docTypeFlags("STIPULATION OF INTEREST")).toEqual(["stipulation"]);
    expect(docTypeFlags("MINERAL CONVEYNC")).toEqual([]);
    expect(docTypeFlags("CONVEYANCE")).toEqual([]); // "CON" is not "COR"
  });
  it("flags estate and trust sellers without excluding them", () => {
    expect(sellerFlags("ESTATE OF MILDRED MONCRIEF")).toEqual(["estate-or-trust-seller"]);
    expect(sellerFlags("BUDNER BRUCE ALBERT INDIV & TRUSTEE")).toEqual(["estate-or-trust-seller"]);
    expect(sellerFlags("MAXIMA MINERALS III LP")).toEqual([]);
    expect(countsAsAcquisition(documentFlags("MINERAL DEED", "ESTATE OF X"))).toBe(true);
  });
  it("keeps the outside-master-list tag across re-derivation", () => {
    const f = documentFlags("COR MINERAL DEED", "X", ["outside-master-list", "gift"]);
    expect(f).toEqual(["correction", "outside-master-list"]);
    expect(countsAsAcquisition(f)).toBe(false);
  });
});

describe("county index abbreviations", () => {
  it("classifies the master files' abbreviations as transfers", () => {
    expect(classifyDocType("TRSTEE MNRL DEED")?.docType).toBe("MINERAL_DEED");
    expect(classifyDocType("MINRL & ROY DEED")?.docType).toBe("ROYALTY_DEED");
    expect(classifyDocType("CONV PROD PAYMNT")?.docType).toBe("OG_CONVEYANCE");
  });
});

describe("same-day closing group", () => {
  const base = { docClass: "TRANSACTION", state: "TX", county: "Leon", recordingDate: new Date("2025-03-01T00:00:00Z"), grantorNorm: "A", granteeNorm: "B" };
  it("is the same for instruments over the same abstracts in any order", () => {
    expect(txGroupKey({ ...base, abstractIds: ["15", "47"] })).toBe(txGroupKey({ ...base, abstractIds: ["47", "15"] }));
  });
  it("differs by day, party or abstract; none for leases or unknown parties", () => {
    const k = txGroupKey({ ...base, abstractIds: ["15"] });
    expect(txGroupKey({ ...base, abstractIds: ["16"] })).not.toBe(k);
    expect(txGroupKey({ ...base, recordingDate: new Date("2025-03-02T00:00:00Z"), abstractIds: ["15"] })).not.toBe(k);
    expect(txGroupKey({ ...base, docClass: "LEASE", abstractIds: ["15"] })).toBeNull();
    expect(txGroupKey({ ...base, grantorNorm: null, abstractIds: ["15"] })).toBeNull();
  });
});

describe("surveys and tracts", () => {
  it("splits and standardizes the survey cell", () => {
    expect(surveyList("J F MARSH; J M H JONES; J F MARSH")).toEqual(["J. F. Marsh Survey", "J. M. H. Jones Survey"]);
  });
  it("pairs abstracts with surveys positionally only when the counts match", () => {
    expect(pairTracts("80; 542", "J N BLACK; J MYERS")).toEqual([{ abstract: "80", survey: "J N BLACK" }, { abstract: "542", survey: "J MYERS" }]);
    expect(pairTracts("80; 542", "J N BLACK")).toBeNull();
    expect(pairTracts("", "J N BLACK")).toBeNull();
  });
  it("matches a county index survey to the layer's spelling by letters", () => {
    expect(surveyKey("J. Y. Aquilera Survey")).toBe(surveyKey("Jy Aquilera Survey"));
  });
});
