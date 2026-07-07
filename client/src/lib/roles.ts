/**
 * Display names for org roles — one copy (Sidebar and OrgSettings each had
 * their own, and they'd already drifted on the retired Manager role).
 */
export const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Administrator",
  MANAGER: "Manager (legacy)",
  MEMBER: "Standard User",
  VIEWER: "Read-Only Viewer",
};
