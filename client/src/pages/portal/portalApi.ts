// Public portal fetch helpers — no auth token, no session. Uses the same
// VITE_API_BASE the app client uses so dev proxy and Railway both work.
import { API_BASE } from "../../api/client";

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
export type PortalSectionKey = "contact" | "company" | "description" | "documents" | "map" | "wells" | "tracts" | "production" | "attachments" | "notes" | "askPrice";
export interface PortalDeal {
  slug: string | null; name: string; summary: string | null; featured: boolean;
  sections?: Record<PortalSectionKey, boolean>;
  counties: string[]; states: string[]; abstractIds: string[]; basins: string[];
  formations: string[]; assetTypes: string[]; surveys: string[];
  nra: number | null; acreageNma: number | null; operator: string | null;
  wells: string[]; producingStatus: string | null;
  askPrice: number | null; notes: string | null; listedAt: string;
}
export interface PortalAbstract { id: string; abstract: string | null; survey: string | null; county: string }
export interface PortalDocument { id: string; filename: string; mimeType: string; sizeBytes: number; folder: string }
export type FC = { type: "FeatureCollection"; features: { type: "Feature"; id?: string | number; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[] };

export async function portalGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/api/portal${path}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function portalPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/api/portal${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}
