import { describe, it, expect } from "vitest";
import { effectiveStatus, LEGACY_TO_STATUS } from "./buyerStatus.js";

describe("effectiveStatus", () => {
  it("prefers the new status when set", () => {
    expect(effectiveStatus({ status: "NEGOTIATING", responseStatus: "PENDING" })).toBe("NEGOTIATING");
  });
  it("maps legacy responseStatus when status is null (pre-backfill)", () => {
    expect(effectiveStatus({ status: null, responseStatus: "OFFER_MADE" })).toBe("OFFER_RECEIVED");
    expect(effectiveStatus({ status: null, responseStatus: "NOT_INTERESTED" })).toBe("PASSED");
    expect(effectiveStatus({ status: null, responseStatus: "PENDING" })).toBe("CONTACTED");
  });
  it("defaults to CONTACTED when nothing is set", () => {
    expect(effectiveStatus({})).toBe("CONTACTED");
  });
  it("legacy map covers every old value", () => {
    expect(Object.keys(LEGACY_TO_STATUS).sort()).toEqual(
      ["INTERESTED", "NOT_INTERESTED", "OFFER_MADE", "PASSED", "PENDING"].sort(),
    );
  });
});
