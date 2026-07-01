import { describe, it, expect } from "vitest";
import { resolvePermissions, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "./permissions.js";

describe("resolvePermissions", () => {
  it("gives OWNER every permission", () => {
    expect(resolvePermissions("OWNER").sort()).toEqual([...PERMISSIONS].sort());
  });

  it("falls back to role defaults with no override", () => {
    expect(resolvePermissions("VIEWER")).toEqual(DEFAULT_ROLE_PERMISSIONS.VIEWER);
    expect(resolvePermissions("MEMBER")).toEqual(DEFAULT_ROLE_PERMISSIONS.MEMBER);
  });

  it("uses a stored override (even empty) as authoritative", () => {
    expect(resolvePermissions("MANAGER", ["viewDeals"])).toEqual(["viewDeals"]);
    expect(resolvePermissions("MANAGER", [])).toEqual([]);
  });

  it("ignores unknown keys in an override", () => {
    expect(resolvePermissions("MEMBER", ["viewDeals", "bogusKey"])).toEqual(["viewDeals"]);
  });

  it("returns nothing for a null role", () => {
    expect(resolvePermissions(null)).toEqual([]);
  });

  it("VIEWER is read-only (no mutating permissions)", () => {
    const p = resolvePermissions("VIEWER");
    expect(p).not.toContain("deleteDeals");
    expect(p).not.toContain("createDeals");
    expect(p).not.toContain("manageMembers");
  });
});
