import { describe, it, expect } from "vitest";
import {
  resolvePermissions, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_META,
  ASSIGNABLE_ROLES, ALL_ROLES, OWNER_ONLY_ACTIONS, OVERRIDE_LITERAL_MARKER, isLegacyRole,
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

  it("every role that can see a deal can read its documents by default", () => {
    // Document download had NO permission gate before the 2026-07-28 audit, so
    // adding `viewDocuments` must not take access away from anyone on the
    // built-in roles — only from a role an org explicitly customized.
    for (const role of ["ADMIN", "MANAGER", "MEMBER", "VIEWER"] as const) {
      expect(resolvePermissions(role)).toContain("viewDocuments");
    }
    expect(resolvePermissions("OWNER")).toContain("viewDocuments");
  });
});

describe("permission migration (preserve access on stored overrides)", () => {
  it("expands split permissions so prior access is preserved", () => {
    // viewDeals implied AI access before the audit.
    expect(resolvePermissions("MEMBER", ["viewDeals"])).toEqual(expect.arrayContaining(["viewDeals", "useAiFeatures"]));
    // editDeals implied publishing + document management (and so, reading).
    expect(resolvePermissions("MEMBER", ["editDeals"])).toEqual(expect.arrayContaining(["editDeals", "publishOfferings", "manageDocuments", "viewDocuments"]));
    // Managing documents implies reading them — an invariant, not a fixup.
    expect(resolvePermissions("MEMBER", ["manageDocuments"])).toEqual(expect.arrayContaining(["manageDocuments", "viewDocuments"]));
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

describe("matrix-authored overrides are taken literally", () => {
  const marked = (...keys: string[]) => [...keys, OVERRIDE_LITERAL_MARKER];

  it("honours a revocation the legacy expansion used to silently undo", () => {
    // THE BUG: the migration map is applied on every read, so `editDeals`
    // re-expanded to include publishOfferings/manageDocuments no matter what
    // the owner had unticked. Saving the matrix now stamps the row, and a
    // stamped row means exactly what it says.
    const legacy = resolvePermissions("MEMBER", ["editDeals"]);
    expect(legacy).toEqual(expect.arrayContaining(["publishOfferings", "manageDocuments"]));

    const revoked = resolvePermissions("MEMBER", marked("editDeals"));
    expect(revoked).toEqual(["editDeals"]);
    expect(revoked).not.toContain("publishOfferings");
    expect(revoked).not.toContain("manageDocuments");
  });

  it("lets viewDocuments be turned off once manageDocuments is also off", () => {
    expect(resolvePermissions("MEMBER", marked("viewDeals"))).not.toContain("viewDocuments");
  });

  it("still enforces invariants — managing documents implies reading them", () => {
    // Not the bug: unticking `viewDocuments` while keeping `manageDocuments` is
    // incoherent, so the invariant reasserts itself for marked rows too.
    expect(resolvePermissions("MEMBER", marked("manageDocuments"))).toEqual(
      expect.arrayContaining(["manageDocuments", "viewDocuments"]),
    );
  });

  it("does not re-add AI spend to a marked viewDeals-only role", () => {
    expect(resolvePermissions("MEMBER", marked("viewDeals"))).toEqual(["viewDeals"]);
  });

  it("never leaks the marker into a resolved permission set", () => {
    for (const p of resolvePermissions("MEMBER", marked("viewDeals", "viewBuyers"))) {
      expect(p).not.toBe(OVERRIDE_LITERAL_MARKER);
    }
  });

  it("treats an empty marked override as a genuine no-permissions role", () => {
    expect(resolvePermissions("MEMBER", marked())).toEqual([]);
  });

  it("leaves unmarked (pre-existing) rows migrating as before", () => {
    expect(resolvePermissions("MEMBER", ["viewResearch"]))
      .toEqual(expect.arrayContaining(["viewResearch", "viewWellAnalysis"]));
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
