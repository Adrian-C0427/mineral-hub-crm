import { describe, it, expect } from "vitest";
import { parseFromAddress, isInboundEmailProvider } from "./emailInboundSync.js";

describe("parseFromAddress", () => {
  it("extracts from display-name form", () => {
    expect(parseFromAddress("Riley Cole <riley@summitpeak.com>")).toBe("riley@summitpeak.com");
  });
  it("handles bare addresses and lowercases", () => {
    expect(parseFromAddress("Riley.Cole@SummitPeak.com")).toBe("riley.cole@summitpeak.com");
  });
  it("handles quoted display names with commas", () => {
    expect(parseFromAddress('"Cole, Riley" <riley@summitpeak.com>')).toBe("riley@summitpeak.com");
  });
  it("returns null for garbage", () => {
    expect(parseFromAddress("undisclosed-recipients")).toBeNull();
  });
});

describe("isInboundEmailProvider", () => {
  it("covers exactly outlook (gmail was retired 2026-07)", () => {
    expect(isInboundEmailProvider("outlook")).toBe(true);
    expect(isInboundEmailProvider("gmail")).toBe(false);
    expect(isInboundEmailProvider("smtp")).toBe(false);
    expect(isInboundEmailProvider("onedrive")).toBe(false);
  });
});
