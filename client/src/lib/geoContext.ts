import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { TEXAS_BASIN_OPTIONS, TEXAS_FORMATION_OPTIONS } from "./options";

/**
 * Basins / plays / formations for a record — the client side of
 * GET /api/geo/* (server/src/domain/geoRegions.ts). The answer carries a basis
 * (the record's abstract footprint, or its county) and a confidence for every
 * tag; `suggested` is what a form fills in when the user has entered nothing.
 */

export type GeoConfidence = "high" | "medium" | "low";
export interface GeoBasinTag { id: string; name: string; kind: "basin" | "subbasin"; parent: string | null; basis: "abstract" | "county"; share: number; confidence: GeoConfidence; edge: boolean; note?: string; sources: string[] }
export interface GeoPlayTag { id: string; name: string; formation: string; basin: string | null; basis: "abstract" | "county"; share: number; confidence: GeoConfidence; sources: string[] }
export interface GeoFormationTag { name: string; basis: "wells" | "play" | "fields"; confidence: GeoConfidence; count: number }
export interface GeoContext {
  basins: GeoBasinTag[];
  subBasins: GeoBasinTag[];
  plays: GeoPlayTag[];
  formations: GeoFormationTag[];
  coverage: { abstractsRequested: number; abstractsResolved: number; abstractsPending: number; countiesUnknown: string[]; basis: "abstract" | "county" | "none" };
  notes: string[];
  suggested: { basins: string[]; formations: string[] };
}
export interface GeoCatalog {
  version: string;
  builtAt: string;
  basins: { id: string; name: string }[];
  subBasins: { id: string; name: string; parent: string | null }[];
  plays: { id: string; name: string; formation: string | null; basin: string | null }[];
  formations: string[];
  uncovered: { basins: string[]; note: string };
  sources: { id: string; name: string; asOf: string; license: string }[];
}

// The catalog is static reference data: one request per page load, shared.
let catalogPromise: Promise<GeoCatalog | null> | null = null;
export function loadGeoCatalog(): Promise<GeoCatalog | null> {
  catalogPromise ??= api.get<GeoCatalog>("/geo/catalog").catch(() => null);
  return catalogPromise;
}
/** Tests only. */
export function resetGeoCatalog(): void { catalogPromise = null; }

export function useGeoCatalog(): GeoCatalog | null {
  const [cat, setCat] = useState<GeoCatalog | null>(null);
  useEffect(() => { let on = true; void loadGeoCatalog().then((c) => { if (on) setCat(c); }); return () => { on = false; }; }, []);
  return cat;
}

/** Basin options: the suggested ones first (by share), then the catalog's basins and sub-basins, the uncovered ones, then the legacy list — de-duplicated. */
export function basinOptions(cat: GeoCatalog | null, ctx: GeoContext | null): string[] {
  return dedupe([
    ...(ctx ? [...ctx.basins, ...ctx.subBasins].sort((a, b) => b.share - a.share).map((b) => b.name) : []),
    ...(cat ? [...cat.basins.map((b) => b.name), ...cat.subBasins.map((b) => b.name), ...cat.uncovered.basins] : []),
    ...TEXAS_BASIN_OPTIONS,
  ]);
}
/** Formation options: the record's evidence first (wells → plays → county field list), then the catalog, then the legacy list. */
export function formationOptions(cat: GeoCatalog | null, ctx: GeoContext | null): string[] {
  return dedupe([
    ...(ctx ? ctx.formations.map((f) => f.name) : []),
    ...(cat ? cat.formations : []),
    ...TEXAS_FORMATION_OPTIONS,
  ]);
}
function dedupe(xs: string[]): string[] { const seen = new Set<string>(); return xs.filter((x) => x && !seen.has(x) && (seen.add(x), true)); }

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * The geo context for a record's geography, debounced. Texas only: another
 * state (or nothing selected) yields null. `pending` is true while a request
 * is in flight for the current inputs.
 */
export function useGeoContext(abstractIds: readonly string[], counties: readonly string[], states: readonly string[]): { ctx: GeoContext | null; pending: boolean } {
  const texas = states.length === 0 || states.includes("TX");
  const key = texas && (abstractIds.length || counties.length) ? JSON.stringify([abstractIds, counties]) : "";
  const [state, setState] = useState<{ key: string; ctx: GeoContext | null }>({ key: "", ctx: null });
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (!key) { setState({ key, ctx: null }); return; }
    const t = setTimeout(() => {
      const qs = new URLSearchParams();
      if (abstractIds.length) qs.set("abstractIds", abstractIds.join(","));
      if (counties.length) qs.set("counties", counties.join(","));
      qs.set("state", "TX");
      api.get<GeoContext>(`/geo/context?${qs.toString()}`)
        .then((ctx) => { if (seq.current === mine) setState({ key, ctx }); })
        .catch(() => { if (seq.current === mine) setState({ key, ctx: null }); });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { ctx: state.key === key ? state.ctx : null, pending: !!key && state.key !== key };
}

/**
 * Keep a tag list in step with the suggestions while the user has not touched
 * it: the list is replaced when it is empty or still equal to what was last
 * auto-filled; anything the user picked or edited is left alone. Returns the
 * values that were auto-filled last (so the UI can say so).
 */
export function useAutoFill(enabled: boolean, suggested: readonly string[] | undefined, value: readonly string[], onChange: (v: string[]) => void): boolean {
  const last = useRef<string[]>([]);
  const sug = useMemo(() => suggested ?? [], [suggested?.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled || !suggested) return;
    if (sameSet(sug, value)) { last.current = [...sug]; return; }
    if (value.length === 0 || sameSet(value, last.current)) { last.current = [...sug]; onChange([...sug]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sug]);
  return value.length > 0 && sameSet(value, last.current);
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
const CONF: Record<GeoConfidence, string> = { high: "high confidence", medium: "medium confidence", low: "low confidence" };

/** One-line explanation of the basin answer, for the hint under the Basin field. */
export function basinHint(ctx: GeoContext | null): string | null {
  if (!ctx) return null;
  const b = ctx.basins[0];
  if (!b) return ctx.coverage.basis === "none" ? null : "No basin outline covers this geography.";
  const basis = b.basis === "abstract" ? `the abstract footprint${ctx.coverage.abstractsResolved > 1 ? ` (${ctx.coverage.abstractsResolved} abstracts)` : ""}` : "the county outline";
  if (b.confidence === "low") {
    const split = ctx.basins.filter((x) => x.share >= 0.1).map((x) => `${x.name} ${pct(x.share)}`).join(" · ");
    return `Split by ${basis}: ${split} — pick the one that applies.`;
  }
  const sub = ctx.subBasins.filter((s) => s.share >= 0.5).map((s) => s.name);
  const parts = [`${b.name}${sub.length ? ` (${sub.join(", ")})` : ""} — ${CONF[b.confidence]} from ${basis}`];
  if (b.edge) parts.push(`${pct(b.share)} inside; the footprint straddles the drawn boundary`);
  // The server's county-level note only restates the basis; its abstract-level notes add something (EIA disagreeing).
  if (b.note && !b.edge && b.basis === "abstract") parts.push(b.note.replace(/\.$/, ""));
  if (ctx.coverage.abstractsPending) parts.push(`${ctx.coverage.abstractsPending} abstract${ctx.coverage.abstractsPending === 1 ? "" : "s"} not indexed yet`);
  return `${parts.join(" · ")}.`;
}

/** One-line explanation of the formation evidence, for the hint under the Formation field. */
export function formationHint(ctx: GeoContext | null, county?: string): string | null {
  if (!ctx) return null;
  const wells = ctx.formations.filter((f) => f.basis === "wells");
  if (wells.length) return `Wells on this footprint produce from ${wells.slice(0, 5).map((f) => `${f.name} (${f.count})`).join(", ")}${wells.length > 5 ? "…" : ""}.`;
  const plays = ctx.plays.filter((p) => p.share >= 0.5);
  const fields = ctx.formations.filter((f) => f.basis === "fields");
  const parts: string[] = [];
  if (plays.length) parts.push(`Plays here: ${plays.map((p) => p.formation).join(", ")}`);
  if (fields.length) parts.push(`${county ? `${county} County` : "County"} field list: ${fields.slice(0, 4).map((f) => `${f.name} (${f.count})`).join(", ")}${fields.length > 4 ? ` +${fields.length - 4} more` : ""}`);
  return parts.length ? `${parts.join(" · ")}.` : null;
}
