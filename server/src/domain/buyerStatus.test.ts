import { describe, it, expect } from "vitest";
import { effectiveStatus, LEGACY_TO_STATUS, BUYER_STATUSES, ENGAGED_STATUSES, STATUS_ORDER } from "./buyerStatus.js";

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

describe("NO_RESPONSE", () => {
  it("is a selectable status, listed directly after CONTACTED", () => {
    expect(BUYER_STATUSES.indexOf("NO_RESPONSE")).toBe(BUYER_STATUSES.indexOf("CONTACTED") + 1);
    expect(effectiveStatus({ status: "NO_RESPONSE", responseStatus: "INTERESTED" })).toBe("NO_RESPONSE");
  });
  it("is not engaged, like CONTACTED", () => {
    expect(ENGAGED_STATUSES).not.toContain("NO_RESPONSE");
    expect(ENGAGED_STATUSES).not.toContain("CONTACTED");
  });
  it("sorts between CONTACTED and PASSED, leaving the existing order intact", () => {
    expect(STATUS_ORDER.NO_RESPONSE).toBeGreaterThan(STATUS_ORDER.CONTACTED);
    expect(STATUS_ORDER.NO_RESPONSE).toBeLessThan(STATUS_ORDER.PASSED);
    const order = (Object.keys(STATUS_ORDER) as (keyof typeof STATUS_ORDER)[])
      .sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b]).filter((s) => s !== "NO_RESPONSE");
    expect(order).toEqual(["CLOSED", "ACCEPTED", "NEGOTIATING", "OFFER_RECEIVED", "REVIEWING", "INTERESTED", "CONTACTED", "PASSED"]);
  });
  it("is never produced from a legacy response status", () => {
    expect(Object.values(LEGACY_TO_STATUS)).not.toContain("NO_RESPONSE");
  });
});
