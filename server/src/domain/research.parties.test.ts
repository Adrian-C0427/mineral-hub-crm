/**
 * One party per name (buyer AND seller side): "&"/"and" between organisations
 * splits, bracketed annotations and role words leave the name, generic words
 * earn no similarity. The cases are the ones the user saw offered as aliases
 * of Morningstar Minerals.
 */
import { describe, expect, it } from "vitest";
import { documentInterestPct, documentPartyFields, parsePartyCell } from "./research.js";
import { nameSimilarity } from "./researchBuyers.js";

const names = (cell: string) => parsePartyCell(cell).parties.map((p) => p.name);

describe("ampersand between organisations", () => {
  it("splits two complete organisations", () => {
    expect(names("MORNINGSTAR MINERALS WEST LP & MORNINGSTAR MINERALS WEST GP LLC GEN PT"))
      .toEqual(["MORNINGSTAR MINERALS WEST LP", "MORNINGSTAR MINERALS WEST GP LLC"]);
    expect(names("ABC MINERALS LLC and XYZ ROYALTY TRUST")).toEqual(["ABC MINERALS LLC", "XYZ ROYALTY TRUST"]);
  });
  it("keeps one entity when only one legal form is present, and keeps couples together", () => {
    expect(names("SMITH & SONS LLC")).toEqual(["SMITH & SONS LLC"]);
    expect(names("JOHN & MARY SMITH")).toEqual(["JOHN & MARY SMITH"]);
    expect(names("BROWN & ROOT MINERALS LP")).toEqual(["BROWN & ROOT MINERALS LP"]);
  });
  it("gives each party its own share: the fraction stays with the party it was written against", () => {
    const { parties } = parsePartyCell("MORNINGSTAR MINERALS WEST LP (2/3) & FLYING SQUIRREL MINERALS LLC");
    expect(parties.map((p) => [p.name, p.pct])).toEqual([["MORNINGSTAR MINERALS WEST LP", 66.6667], ["FLYING SQUIRREL MINERALS LLC", null]]);
  });
});

describe("annotations leave the name but stay as data", () => {
  it("keeps an acreage against the party, not in its name", () => {
    const { parties } = parsePartyCell("MORNINGSTAR MINERALS LLC (40.00 net mineral acres)");
    expect(parties).toHaveLength(1);
    expect(parties[0].name).toBe("MORNINGSTAR MINERALS LLC");
    expect(parties[0].acres).toBe(40);
    const pf = documentPartyFields(null, "MORNINGSTAR MINERALS LLC (40.00 net mineral acres)");
    expect(pf.granteeParties).toEqual(["MORNINGSTAR MINERALS LLC"]);
    expect(pf.partyInterests).toEqual([{ side: "GRANTEE", party: "MORNINGSTAR MINERALS LLC", norm: "MORNINGSTAR MINERALS", pct: null, text: null, acres: 40 }]);
    expect(pf.interestPct).toBeNull(); // an acreage is not a share
    expect(documentInterestPct(pf.partyInterests)).toBeNull();
  });
  it("drops the empty shell a removed share leaves behind", () => {
    const { parties } = parsePartyCell("Morningstar Minerals West LP (1/2 of Grantor's interest)");
    expect(parties[0].name).toBe("Morningstar Minerals West LP");
    expect(parties[0].pct).toBe(50);
    expect(parties[0].note).toBeNull();
  });
  it("keeps any other bracketed remark as a note", () => {
    const { parties } = parsePartyCell("ABC MINERALS LLC (as to Tract 2 only)");
    expect(parties[0].name).toBe("ABC MINERALS LLC");
    expect(parties[0].note).toBe("as to Tract 2 only");
  });
});

describe("role words are dropped from the name", () => {
  it.each([
    ["MORNINGSTAR MINERALS I GP LLC PARTNER", "MORNINGSTAR MINERALS I GP LLC"],
    ["MORNINGSTAR MINERALS WEST GP LLC GEN PT", "MORNINGSTAR MINERALS WEST GP LLC"],
    ["MORNINGSTAR MINERALS WEST GP LLC, GENERAL PARTNER", "MORNINGSTAR MINERALS WEST GP LLC"],
    ["JOHN SMITH, TRUSTEE", "JOHN SMITH"],
    ["JOHN SMITH AS SUCCESSOR TRUSTEE", "JOHN SMITH"],
    ["MARY SMITH, INDIVIDUALLY", "MARY SMITH"],
    ["JOHN SMITH, AIF", "JOHN SMITH"],
    ["JOHN SMITH, INDEPENDENT EXECUTOR", "JOHN SMITH"],
  ])("%s → %s", (cell, expected) => {
    expect(names(cell)).toEqual([expected]);
  });
  it("never cuts a name that merely contains those letters", () => {
    expect(names("SILENT PARTNERS LLC")).toEqual(["SILENT PARTNERS LLC"]);
    expect(names("TRUSTEE SPRINGS RANCH LP")).toEqual(["TRUSTEE SPRINGS RANCH LP"]);
    expect(names("SMITH FAMILY TRUST")).toEqual(["SMITH FAMILY TRUST"]);
  });
  it("still keeps a surname-first person as one party", () => {
    expect(names("GARCIA, MARIA")).toEqual(["GARCIA, MARIA"]);
    expect(names("THOMPSON, ROBERT, TRUSTEE")).toEqual(["THOMPSON, ROBERT"]);
  });
});

describe("similarity ignores words every mineral company shares", () => {
  it("does not confuse One Star Minerals with Morningstar Minerals", () => {
    expect(nameSimilarity("ONE STAR MINERALS LLC", "MORNINGSTAR MINERALS LLC")).toBeLessThan(0.8);
    expect(nameSimilarity("LONE STAR ROYALTY LP", "STAR MINERALS LLC")).toBeLessThan(0.8);
  });
  it("still finds the same company written differently, and its numbered affiliates", () => {
    expect(nameSimilarity("Morningstar Minerals, L.L.C.", "MORNINGSTAR MINERALS LLC")).toBe(1);
    expect(nameSimilarity("MORNINGSTAR MINERALS WEST II LP", "MORNINGSTAR MINERALS WEST III LP")).toBeGreaterThanOrEqual(0.8);
    expect(nameSimilarity("MORNINGSTAR MINERALS LLC", "MORNINGSTAR MINERALS WEST LP")).toBeGreaterThanOrEqual(0.8);
    expect(nameSimilarity("MORNINGSTAR MINERALS LLC", "MORNINGSTAR MINERALS WEST LP")).toBeLessThan(1); // different names never read as identical
  });
});
