// Public portal fetch helpers. Uses the same VITE_API_BASE the app client uses
// so dev proxy and Railway both work. Buyers have no session; a signed-in CRM
// user's token rides along only so the API can recognise a DEMO session — the
// demo workspace's portal answers demo sessions alone (server routes/portal.ts).
import { API_BASE, getAuthToken } from "../../api/client";

export interface PortalContact {
  id: string; name: string; title: string | null; email: string | null;
  phone: string | null; department: string | null; photo: string | null; isPrimary: boolean;
}
export interface PortalOrg {
  name: string; slug: string | null; fullLogo: string | null; compactLogo: string | null;
  contacts: PortalContact[];
  // Legacy single-contact mirror of the primary contact (kept for back-compat).
  contactName: string | null; contactEmail: string | null; contactPhone: string | null; officeLocation: string | null;
}
export interface PortalDeal {
  slug: string | null; name: string; summary: string | null; featured: boolean;
  counties: string[]; states: string[]; abstractIds: string[]; basins: string[];
  formations: string[]; assetTypes: string[]; surveys: string[];
  nra: number | null; acreageNma: number | null; operator: string | null; rrc: string | null;
  wells: string[]; producingStatus: string | null;
  askPrice: number | null; listedAt: string;
  // >0 when this listing is a seller package published as a single bundle.
  assetCount?: number;
}
/** Buyer-safe summary of one asset inside a published package bundle. */
export interface PortalPackageAsset {
  id: string; name: string; counties: string[]; states: string[];
  nra: number | null; assetTypes: string[]; operator: string | null;
}
export interface PortalAbstract { id: string; abstract: string | null; survey: string | null; county: string; state?: string }
export interface PortalDocument { id: string; filename: string; mimeType: string; sizeBytes: number; folder: string }
export interface PortalImage { id: string; filename: string; url: string }
export interface PortalProduction {
  wellsMatched: number; months: number; firstMonth: string | null; lastMonth: string;
  cumOilBbl: number; cumGasMcf: number; cumBoe: number; last12OilBbl: number; last12GasMcf: number;
}
export type FC = { type: "FeatureCollection"; features: { type: "Feature"; id?: string | number; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[] };

// Anonymous per-browser visitor id for listing analytics (views / unique
// visitors / downloads). Random, stored locally, carries no personal data.
export function visitorId(): string {
  try {
    const KEY = "mh-portal-visitor";
    let v = localStorage.getItem(KEY);
    if (!v || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) {
      v = (crypto.randomUUID?.() ?? `${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
      localStorage.setItem(KEY, v);
    }
    return v;
  } catch { return "anon-no-storage"; }
}

/** Headers for every portal request: the visitor id, plus the session token when there is one. */
export function portalHeaders(base?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(base ?? {}), "x-mh-visitor": visitorId() };
  const t = getAuthToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

export async function portalGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/api/portal${path}`, { headers: portalHeaders() });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function portalPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/api/portal${path}`, {
    method: "POST", headers: portalHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}
