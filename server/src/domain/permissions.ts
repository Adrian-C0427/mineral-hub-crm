/**
 * RBAC permission model.
 *
 * Authorization is driven by a user's OrgRole plus optional per-organization
 * overrides (RolePermissions rows). OWNER implicitly holds EVERY permission and
 * is the only role allowed to perform "owner-only" actions (ownership transfer,
 * org deletion, billing, granting admin/owner, security/auth config, and — as of
 * this audit — managing roles & permissions). Those are NOT part of the
 * assignable matrix.
 *
 * The catalog is organized by application module and exposes only the granular
 * actions that are actually enforced somewhere (a requirePermission gate or a
 * client `can()` control). Adding a feature = add a key here, wire a gate, and
 * give it sensible role defaults.
 *
 * Manager role: the MANAGER value still exists in the Postgres OrgRole enum (it
 * cannot be dropped without a destructive migration), but it is fully retired at
 * the application level — not assignable, not shown, and any user still on it is
 * treated as a Standard User for access and flagged for the owner to reassign.
 */

export type OrgRole = "OWNER" | "ADMIN" | "MANAGER" | "MEMBER" | "VIEWER";

/**
 * Canonical, assignable permissions, listed in module order so the matrix UI
 * renders groups top-to-bottom in this sequence. Keys are stable identifiers.
 */
export const PERMISSIONS = [
  // Deals (also covers Pipeline, Closed/Archived deals, and Mineral Assets,
  // which are all Deal records).
  "viewDeals", "createDeals", "editDeals", "deleteDeals", "sendEmail", "viewSellerTaxId",
  // Buyers
  "viewBuyers", "createBuyers", "editBuyers", "deleteBuyers",
  // Buyer Portal
  "publishOfferings", "managePortal",
  // Documents (deal file attachments)
  "manageDocuments",
  // Research
  "viewResearch", "manageResearchData",
  // Well Analysis
  "viewWellAnalysis", "manageWellAnalysis",
  // Maps
  "viewMap",
  // Reports
  "viewReports", "exportReports",
  // Expenses
  "manageExpenses", "approveExpenses",
  // AI Tools
  "useAiFeatures",
  // Administration
  "manageMembers", "inviteRemoveUsers", "manageOrgSettings", "manageApiIntegrations",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Human-friendly labels + module grouping for the permission-matrix UI. */
export const PERMISSION_META: Record<Permission, { label: string; group: string }> = {
  viewDeals: { label: "View deals", group: "Deals" },
  createDeals: { label: "Create deals", group: "Deals" },
  editDeals: { label: "Edit deals", group: "Deals" },
  deleteDeals: { label: "Delete deals", group: "Deals" },
  sendEmail: { label: "Send deal emails", group: "Deals" },
  viewSellerTaxId: { label: "View seller tax / entity IDs", group: "Deals" },

  viewBuyers: { label: "View buyers", group: "Buyers" },
  createBuyers: { label: "Create buyers", group: "Buyers" },
  editBuyers: { label: "Edit buyers", group: "Buyers" },
  deleteBuyers: { label: "Delete buyers", group: "Buyers" },

  publishOfferings: { label: "Publish offerings to the portal", group: "Buyer Portal" },
  managePortal: { label: "Manage portal settings & contacts", group: "Buyer Portal" },

  manageDocuments: { label: "Upload, edit & delete documents", group: "Documents" },

  viewResearch: { label: "View research & market intel", group: "Research" },
  manageResearchData: { label: "Import & manage research data", group: "Research" },

  viewWellAnalysis: { label: "View well analysis", group: "Well Analysis" },
  manageWellAnalysis: { label: "Run & save well analyses", group: "Well Analysis" },

  viewMap: { label: "View the interactive map", group: "Maps" },

  viewReports: { label: "View reports", group: "Reports" },
  exportReports: { label: "Export reports", group: "Reports" },

  manageExpenses: { label: "Manage expenses", group: "Expenses" },
  approveExpenses: { label: "Approve expenses", group: "Expenses" },

  useAiFeatures: { label: "Use AI features", group: "AI Tools" },

  manageMembers: { label: "Manage team members", group: "Administration" },
  inviteRemoveUsers: { label: "Invite or remove users", group: "Administration" },
  manageOrgSettings: { label: "Manage organization settings & branding", group: "Administration" },
  manageApiIntegrations: { label: "Manage API integrations", group: "Administration" },
};

/** Module group render order for the matrix (groups not listed fall to the end). */
export const PERMISSION_GROUP_ORDER = [
  "Deals", "Buyers", "Buyer Portal", "Documents", "Research", "Well Analysis",
  "Maps", "Reports", "Expenses", "AI Tools", "Administration",
] as const;

/**
 * Owner-only actions. Not assignable via the matrix; enforced by orgRole
 * === OWNER. Listed here so the UI can render them as reserved/owner-only.
 * `manageRolesPermissions` moved here in the RBAC audit — editing roles &
 * permissions is now exclusively the owner's.
 */
export const OWNER_ONLY_ACTIONS = [
  "manageRolesPermissions",
  "transferOwnership",
  "deleteOrganization",
  "manageBilling",
  "designateAdministrators",
  "grantOwnerPrivileges",
  "manageSecurity",
  "configureAuthentication",
] as const;

// MANAGER is intentionally excluded — retired at the app level (see file header).
export const ASSIGNABLE_ROLES: OrgRole[] = ["ADMIN", "MEMBER", "VIEWER"];
export const ALL_ROLES: OrgRole[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];
/** Roles that exist in old data but are no longer assignable. */
export const LEGACY_ROLES: OrgRole[] = ["MANAGER"];

const ALL: Permission[] = [...PERMISSIONS];

/** Default permission set per role (OWNER always has everything implicitly). */
export const DEFAULT_ROLE_PERMISSIONS: Record<OrgRole, Permission[]> = {
  OWNER: ALL,
  // Everything except the owner-only actions above.
  ADMIN: ALL,
  // Legacy: retired role, retained only so un-migrated MANAGER users keep a
  // sensible (Standard-User-equivalent) access level until an owner reassigns
  // them. Kept in sync with MEMBER below.
  MANAGER: [
    "viewDeals", "createDeals", "editDeals", "sendEmail",
    "viewBuyers", "createBuyers", "editBuyers",
    "publishOfferings", "manageDocuments",
    "viewResearch", "viewWellAnalysis",
    "viewMap", "viewReports", "manageExpenses", "useAiFeatures",
  ],
  MEMBER: [
    "viewDeals", "createDeals", "editDeals", "sendEmail",
    "viewBuyers", "createBuyers", "editBuyers",
    "publishOfferings", "manageDocuments",
    "viewResearch", "viewWellAnalysis",
    "viewMap", "viewReports", "manageExpenses", "useAiFeatures",
  ],
  // Read-only: viewing across modules, no mutations, no AI spend.
  VIEWER: ["viewDeals", "viewBuyers", "viewResearch", "viewWellAnalysis", "viewMap", "viewReports"],
};

/**
 * Migration map for STORED overrides (custom role configs saved before this
 * audit). Old keys expand to the current key(s) they now correspond to, so a
 * custom role never silently loses access when a permission is split or renamed.
 * Keys absent here pass through unchanged; keys mapping to [] are dropped.
 */
const PERMISSION_MIGRATIONS: Record<string, Permission[]> = {
  // Removed permissions (no current equivalent).
  editMapData: [],
  accessAdminSettings: [],
  // Managing roles is now owner-only; it is no longer grantable to any role.
  manageRoles: [],
  // Split permissions: preserve prior effective access. Before the audit these
  // coarse gates implied the finer ones now broken out.
  viewDeals: ["viewDeals", "useAiFeatures"], // AI features were gated by viewDeals
  editDeals: ["editDeals", "publishOfferings", "manageDocuments"], // publish + docs were under editDeals
  viewResearch: ["viewResearch", "viewWellAnalysis"], // well analysis viewing was under viewResearch
  manageResearchData: ["manageResearchData", "manageWellAnalysis"], // analysis runs were under manageResearchData
  manageOrgSettings: ["manageOrgSettings", "managePortal"], // portal admin was under org settings
};

const isPermission = (p: string): p is Permission => (PERMISSIONS as readonly string[]).includes(p);

/**
 * Merge defaults with an optional stored override for a role. OWNER short-
 * circuits to all permissions. Stored overrides are migrated forward (old keys
 * expanded/dropped per PERMISSION_MIGRATIONS) and unknown keys ignored.
 */
export function resolvePermissions(role: OrgRole | null | undefined, override?: string[] | null): Permission[] {
  if (role === "OWNER") return ALL;
  if (!role) return [];
  // A stored override row (even an empty one) is authoritative for that role.
  if (override) {
    const out = new Set<Permission>();
    for (const key of override) {
      const migrated = PERMISSION_MIGRATIONS[key];
      if (migrated) { for (const m of migrated) out.add(m); }
      else if (isPermission(key)) out.add(key);
    }
    return [...out];
  }
  return DEFAULT_ROLE_PERMISSIONS[role] ?? DEFAULT_ROLE_PERMISSIONS.MEMBER;
}

export function isOwnerRole(role: OrgRole | null | undefined): boolean {
  return role === "OWNER";
}

/** A retired role that still exists on some users and needs owner reassignment. */
export function isLegacyRole(role: OrgRole | null | undefined): boolean {
  return role != null && LEGACY_ROLES.includes(role);
}
