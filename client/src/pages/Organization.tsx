import { useSearchParams } from "react-router-dom";
import { OrgSettings } from "../components/OrgSettings";

type Tab = "org" | "users" | "roles" | "owner" | "portal";

/** Organization management page (Team Members, Roles & Permissions, Owner controls). */
export function Organization() {
  const [params] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "org";
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-header"><h1>Organization</h1></div>
      <OrgSettings initialTab={tab} />
    </div>
  );
}
