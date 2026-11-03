/**
 * Rules v5 — conveyed-interest shares as the 2026-11 Leon and Freestone
 * transaction lists write them. Each case is a cell shape from those files
 * that used to show a wrong or missing interest, or a fake party.
 */
import { describe, expect, it } from "vitest";
import { documentPartyFields, extractInterest, parsePartyCell } from "./research.js";

const shares = (cell: string) => parsePartyCell(cell).parties.map((p) => [p.name, p.pct]);
const grantee = (cell: string) => documentPartyFields("SELLER JOHN", cell);

describe("shares that round to the whole", () => {
  it("count as 100% instead of losing the interest figure", () => {
    const six = Array.from({ length: 6 }, (_, i) => `BUYER ${"ABCDEF"[i]} LLC (16.67%)`).join("; ");
    expect(grantee(six).interestPct).toBe(100); // 100.02
    expect(grantee("A LLC (33.3333%); B LLC (33.3333%); C LLC (33.3333%)").interestPct).toBe(100); // 99.9999
    expect(grantee("A LLC (59.2593%); B LLC (40.7408%)").interestPct).toBe(100); // 100.0001
  });
  it("still treat a real partial sale as partial, and never exceed 100", () => {
    expect(grantee("A LLC (11.875%); B LP (0.625%); C LLC (20%); D LLC (4%); E LLC (1%)").interestPct).toBe(37.5);
    expect(grantee("A LLC (60%); B LLC (45%)").interestPct).toBeNull();
  });
});

describe("separators inside brackets", () => {
  it("a percent and a remark in one bracket stay with their party", () => {
    const pf = grantee("ARKOMA LOUISIANA LLC (88.888888%, 8/9ths); DOWN RIGHT ROYALTIES LLC (11.11111%, 1/9th)");
    expect(pf.granteeParties).toEqual(["ARKOMA LOUISIANA LLC", "DOWN RIGHT ROYALTIES LLC"]);
    expect(pf.interestPct).toBe(100);
    expect(pf.partyInterests.map((i) => i.note ?? null)).toEqual([null, null]);
    const kept = parsePartyCell("EIGHT ROW 1B LLC (49.10769%, retained); ALTO MINERALS (50.89231%)").parties;
    expect(kept.map((p) => [p.name, p.pct, p.note])).toEqual([["EIGHT ROW 1B LLC", 49.1077, "retained"], ["ALTO MINERALS", 50.8923, null]]);
  });
  it("signer and care-of lines leave the party without becoming parties or notes", () => {
    for (const cell of ["VANGUARD PARTNERS LLC (by Aric McCumber, Member)", "VANGUARD PARTNERS LLC (BY JOHN & MARY SMITH)"]) {
      expect(parsePartyCell(cell).parties.map((p) => [p.name, p.note])).toEqual([["VANGUARD PARTNERS LLC", null]]);
    }
    expect(parsePartyCell("DAMP TRUSTS (C/O TAMI DOVE, TRUSTEE)").parties.map((p) => [p.name, p.note])).toEqual([["DAMP TRUSTS", null]]);
  });
  it("other bracketed remarks with commas stay one note", () => {
    const { parties } = parsePartyCell("TANDY OSRO LOFLAND (AKA TANDY O LOFLAND, T O LOFLAND, JR)");
    expect(parties.map((p) => [p.name, p.note])).toEqual([["TANDY OSRO LOFLAND", "AKA TANDY O LOFLAND, T O LOFLAND, JR"]]);
  });
  it("a surname-first person with a share is still one person", () => {
    expect(shares("GARCIA, MARIA (50%)")).toEqual([["GARCIA, MARIA", 50]]);
  });
  it("a bracket listing several parties with shares is split like the cell", () => {
    const pf = grantee("MARKE EXPLORATION INC ET AL (85%/LOGAN M PETTIT 5%/BRADY M PETTIT 5%/HELEN LOKEY 5%)");
    expect(pf.granteeParties).toEqual(["MARKE EXPLORATION INC ET AL", "LOGAN M PETTIT", "BRADY M PETTIT", "HELEN LOKEY"]);
    expect(pf.interestPct).toBe(100);
  });
});

describe("share notation", () => {
  it("a [x% TOTAL] tag is not a share", () => {
    const pf = grantee("A LLC (30%); B LLC (36%) [66% TOTAL]");
    expect(pf.partyInterests.map((i) => [i.party, i.pct, i.note ?? null])).toEqual([["A LLC", 30, null], ["B LLC", 36, null]]);
    expect(pf.interestPct).toBe(66);
  });
  it("a fraction beside its percent is the same share, not a note", () => {
    const { parties } = parsePartyCell("CRITES TOMMIE KNIGHT (1/3) (33.3333%); KNIGHT RONNY GLEN (1/3) (33.3333%)");
    expect(parties.map((p) => [p.name, p.pct, p.note])).toEqual([["CRITES TOMMIE KNIGHT", 33.3333, null], ["KNIGHT RONNY GLEN", 33.3333, null]]);
  });
  it("ordinal fractions are shares", () => {
    expect(shares("MORNINGSTAR MINERALS WEST LP 10/19ths (52.6316%); FLYING SQUIRREL MINERALS LLC 9/19ths (47.3684%)"))
      .toEqual([["MORNINGSTAR MINERALS WEST LP", 52.6316], ["FLYING SQUIRREL MINERALS LLC", 47.3684]]);
    expect(extractInterest("ONE STAR MINERALS LLC 1/3rd")).toMatchObject({ name: "ONE STAR MINERALS LLC", pct: 33.3333 });
  });
  it("a 0% party is on the deed with no share, not a buyer named '… 0.0%'", () => {
    expect(shares("FLATLAND MINERAL FUND IV LP 45.0%; VECTOR ENERGY PARTNERS LLC 0.0%; HIGH WEST MINERALS LP 55%"))
      .toEqual([["FLATLAND MINERAL FUND IV LP", 45], ["VECTOR ENERGY PARTNERS LLC", 0], ["HIGH WEST MINERALS LP", 55]]);
  });
});

describe("roles and capacities are never parties", () => {
  const names = (cell: string) => parsePartyCell(cell).parties.map((p) => [p.name, p.note ?? null]);
  it("a chain of roles comes off whole", () => {
    expect(names("BUDNER KEITH HOWARD INDIV & TRUSTEE")).toEqual([["BUDNER KEITH HOWARD", null]]);
    expect(names("SCLATER KENNETH CAMERON III INDIV EXECUTOR & TRUSTEE")).toEqual([["SCLATER KENNETH CAMERON III", null]]);
    expect(names("MURRAY ELIZABETH LYNN INDIV EXTR & TTEE")).toEqual([["MURRAY ELIZABETH LYNN", null]]);
    expect(names("LEHMAN ROD KEVIN INDIVIDUALLY AND AS INDEPENDENT EXECUTOR")).toEqual([["LEHMAN ROD KEVIN", null]]);
    expect(names("JOHN F WILINSKY, INDIVIDUALLY AND AS TRUSTEE; WILINSKY MARY ALICE TRUST"))
      .toEqual([["JOHN F WILINSKY", null], ["WILINSKY MARY ALICE TRUST", null]]);
    expect(shares("HUFF MIMI D INDIV & TRUSTEE (10.17%); LA GRONE CHARLES W BYPASS TRUST (29.66%)"))
      .toEqual([["HUFF MIMI D", 10.17], ["LA GRONE CHARLES W BYPASS TRUST", 29.66]]);
  });
  it("what a role-only part names stays as a note on the party before it", () => {
    expect(names("DANIEL TRICE LUKER, TRUSTEE & EXECUTOR (LUKER FAMILY TRUST)")).toEqual([["DANIEL TRICE LUKER", "LUKER FAMILY TRUST"]]);
    expect(shares("JOHN SMITH, AS TRUSTEE (50%)")).toEqual([["JOHN SMITH", 50]]);
  });
  it("a capacity clause after a comma is the party's note, not another party", () => {
    expect(names("CLINT WADE SUTTON, INDIVIDUALLY AND AS INDEPENDENT EXECUTOR OF THE ESTATE OF C R SUTTON, DECEASED"))
      .toEqual([["CLINT WADE SUTTON", "INDIVIDUALLY AND AS INDEPENDENT EXECUTOR OF THE ESTATE OF C R SUTTON, DECEASED"]]);
    expect(names("CAROL ANN DAWLEY, INDEPENDENT ADMINISTRATOR OF THE ESTATE OF ANNIE VENIA BRITT"))
      .toEqual([["CAROL ANN DAWLEY", "INDEPENDENT ADMINISTRATOR OF THE ESTATE OF ANNIE VENIA BRITT"]]);
    expect(names("RAY CLYDE IRBY JR, DECEASED, ESTATE OF (MARK ALAN RAY, EXECUTOR)"))
      .toEqual([["RAY CLYDE IRBY JR", "DECEASED, ESTATE OF (MARK ALAN RAY, EXECUTOR)"]]);
    expect(names("KENNETH W MADDOX & LORITA Y MADDOX, HUSBAND AND WIFE")).toEqual([["KENNETH W MADDOX & LORITA Y MADDOX", null]]);
  });
});

describe("shares are never lost", () => {
  it("'&' between grantees that each have a share splits them", () => {
    const pf = grantee("SAND COYOTE HOLDINGS LLC (35%) & CO3 INVESTMENTS LLC (35%) & JAMES RYAN CAIN (17.5%) & MULTIPLIED CAPITAL INC (12.5%)");
    expect(pf.granteeParties).toEqual(["SAND COYOTE HOLDINGS LLC", "CO3 INVESTMENTS LLC", "JAMES RYAN CAIN", "MULTIPLIED CAPITAL INC"]);
    expect(pf.interestPct).toBe(100);
    // A couple written with one share is still one party.
    expect(shares("JOHN & MARY SMITH (50%)")).toEqual([["JOHN & MARY SMITH", 50]]);
  });
  it("the same party named twice with a share each holds both", () => {
    const pf = grantee("WALLENDER JAMES C TRUSTEE (20%); HUFFMAN BECKY TRUSTEE (A TRUST) (20%); HUFFMAN BECKY TRUSTEE (B TRUST) (20%)");
    expect(pf.partyInterests.filter((i) => i.pct != null).map((i) => [i.party, i.pct])).toEqual([["WALLENDER JAMES C", 20], ["HUFFMAN BECKY", 40]]);
    expect(pf.interestPct).toBe(60);
  });
});
