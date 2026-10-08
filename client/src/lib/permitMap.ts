// "Show these drilling permits on the map" deep links.
//
// A Research permit metric (KPI, buying signal, geography / operator count)
// links to /map?show=permits&<its filters>. The map hands those filters back to
// /api/research/permit-locations, which recounts the SAME permit set the metric
// counted and places each permit on its well — so the URL carries filters, never
// ids, and survives reload/back.

/** Research query keys that scope permits (doc-only keys are dropped). */
const PERMIT_KEYS = ["from", "to", "state", "county", "abstractId", "survey", "operator", "trajectory", "permitStatus"] as const;
type PermitKey = (typeof PERMIT_KEYS)[number];
export type PermitMapPatch = Partial<Record<PermitKey, string[]>>;

/**
 * Map URL for the permits behind a metric: the Research page's current query
 * string, narrowed by `patch` (each key replaces that filter, e.g. one county
 * for a geography row), plus a human `label` for the map's highlight bar.
 */
export function permitsMapHref(researchQs: string, label: string, patch: PermitMapPatch = {}): string {
  const src = new URLSearchParams(researchQs);
  const out = new URLSearchParams();
  out.set("show", "permits");
  for (const k of PERMIT_KEYS) {
    const vals = patch[k] ?? src.getAll(k);
    for (const v of vals) if (v) out.append(k, v);
  }
  out.set("label", label);
  return `/map?${out.toString()}`;
}

export interface PermitMapRequest {
  /** Query string for /research/permit-locations. */
  apiQs: string;
  label: string;
  counties: string[];
}

/** Parse a map URL's permit-highlight request (null when there is none). */
export function readPermitsMapParams(search: URLSearchParams): PermitMapRequest | null {
  if (search.get("show") !== "permits") return null;
  const q = new URLSearchParams();
  for (const k of PERMIT_KEYS) for (const v of search.getAll(k)) if (v) q.append(k, v);
  return { apiQs: q.toString(), label: search.get("label") || "Drilling permits", counties: search.getAll("county") };
}

/** Strip the permit-highlight params, keeping anything else on the map URL. */
export function withoutPermitParams(search: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const k of ["show", "label", ...PERMIT_KEYS]) next.delete(k);
  return next;
}
