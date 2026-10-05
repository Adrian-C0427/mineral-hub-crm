import { Navigate, useSearchParams } from "react-router-dom";
import { OrgSettings } from "../components/OrgSettings";
import { SettingsLayout } from "../components/SettingsNav";

type Tab = "org" | "users" | "roles" | "owner";

/** Organization management page (Team Members, Roles & Permissions, Owner controls). */
export function Organization() {
  const [params] = useSearchParams();
  const raw = params.get("tab");
  // Portal settings moved to Settings → Buyer Portal; keep old links working.
  if (raw === "portal") return <Navigate to="/settings/portal" replace />;
  const tab = (raw as Tab) || "org";
  return (
    <SettingsLayout>
      <OrgSettings initialTab={tab} />
    </SettingsLayout>
  );
}
