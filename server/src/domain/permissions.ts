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
  "viewDeals", "createDeals", "editDeals", "deleteDeals", "sendEmail",
  // Buyers
  "viewBuyers", "createBuyers", "editBuyers", "deleteBuyers",
  // Contacts (acquisitions: sellers, prospects, inbound leads)
  "viewContacts", "manageContacts",
  // Buyer Portal
  "publishOfferings", "managePortal",
  // Documents (deal file attachments)
  "viewDocuments", "manageDocuments",
  // Research
  "viewResearch", "manageResearchData",
  // Well Analysis
  "viewWellAnalysis", "manageWellAnalysis",
  // Maps
  "viewMap",
  // Reports
  "viewReports",
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

  viewBuyers: { label: "View buyers", group: "Buyers" },
  createBuyers: { label: "Create buyers", group: "Buyers" },
  editBuyers: { label: "Edit buyers", group: "Buyers" },
  deleteBuyers: { label: "Delete buyers", group: "Buyers" },

  viewContacts: { label: "View contacts", group: "Contacts" },
  manageContacts: { label: "Create, edit & delete contacts", group: "Contacts" },

  publishOfferings: { label: "Publish offerings to the portal", group: "Buyer Portal" },
  managePortal: { label: "Manage portal settings & contacts", group: "Buyer Portal" },

  viewDocuments: { label: "View & download documents", group: "Documents" },
  manageDocuments: { label: "Upload, edit & delete documents", group: "Documents" },

  viewResearch: { label: "View research & market intel", group: "Research" },
  manageResearchData: { label: "Import & manage research data", group: "Research" },

  viewWellAnalysis: { label: "View well analysis", group: "Well Analysis" },
  manageWellAnalysis: { label: "Run & save well analyses", group: "Well Analysis" },

  viewMap: { label: "View the interactive map", group: "Maps" },

  viewReports: { label: "View reports", group: "Reports" },

  manageExpenses: { label: "Manage expenses", group: "Expenses" },
  approveExpenses: { label: "Approve expenses", group: "Expenses" },

  useAiFeatures: { label: "Use AI features", group: "AI Tools" },

  manageMembers: { label: "Manage team members", group: "Administration" },
  inviteRemoveUsers: { label: "Invite or remove users", group: "Administration" },
  manageOrgSettings: { label: "Manage organization settings & branding", group: "Administration" },
  manageApiIntegrations: { label: "Manage integrations", group: "Administration" },
};

/** Module group render order for the matrix (groups not listed fall to the end). */
export const PERMISSION_GROUP_ORDER = [
  "Deals", "Buyers", "Contacts", "Buyer Portal", "Documents", "Research", "Well Analysis",
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
    "viewContacts", "manageContacts",
    "publishOfferings", "viewDocuments", "manageDocuments",
    "viewResearch", "viewWellAnalysis", "manageWellAnalysis",
    "viewMap", "viewReports", "manageExpenses", "useAiFeatures",
  ],
  MEMBER: [
    "viewDeals", "createDeals", "editDeals", "sendEmail",
    "viewBuyers", "createBuyers", "editBuyers",
    "viewContacts", "manageContacts",
    "publishOfferings", "viewDocuments", "manageDocuments",
    "viewResearch", "viewWellAnalysis", "manageWellAnalysis",
    "viewMap", "viewReports", "manageExpenses", "useAiFeatures",
  ],
  // Read-only: viewing across modules, no mutations, no AI spend.
  VIEWER: ["viewDeals", "viewBuyers", "viewContacts", "viewDocuments", "viewResearch", "viewWellAnalysis", "viewMap", "viewReports"],
};

/**
 * Sentinel appended to a stored override to record that the row was written by
 * the CURRENT permission matrix, and must therefore be taken at face value.
 *
 * Why this exists: PERMISSION_MIGRATIONS below is applied on every READ, so a
 * permission implied by a split key could never be turned off — unchecking
 * `manageDocuments` while `editDeals` stayed checked appeared to save, then
 * came back on the next read, because `editDeals` re-expanded to include it.
 * The matrix silently ignored the revocation.
 *
 * The two cases genuinely need different handling and are indistinguishable
 * from the key list alone: a PRE-split row means "this org never had a say
 * about the finer keys, so preserve their prior access", while a POST-split row
 * means "an owner ticked exactly these boxes, so honour the empty ones too".
 * This marker is what tells them apart. Rows written before it exists have no
 * marker and keep migrating; any subsequent save through the matrix stamps one,
 * so overrides heal themselves on first edit.
 *
 * It is not a valid Permission, so it never survives into a resolved set.
 */
export const OVERRIDE_LITERAL_MARKER = "__matrix_v2";

/**
 * INVARIANTS — holding the key on the left always implies the keys on the
 * right, for defaults and for stored overrides of either vintage.
 *
 * Distinct from the migrations below: those are one-time historical fixups that
 * an owner is allowed to override, whereas these are incoherent to violate. A
 * role that can replace or delete a document must be able to open it, so
 * `viewDocuments` is not independently revocable while `manageDocuments` is
 * held — that is correct, not the bug described above.
 */
const PERMISSION_IMPLICATIONS: Partial<Record<Permission, Permission[]>> = {
  manageDocuments: ["viewDocuments"],
};

function applyImplications(out: Set<Permission>): void {
  for (const [key, implied] of Object.entries(PERMISSION_IMPLICATIONS) as [Permission, Permission[]][]) {
    if (out.has(key)) for (const p of implied) out.add(p);
  }
}

/**
 * Migration map for LEGACY stored overrides — custom role configs saved before
 * a permission was split or renamed. Old keys expand to the current key(s) they
 * now correspond to, so a custom role never silently loses access.
 *
 * Applied ONLY to rows without OVERRIDE_LITERAL_MARKER. Obsolete keys (mapping
 * to []) are dropped either way, since `isPermission` rejects them too.
 */
const PERMISSION_MIGRATIONS: Record<string, Permission[]> = {
  // Removed permissions (no current equivalent).
  editMapData: [],
  accessAdminSettings: [],
  // 2026-07 audit: seller tax/entity IDs are no longer stored or displayed
  // anywhere, and the only export (PDF) was removed app-wide.
  viewSellerTaxId: [],
  exportReports: [],
  // Managing roles is now owner-only; it is no longer grantable to any role.
  manageRoles: [],
  // Split permissions: preserve prior effective access. Before the audit these
  // coarse gates implied the finer ones now broken out.
  viewDeals: ["viewDeals", "useAiFeatures"], // AI features were gated by viewDeals
  editDeals: ["editDeals", "publishOfferings", "manageDocuments", "viewDocuments"], // publish + docs were under editDeals
  // Document download used to have NO permission gate at all — any
  // authenticated org member could fetch any file in their org. `viewDocuments`
  // closes that; every built-in role (VIEWER included) holds it by default, so
  // nothing changes for orgs on the defaults, and a legacy override that could
  // already read documents keeps doing so via the expansions here. (The
  // manageDocuments ⇒ viewDocuments direction is an invariant and lives in
  // PERMISSION_IMPLICATIONS instead.)
  viewResearch: ["viewResearch", "viewWellAnalysis"], // well analysis viewing was under viewResearch
  manageResearchData: ["manageResearchData", "manageWellAnalysis"], // analysis runs were under manageResearchData
  manageOrgSettings: ["manageOrgSettings", "managePortal"], // portal admin was under org settings
};

const isPermission = (p: string): p is Permission => (PERMISSIONS as readonly string[]).includes(p);

/**
 * Merge defaults with an optional stored override for a role. OWNER short-
 * circuits to all permissions. Unknown keys are ignored, invariants
 * (PERMISSION_IMPLICATIONS) always hold, and LEGACY overrides — those without
 * OVERRIDE_LITERAL_MARKER — additionally get the split-permission expansions in
 * PERMISSION_MIGRATIONS so they never silently lose prior access.
 *
 * A marked override is taken literally: an absent key means the owner
 * deliberately unticked that box, and it stays off.
 */
export function resolvePermissions(role: OrgRole | null | undefined, override?: string[] | null): Permission[] {
  if (role === "OWNER") return ALL;
  if (!role) return [];
  // A stored override row (even an empty one) is authoritative for that role.
  if (override) {
    const literal = override.includes(OVERRIDE_LITERAL_MARKER);
    const out = new Set<Permission>();
    for (const key of override) {
      if (key === OVERRIDE_LITERAL_MARKER) continue;
      const migrated = literal ? undefined : PERMISSION_MIGRATIONS[key];
      if (migrated) { for (const m of migrated) out.add(m); }
      else if (isPermission(key)) out.add(key);
    }
    applyImplications(out);
    return [...out];
  }
  const defaults = new Set(DEFAULT_ROLE_PERMISSIONS[role] ?? DEFAULT_ROLE_PERMISSIONS.MEMBER);
  applyImplications(defaults);
  return [...defaults];
}

export function isOwnerRole(role: OrgRole | null | undefined): boolean {
  return role === "OWNER";
}

/** A retired role that still exists on some users and needs owner reassignment. */
export function isLegacyRole(role: OrgRole | null | undefined): boolean {
  return role != null && LEGACY_ROLES.includes(role);
}
