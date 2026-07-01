import { describe, it, expect } from "vitest";
import { normalizePhone, normalizePhoneNullable } from "./phone.js";

describe("normalizePhone", () => {
  it("normalizes every common US format to 10 digits", () => {
    for (const input of [
      "9035551234",
      "903-555-1234",
      "(903)5551234",
      "(903) 555-1234",
      "903.555.1234",
      "+1 903 555 1234",
      "1-903-555-1234",
    ]) {
      expect(normalizePhone(input)).toBe("9035551234");
    }
  });

  it("returns empty string for nullish/empty", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone(undefined)).toBe("");
  });

  it("keeps non-standard lengths as stripped digits (best-effort)", () => {
    expect(normalizePhone("555-1234")).toBe("5551234");
    expect(normalizePhone("+44 20 7946 0958")).toBe("442079460958");
  });

  it("normalizePhoneNullable returns null for empty", () => {
    expect(normalizePhoneNullable("")).toBeNull();
    expect(normalizePhoneNullable("903.555.1234")).toBe("9035551234");
  });
});
