import { describe, it, expect } from "vitest";
import { parseFromAddress, isInboundEmailProvider } from "./emailInboundSync.js";

describe("parseFromAddress", () => {
  it("extracts from display-name form", () => {
    expect(parseFromAddress("Riley Cole <riley@basinpeak.com>")).toBe("riley@basinpeak.com");
  });
  it("handles bare addresses and lowercases", () => {
    expect(parseFromAddress("Riley.Cole@BasinPeak.com")).toBe("riley.cole@basinpeak.com");
  });
  it("handles quoted display names with commas", () => {
    expect(parseFromAddress('"Cole, Riley" <riley@basinpeak.com>')).toBe("riley@basinpeak.com");
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
