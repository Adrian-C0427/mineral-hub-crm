import { Navigate, useSearchParams } from "react-router-dom";
import { OrgSettings } from "../components/OrgSettings";
import { SettingsNav } from "../components/SettingsNav";

type Tab = "org" | "users" | "roles" | "owner";

/** Organization management page (Team Members, Roles & Permissions, Owner controls). */
export function Organization() {
  const [params] = useSearchParams();
  const raw = params.get("tab");
  // Portal settings moved to Settings → Buyer Portal; keep old links working.
  if (raw === "portal") return <Navigate to="/settings/portal" replace />;
  const tab = (raw as Tab) || "org";
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-header"><h1>Settings</h1></div>
      <SettingsNav />
      <OrgSettings initialTab={tab} />
    </div>
  );
}
