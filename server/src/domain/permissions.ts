/**
 * RBAC permission model.
 *
 * Authorization is driven by a user's OrgRole plus optional per-organization
 * overrides (RolePermissions rows). OWNER implicitly has EVERY permission and
 * is the only role allowed to perform "owner-only" actions (ownership transfer,
 * org deletion, billing, granting admin/owner, security/auth config) — those
 * are NOT part of the assignable permission matrix.
 *
 * Designed to grow: add a key to PERMISSIONS (and to the relevant role
 * defaults) and it flows through resolvePermissions + requirePermission with no
 * architectural change.
 */

export type OrgRole = "OWNER" | "ADMIN" | "MANAGER" | "MEMBER" | "VIEWER";

/** Canonical, assignable permissions. Keys are stable identifiers. */
export const PERMISSIONS = [
  "viewDeals", "createDeals", "editDeals", "deleteDeals",
  "viewBuyers", "createBuyers", "editBuyers", "deleteBuyers",
  "viewReports", "exportReports",
  "manageExpenses", "approveExpenses",
  "viewMap", "editMapData",
  "manageMembers", "manageRoles", "manageOrgSettings",
  "inviteRemoveUsers", "manageApiIntegrations", "accessAdminSettings",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Human-friendly labels + grouping for the permission-matrix UI. */
export const PERMISSION_META: Record<Permission, { label: string; group: string }> = {
  viewDeals: { label: "View Deals", group: "Deals" },
  createDeals: { label: "Create Deals", group: "Deals" },
  editDeals: { label: "Edit Deals", group: "Deals" },
  deleteDeals: { label: "Delete Deals", group: "Deals" },
  viewBuyers: { label: "View Buyers", group: "Buyers" },
  createBuyers: { label: "Create Buyers", group: "Buyers" },
  editBuyers: { label: "Edit Buyers", group: "Buyers" },
  deleteBuyers: { label: "Delete Buyers", group: "Buyers" },
  viewReports: { label: "View Reports", group: "Reports" },
  exportReports: { label: "Export Reports", group: "Reports" },
  manageExpenses: { label: "Manage Expenses", group: "Expenses" },
  approveExpenses: { label: "Approve Expenses", group: "Expenses" },
  viewMap: { label: "View the Interactive Map", group: "Map" },
  editMapData: { label: "Edit Map Data", group: "Map" },
  manageMembers: { label: "Manage Team Members", group: "Administration" },
  manageRoles: { label: "Manage Roles & Permissions", group: "Administration" },
  manageOrgSettings: { label: "Manage Organization Settings", group: "Administration" },
  inviteRemoveUsers: { label: "Invite or Remove Users", group: "Administration" },
  manageApiIntegrations: { label: "Manage API Integrations", group: "Administration" },
  accessAdminSettings: { label: "Access Administrative Settings", group: "Administration" },
};

/**
 * Owner-only actions. Not assignable via the matrix; enforced by orgRole
 * === OWNER. Listed here so the UI can render them as locked/owner-only.
 */
export const OWNER_ONLY_ACTIONS = [
  "transferOwnership",
  "deleteOrganization",
  "manageBilling",
  "designateAdministrators",
  "grantOwnerPrivileges",
  "manageSecurity",
  "configureAuthentication",
] as const;

export const ASSIGNABLE_ROLES: OrgRole[] = ["ADMIN", "MANAGER", "MEMBER", "VIEWER"];
export const ALL_ROLES: OrgRole[] = ["OWNER", "ADMIN", "MANAGER", "MEMBER", "VIEWER"];

const ALL: Permission[] = [...PERMISSIONS];

/** Default permission set per role (OWNER always has everything implicitly). */
export const DEFAULT_ROLE_PERMISSIONS: Record<OrgRole, Permission[]> = {
  OWNER: ALL,
  // Everything except the owner-only actions above.
  ADMIN: ALL,
  MANAGER: [
    "viewDeals", "createDeals", "editDeals",
    "viewBuyers", "createBuyers", "editBuyers",
    "viewReports", "exportReports",
    "manageExpenses", "approveExpenses",
    "viewMap", "editMapData",
    "manageMembers",
  ],
  MEMBER: [
    "viewDeals", "createDeals", "editDeals",
    "viewBuyers", "createBuyers", "editBuyers",
    "viewReports",
    "manageExpenses",
    "viewMap",
  ],
  VIEWER: ["viewDeals", "viewBuyers", "viewReports", "viewMap"],
};

/**
 * Merge defaults with an optional stored override for a role. OWNER short-
 * circuits to all permissions. Unknown keys in overrides are ignored.
 */
export function resolvePermissions(role: OrgRole | null | undefined, override?: string[] | null): Permission[] {
  if (role === "OWNER") return ALL;
  if (!role) return [];
  // A stored override row (even an empty one) is authoritative for that role.
  if (override) {
    return override.filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p));
  }
  return DEFAULT_ROLE_PERMISSIONS[role] ?? [];
}

export function isOwnerRole(role: OrgRole | null | undefined): boolean {
  return role === "OWNER";
}
