import { describe, it, expect } from "vitest";
import { annualRoyaltyIncome, type RevenueRow } from "./serializers.js";

// A fixed "now" so the trailing-12-month window is deterministic: the window is
// 2025-08 through 2026-07 (cutoff = 2025-08-01).
const NOW = new Date("2026-07-15T00:00:00Z");
const m = (ym: string, amount: number, kind = "ROYALTY"): RevenueRow => ({
  month: new Date(`${ym}-01T00:00:00Z`),
  amount,
  kind,
});

describe("annualRoyaltyIncome", () => {
  it("returns null when no royalty has ever been recorded", () => {
    expect(annualRoyaltyIncome([], NOW)).toBeNull();
    // Lease bonuses / other kinds don't count as royalty history.
    expect(annualRoyaltyIncome([m("2026-06", 5000, "LEASE_BONUS"), m("2026-05", 1000, "OTHER")], NOW)).toBeNull();
  });

  it("sums ROYALTY entries within the trailing twelve months", () => {
    const entries = [m("2026-07", 1000), m("2026-01", 2000), m("2025-08", 500)];
    expect(annualRoyaltyIncome(entries, NOW)).toBe(3500);
  });

  it("excludes royalty older than twelve months but still returns a number (0) once any royalty exists", () => {
    // All royalty predates the window → the asset has history but no recent income.
    expect(annualRoyaltyIncome([m("2024-01", 9000), m("2025-07", 4000)], NOW)).toBe(0);
    // Boundary: 2025-07 is just outside the window, 2025-08 is inside.
    expect(annualRoyaltyIncome([m("2025-07", 100), m("2025-08", 200)], NOW)).toBe(200);
  });

  it("counts only ROYALTY, ignoring lease bonuses and other income in the window", () => {
    const entries = [m("2026-06", 1000), m("2026-06", 5000, "LEASE_BONUS"), m("2026-05", 250, "OTHER")];
    expect(annualRoyaltyIncome(entries, NOW)).toBe(1000);
  });
});
