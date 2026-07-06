import { describe, it, expect } from "vitest";
import {
  resolvePermissions, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_META,
  ASSIGNABLE_ROLES, ALL_ROLES, OWNER_ONLY_ACTIONS, isLegacyRole,
} from "./permissions.js";

describe("resolvePermissions", () => {
  it("gives OWNER every permission", () => {
    expect(resolvePermissions("OWNER").sort()).toEqual([...PERMISSIONS].sort());
  });

  it("falls back to role defaults with no override", () => {
    expect(resolvePermissions("VIEWER")).toEqual(DEFAULT_ROLE_PERMISSIONS.VIEWER);
    expect(resolvePermissions("MEMBER")).toEqual(DEFAULT_ROLE_PERMISSIONS.MEMBER);
  });

  it("uses a stored override (even empty) as authoritative", () => {
    expect(resolvePermissions("MEMBER", ["viewBuyers"])).toEqual(["viewBuyers"]);
    expect(resolvePermissions("MEMBER", [])).toEqual([]);
  });

  it("ignores unknown keys in an override", () => {
    expect(resolvePermissions("MEMBER", ["viewBuyers", "bogusKey"])).toEqual(["viewBuyers"]);
  });

  it("returns nothing for a null role", () => {
    expect(resolvePermissions(null)).toEqual([]);
  });

  it("VIEWER is read-only (no mutating or AI-spend permissions)", () => {
    const p = resolvePermissions("VIEWER");
    for (const k of ["deleteDeals", "createDeals", "editDeals", "manageMembers", "manageDocuments", "useAiFeatures", "publishOfferings"]) {
      expect(p).not.toContain(k);
    }
  });
});

describe("permission migration (preserve access on stored overrides)", () => {
  it("expands split permissions so prior access is preserved", () => {
    // viewDeals implied AI access before the audit.
    expect(resolvePermissions("MEMBER", ["viewDeals"])).toEqual(expect.arrayContaining(["viewDeals", "useAiFeatures"]));
    // editDeals implied publishing + document management.
    expect(resolvePermissions("MEMBER", ["editDeals"])).toEqual(expect.arrayContaining(["editDeals", "publishOfferings", "manageDocuments"]));
    // research view implied well-analysis view.
    expect(resolvePermissions("MEMBER", ["viewResearch"])).toEqual(expect.arrayContaining(["viewResearch", "viewWellAnalysis"]));
    // portal admin was under org settings.
    expect(resolvePermissions("MEMBER", ["manageOrgSettings"])).toEqual(expect.arrayContaining(["manageOrgSettings", "managePortal"]));
  });

  it("drops obsolete/owner-only keys from stored overrides", () => {
    const p = resolvePermissions("MEMBER", ["editMapData", "accessAdminSettings", "manageRoles", "viewBuyers"]);
    expect(p).toEqual(["viewBuyers"]);
  });
});

describe("Manager role retirement", () => {
  it("is not assignable and not in the matrix role set", () => {
    expect(ASSIGNABLE_ROLES).not.toContain("MANAGER");
    expect(ALL_ROLES).not.toContain("MANAGER");
  });
  it("is flagged as a legacy role", () => {
    expect(isLegacyRole("MANAGER")).toBe(true);
    expect(isLegacyRole("MEMBER")).toBe(false);
  });
  it("still resolves to a sensible access level for un-migrated users", () => {
    // Equivalent to a Standard User so legacy Managers are neither locked out
    // nor over-privileged while awaiting reassignment.
    expect(resolvePermissions("MANAGER")).toEqual(DEFAULT_ROLE_PERMISSIONS.MEMBER);
  });
});

describe("catalog integrity", () => {
  it("every permission has label + group metadata", () => {
    for (const key of PERMISSIONS) {
      expect(PERMISSION_META[key]).toBeTruthy();
      expect(PERMISSION_META[key].group).toBeTruthy();
    }
  });
  it("obsolete permissions are gone from the catalog", () => {
    for (const gone of ["editMapData", "accessAdminSettings", "manageRoles"]) {
      expect((PERMISSIONS as readonly string[])).not.toContain(gone);
    }
  });
  it("managing roles & permissions is owner-only", () => {
    expect(OWNER_ONLY_ACTIONS).toContain("manageRolesPermissions");
    expect((PERMISSIONS as readonly string[])).not.toContain("manageRolesPermissions");
  });
});
