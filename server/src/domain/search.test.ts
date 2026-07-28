/**
 * Regression tests for the 2026-07-28 API audit fixes to the search surface.
 *
 * The bug these pin: `%` and `_` are LIKE pattern OPERATORS, so a term made of
 * them cleared the 3-character floor and still produced a pattern with no
 * extractable trigram — reopening the sequential scan of rrc.wells that the
 * trigram indexes and the two-stage /rrc-search query exist to prevent.
 */
import { describe, it, expect } from "vitest";
import { escapeLike, isSearchableTerm, rankRefEntries, MIN_SEARCH_CHARS, type RefEntry } from "./search.js";

describe("escapeLike", () => {
  it("neutralizes the wildcards that defeat a trigram index", () => {
    expect(escapeLike("%%%")).toBe("\\%\\%\\%");
    expect(escapeLike("___")).toBe("\\_\\_\\_");
  });

  it("escapes the escape character itself, and does so first", () => {
    // A naive implementation that handled % or _ before \ would double-escape
    // the backslashes it had just inserted.
    expect(escapeLike("\\")).toBe("\\\\");
    expect(escapeLike("a\\%b")).toBe("a\\\\\\%b");
  });

  it("leaves ordinary search terms untouched", () => {
    expect(escapeLike("PERMIAN BASIN")).toBe("PERMIAN BASIN");
    expect(escapeLike("42-123-45678")).toBe("42-123-45678");
    expect(escapeLike("O'BRIEN #1H")).toBe("O'BRIEN #1H");
  });

  it("makes a literal percent search for a percent", () => {
    // A user typing a lease name that really contains "%" should match it,
    // rather than matching every row in the table.
    expect(escapeLike("50%")).toBe("50\\%");
  });
});

describe("isSearchableTerm", () => {
  it("rejects terms below the trigram floor", () => {
    expect(MIN_SEARCH_CHARS).toBe(3);
    expect(isSearchableTerm("ab")).toBe(false);
    expect(isSearchableTerm("  a ")).toBe(false);
    expect(isSearchableTerm("abc")).toBe(true);
  });
});

const entry = (name: string, n: number): RefEntry => ({ name, n, bbox: null });

describe("rankRefEntries", () => {
  const operators = [
    entry("PIONEER NATURAL RESOURCES", 900),
    entry("PIONEER ENERGY", 50),
    entry("XTO PIONEER PARTNERS", 5000),
    entry("DEVON ENERGY", 400),
  ];

  it("ranks exact over prefix over substring, regardless of well count", () => {
    const ranked = rankRefEntries([entry("PIONEER", 1), ...operators], "pioneer", 10);
    expect(ranked.map((r) => r.name)).toEqual([
      "PIONEER",                    // exact, despite having the fewest wells
      "PIONEER NATURAL RESOURCES",  // prefix, more wells than PIONEER ENERGY
      "PIONEER ENERGY",
      "XTO PIONEER PARTNERS",       // substring only, despite the most wells
    ]);
  });

  it("breaks ties within a tier by well count", () => {
    const ranked = rankRefEntries([entry("A CO", 10), entry("B CO", 99)], "co", 10);
    expect(ranked.map((r) => r.name)).toEqual(["B CO", "A CO"]);
  });

  it("is case-insensitive and drops non-matches", () => {
    const ranked = rankRefEntries(operators, "DEVON", 10);
    expect(ranked.map((r) => r.name)).toEqual(["DEVON ENERGY"]);
  });

  it("honours the limit", () => {
    expect(rankRefEntries(operators, "e", 2)).toHaveLength(2);
  });

  it("returns nothing for an empty term rather than the whole table", () => {
    expect(rankRefEntries(operators, "   ", 10)).toEqual([]);
  });
});
