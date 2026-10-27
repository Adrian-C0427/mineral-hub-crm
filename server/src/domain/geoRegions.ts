/**
 * Basins, sub-basins, plays and formations for Texas — the pure parts.
 *
 * Two bundles ship with the server (server/data/gis):
 *
 *  - tx-geo-regions.json.gz — polygons. Primary basins are the EPA GHGRP /
 *    AAPG geologic-province tessellation (every point of Texas lies in exactly
 *    one), Permian sub-basins are EIA's 2017 outlines, Marfa is EIA's 2024
 *    basin outline, and plays are EIA's Dec-2021 shale-play outlines dissolved
 *    with the USGS assessment units per formation. EIA's 2024 basins are kept
 *    as a REFERENCE layer: an independent second opinion that raises or lowers
 *    confidence but is never shown as a tag by itself. The bundle also carries
 *    county-level overlap shares (computed offline against the app's county
 *    polygons) so county-only records get an answer without PostGIS.
 *
 *  - tx-formations.json.gz — RRC's field/reservoir file (65,827 field-
 *    reservoir records) reduced to a reservoir-name → formation dictionary plus
 *    per-county formation counts. Field names end in "(RESERVOIR)"; the
 *    dictionary normalizes depth/bench suffixes ("WILCOX 9200" → Wilcox).
 *
 * Abstract-level shares (gis.abstract_regions) are computed in PostGIS at boot
 * (services/geoRegions.ts) and combined here with county shares, the RRC wells
 * on the abstracts and the county field list into one answer with an explicit
 * basis and confidence for every tag — nothing is ever invented: an abstract on
 * a generalized basin line is reported as an edge, a county-only record as
 * county-level, a formation seen only in the county's field list as such.
 */
import crypto from "node:crypto";

export const GEO_REGIONS_DATASET = { key: "tx-geo-regions", file: "tx-geo-regions.json.gz" } as const;
export const FORMATIONS_DATASET = { key: "tx-formations", file: "tx-formations.json.gz" } as const;

export type RegionKind = "basin" | "subbasin" | "play" | "reference";
export interface RegionSource { id: string; code: string; label: string }
export interface GeoRegion {
  id: string;
  name: string;
  kind: RegionKind;
  parent: string | null;
  /** Plays only: the formation the play produces from. */
  formation: string | null;
  sources: RegionSource[];
  note?: string;
  geom: { type: "MultiPolygon"; coordinates: number[][][][] };
}
export interface CountyRegionShare { fips: string; regionId: string; share: number }
export interface GeoRegionsDataset {
  key: string;
  version: string;
  builtAt: string;
  sources: { id: string; name: string; asOf: string; license: string }[];
  uncovered: { basins: string[]; note: string };
  regions: GeoRegion[];
  countyRegions: CountyRegionShare[];
  /** Texas counties, 5-digit FIPS ("48289") → name. */
  counties: { fips: string; name: string }[];
}

export interface FormationsDataset {
  key: string;
  version: string;
  builtAt: string;
  source: { name: string; asOf: string };
  records: number;
  withToken: number;
  mapped: number;
  /** Raw RRC reservoir token (upper case, as written in the field name) → formation. */
  tokens: Record<string, string>;
  formations: { name: string; records: number }[];
  /** County (3-digit Texas FIPS) × formation → number of RRC field-reservoirs. */
  countyFormations: { fips: string; formation: string; fieldReservoirs: number }[];
}

export function contentVersion(raw: Buffer | string): string {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

const KINDS: readonly RegionKind[] = ["basin", "subbasin", "play", "reference"];
const isRing = (r: unknown): boolean =>
  Array.isArray(r) && r.length >= 4 && r.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v)));

/** Parse + validate the regions bundle; throws on anything malformed so a bad file never half-serves. */
export function parseGeoRegions(json: Buffer | string, version = contentVersion(json)): GeoRegionsDataset {
  const ds = JSON.parse(typeof json === "string" ? json : json.toString("utf8")) as GeoRegionsDataset;
  if (ds.key !== GEO_REGIONS_DATASET.key) throw new Error(`geo regions: unexpected key ${String(ds.key)}`);
  if (!Array.isArray(ds.regions) || !ds.regions.length) throw new Error("geo regions: no regions");
  if (!Array.isArray(ds.countyRegions) || !Array.isArray(ds.counties) || !ds.counties.length) throw new Error("geo regions: no county data");
  const ids = new Set<string>();
  for (const r of ds.regions) {
    if (!r.id || ids.has(r.id)) throw new Error(`geo regions: bad/duplicate id ${String(r.id)}`);
    ids.add(r.id);
    if (!r.name || !KINDS.includes(r.kind)) throw new Error(`geo regions: ${r.id} has a bad name/kind`);
    if (r.kind === "play" && !r.formation) throw new Error(`geo regions: play ${r.id} names no formation`);
    if (!Array.isArray(r.sources) || !r.sources.length) throw new Error(`geo regions: ${r.id} has no source`);
    if (r.geom?.type !== "MultiPolygon" || !Array.isArray(r.geom.coordinates) || !r.geom.coordinates.length
      || !r.geom.coordinates.every((poly) => Array.isArray(poly) && poly.length >= 1 && poly.every(isRing))) {
      throw new Error(`geo regions: ${r.id} has bad geometry`);
    }
  }
  for (const r of ds.regions) if (r.parent && !ids.has(r.parent)) throw new Error(`geo regions: ${r.id} has an unknown parent`);
  for (const c of ds.countyRegions) {
    if (!/^\d{5}$/.test(c.fips) || !ids.has(c.regionId) || !(c.share > 0 && c.share <= 1)) throw new Error(`geo regions: bad county share for ${c.fips}/${c.regionId}`);
  }
  for (const c of ds.counties) if (!/^\d{5}$/.test(c.fips) || !c.name) throw new Error("geo regions: bad county entry");
  return { ...ds, version };
}

/** Parse + validate the formations bundle. */
export function parseFormations(json: Buffer | string, version = contentVersion(json)): FormationsDataset {
  const ds = JSON.parse(typeof json === "string" ? json : json.toString("utf8")) as FormationsDataset;
  if (ds.key !== FORMATIONS_DATASET.key) throw new Error(`formations: unexpected key ${String(ds.key)}`);
  if (!ds.tokens || typeof ds.tokens !== "object" || !Object.keys(ds.tokens).length) throw new Error("formations: no dictionary");
  if (!Array.isArray(ds.formations) || !ds.formations.length) throw new Error("formations: no formation list");
  if (!Array.isArray(ds.countyFormations)) throw new Error("formations: no county list");
  for (const c of ds.countyFormations) {
    if (!/^\d{3}$/.test(c.fips) || !c.formation || !(c.fieldReservoirs > 0)) throw new Error(`formations: bad county row ${JSON.stringify(c)}`);
  }
  return { ...ds, version };
}

// ---------------------------------------------------------------------------
// RRC field names → formation
// ---------------------------------------------------------------------------

/** The reservoir token of an RRC field name: its LAST parenthetical, closed or
 *  cut off by the 32-character field ("NORTH LEON (COTTON VALLEY)" → "COTTON VALLEY"). */
export function reservoirToken(fieldName: string | null | undefined): string | null {
  const s = (fieldName ?? "").trim();
  if (!s) return null;
  const matches = [...s.matchAll(/\(([^()]*)(?:\)|$)/g)];
  const t = matches.length ? matches[matches.length - 1][1].trim().toUpperCase() : "";
  return t || null;
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

/** Formation for an RRC reservoir token or a stored well formation value, via
 *  the dictionary; unknown values fall back to a title-cased copy of the raw
 *  text once depth/bench suffixes are stripped (never null for real text). */
export function formationFor(raw: string | null | undefined, tokens: Record<string, string>): string | null {
  const t = (raw ?? "").trim().toUpperCase();
  if (!t) return null;
  const hit = tokens[t];
  if (hit) return hit;
  const stripped = t.replace(/[\s,]+(?:\d{1,6}(?:-[A-Z0-9]+)?|[A-Z]-?\d+|[A-Z])$/g, "").trim();
  if (stripped !== t && tokens[stripped]) return tokens[stripped];
  if (/^[\d\s,-]*$/.test(stripped) || stripped.length < 3) return null;
  return titleCase(stripped);
}

// ---------------------------------------------------------------------------
// Composing one answer
// ---------------------------------------------------------------------------

export type Confidence = "high" | "medium" | "low";
export type Basis = "abstract" | "county";

export interface BasinTag {
  id: string;
  name: string;
  kind: "basin" | "subbasin";
  parent: string | null;
  basis: Basis;
  /** Area share of the record's footprint (abstracts) or county inside the region, 0–1. */
  share: number;
  confidence: Confidence;
  /** The footprint straddles the drawn (generalized) boundary. */
  edge: boolean;
  note?: string;
  sources: string[];
}
export interface PlayTag { id: string; name: string; formation: string; basin: string | null; basis: Basis; share: number; confidence: Confidence; sources: string[] }
export interface FormationTag {
  name: string;
  /** wells: RRC wells on the record's abstracts produce from it; play: a mapped play covers the footprint; fields: RRC field-reservoirs in the county. */
  basis: "wells" | "play" | "fields";
  confidence: Confidence;
  /** Wells (basis wells) or county field-reservoirs (basis fields). */
  count: number;
}
export interface GeoContext {
  basins: BasinTag[];
  subBasins: BasinTag[];
  plays: PlayTag[];
  formations: FormationTag[];
  coverage: {
    abstractsRequested: number;
    /** Abstracts with computed shares (GIS abstracts whose county has been processed). */
    abstractsResolved: number;
    /** GIS abstracts whose county has not been processed yet (first boot in progress). */
    abstractsPending: number;
    /** Counties the record names that the bundle has no shares for (not Texas, or unknown). */
    countiesUnknown: string[];
    basis: Basis | "none";
  };
  notes: string[];
}

export interface AbstractShareRow { abstractId: string; regionId: string; share: number }
export interface WellEvidenceRow { abstractId: string; fieldName: string | null; formations: string[] | null }

export interface ComposeInput {
  regions: GeoRegionsDataset;
  formations: FormationsDataset;
  /** The record's GIS abstract ids, as requested. */
  abstractIds: string[];
  /** Abstract shares from gis.abstract_regions for those ids (empty when none processed / no GIS). */
  abstractShares: AbstractShareRow[];
  /** Requested ids that exist in gis.abstracts but whose county is not processed yet. */
  pendingAbstractIds: string[];
  /** Texas county names on the record (and of the abstracts, when known). */
  counties: string[];
  /** RRC wells on the abstracts. */
  wells: WellEvidenceRow[];
}

const THRESH = { inside: 0.9, majority: 0.5, mention: 0.1, playIn: 0.5, playEdge: 0.1 } as const;

/** Abstract-level share per region, averaged over the resolved abstracts
 *  (an abstract with no row for a region contributes 0 for it). */
function meanShares(rows: AbstractShareRow[]): { byRegion: Map<string, number>; abstracts: number } {
  const abstracts = new Set(rows.map((r) => r.abstractId)).size;
  const sum = new Map<string, number>();
  for (const r of rows) sum.set(r.regionId, (sum.get(r.regionId) ?? 0) + r.share);
  const byRegion = new Map<string, number>();
  for (const [id, s] of sum) byRegion.set(id, Math.min(1, s / Math.max(1, abstracts)));
  return { byRegion, abstracts };
}

function countyFips(ds: GeoRegionsDataset, names: string[]): { fips: string[]; unknown: string[] } {
  const byName = new Map(ds.counties.map((c) => [c.name.toLowerCase(), c.fips]));
  const fips: string[] = []; const unknown: string[] = [];
  for (const n of names) {
    const k = n.trim().replace(/\s+county$/i, "").toLowerCase();
    const f = byName.get(k);
    if (f) { if (!fips.includes(f)) fips.push(f); } else if (n.trim()) unknown.push(n.trim());
  }
  return { fips, unknown };
}

/** County-level share per region: the mean over the named counties. */
function countyShares(ds: GeoRegionsDataset, fips: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!fips.length) return out;
  for (const c of ds.countyRegions) if (fips.includes(c.fips)) out.set(c.regionId, (out.get(c.regionId) ?? 0) + c.share / fips.length);
  return out;
}

export function composeGeoContext(input: ComposeInput): GeoContext {
  const { regions: ds, formations: fds } = input;
  const byId = new Map(ds.regions.map((r) => [r.id, r]));
  const notes: string[] = [];
  const { fips, unknown } = countyFips(ds, input.counties);

  const abs = meanShares(input.abstractShares);
  const basis: Basis | "none" = abs.abstracts > 0 ? "abstract" : fips.length ? "county" : "none";
  const shares = basis === "abstract" ? abs.byRegion : countyShares(ds, fips);
  const srcNames = (r: GeoRegion) => [...new Set(r.sources.map((s) => s.id))];

  // Reference (EIA 2024) basin names present where the record is: agreement
  // lifts a majority basin to high confidence, disagreement caps it at medium.
  const referenceNames = new Set<string>();
  for (const [id, share] of shares) {
    const r = byId.get(id);
    if (r?.kind === "reference" && share >= THRESH.majority) referenceNames.add(r.name);
  }
  const referenceExistsFor = new Set(ds.regions.filter((r) => r.kind === "reference").map((r) => r.name));

  const basinTag = (r: GeoRegion, share: number): BasinTag => {
    let confidence: Confidence;
    let note: string | undefined;
    const edge = share < THRESH.inside;
    if (basis === "abstract") {
      confidence = share >= THRESH.inside ? "high" : share >= THRESH.majority ? "medium" : "low";
      if (r.kind === "basin" && referenceExistsFor.has(r.name)) {
        if (referenceNames.has(r.name)) { /* two sources agree */ }
        else if (referenceNames.size) { confidence = confidence === "high" ? "medium" : confidence; note = `EIA's basin outline places this footprint in ${[...referenceNames].join(" / ")}.`; }
      }
      if (edge && !note) note = "The footprint straddles the drawn basin boundary (regional lines are generalized).";
    } else {
      // County-level: a county lying wholly in one basin is a sound medium; anything less is a hint.
      confidence = share >= THRESH.inside ? "medium" : "low";
      note = share >= THRESH.inside ? "From the county outline — no abstract footprint to check." : `${Math.round(share * 100)}% of the county area; the record's abstract decides.`;
    }
    return { id: r.id, name: r.name, kind: r.kind as "basin" | "subbasin", parent: r.parent, basis: basis === "none" ? "county" : basis, share: round3(share), confidence, edge, ...(note ? { note } : {}), sources: srcNames(r) };
  };

  const basins: BasinTag[] = []; const subBasins: BasinTag[] = []; const plays: PlayTag[] = [];
  for (const [id, share] of shares) {
    const r = byId.get(id);
    if (!r || share < THRESH.mention) continue;
    if (r.kind === "basin") basins.push(basinTag(r, share));
    else if (r.kind === "subbasin") subBasins.push(basinTag(r, share));
    else if (r.kind === "play" && share >= THRESH.playEdge) {
      const parent = r.parent ? byId.get(r.parent)?.name ?? null : null;
      plays.push({
        id: r.id, name: r.name, formation: r.formation!, basin: parent, basis: basis === "none" ? "county" : basis, share: round3(share),
        // Play outlines are hand-drawn regional extents: never more than medium on their own.
        confidence: share >= THRESH.playIn ? (basis === "abstract" ? "medium" : "low") : "low",
        sources: srcNames(r),
      });
    }
  }
  const byShare = <T extends { share: number }>(a: T, b: T) => b.share - a.share;
  basins.sort(byShare); subBasins.sort(byShare); plays.sort(byShare);

  // Formations: wells on the abstracts (high) → plays covering the footprint
  // (medium) → the county's RRC field list (low, with the field-reservoir count).
  const formations = new Map<string, FormationTag>();
  const wellCounts = new Map<string, number>();
  for (const w of input.wells) {
    const names = new Set<string>();
    const fromField = formationFor(reservoirToken(w.fieldName), fds.tokens);
    if (fromField) names.add(fromField);
    for (const f of w.formations ?? []) { const n = formationFor(f, fds.tokens); if (n) names.add(n); }
    for (const n of names) wellCounts.set(n, (wellCounts.get(n) ?? 0) + 1);
  }
  for (const [name, count] of wellCounts) formations.set(name, { name, basis: "wells", confidence: "high", count });
  for (const p of plays) {
    if (p.share < THRESH.playIn || formations.has(p.formation)) continue;
    formations.set(p.formation, { name: p.formation, basis: "play", confidence: basis === "abstract" ? "medium" : "low", count: 0 });
  }
  if (fips.length) {
    const fips3 = fips.map((f) => f.slice(2));
    const counts = new Map<string, number>();
    for (const c of fds.countyFormations) if (fips3.includes(c.fips)) counts.set(c.formation, (counts.get(c.formation) ?? 0) + c.fieldReservoirs);
    for (const [name, count] of counts) if (!formations.has(name)) formations.set(name, { name, basis: "fields", confidence: "low", count });
  }
  const rank: Record<FormationTag["basis"], number> = { wells: 0, play: 1, fields: 2 };
  const formationList = [...formations.values()].sort((a, b) => rank[a.basis] - rank[b.basis] || b.count - a.count || a.name.localeCompare(b.name));

  if (basis === "none") notes.push("No abstract or Texas county on the record — nothing to place.");
  if (input.pendingAbstractIds.length) notes.push(`${input.pendingAbstractIds.length} abstract${input.pendingAbstractIds.length === 1 ? "" : "s"} not yet indexed against the basin outlines (the index builds after a deploy); county-level shares shown meanwhile.`);
  if (unknown.length) notes.push(`No basin outlines for ${unknown.join(", ")} (outside Texas or not a county name).`);

  return {
    basins, subBasins, plays, formations: formationList,
    coverage: {
      abstractsRequested: input.abstractIds.length,
      abstractsResolved: abs.abstracts,
      abstractsPending: input.pendingAbstractIds.length,
      countiesUnknown: unknown,
      basis,
    },
    notes,
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The tags a record should carry when nothing was entered by hand — the rule
 * the forms' auto-fill and the boot backfill share. Basins: the majority basin
 * when it is at least medium confidence, plus any sub-basin the footprint lies
 * mostly inside. Formations: those with well evidence on the footprint, else
 * the plays covering it (abstract-level only). The county field list is never
 * auto-applied — it is a menu, not a fact about the tract.
 */
export function suggestedTags(ctx: GeoContext): { basins: string[]; formations: string[] } {
  const basins: string[] = [];
  const top = ctx.basins[0];
  if (top && top.confidence !== "low") basins.push(top.name);
  for (const s of ctx.subBasins) if (s.share >= THRESH.majority && s.confidence !== "low" && !basins.includes(s.name)) basins.push(s.name);
  const wells = ctx.formations.filter((f) => f.basis === "wells").map((f) => f.name);
  const plays = ctx.formations.filter((f) => f.basis === "play" && f.confidence === "medium").map((f) => f.name);
  return { basins, formations: wells.length ? wells : plays };
}

/** GeoJSON for the map overlay: one MultiPolygon feature per region of the wanted kinds. */
export function regionsGeoJSON(ds: GeoRegionsDataset, kinds: readonly RegionKind[]): GeoJSON.FeatureCollection {
  const byId = new Map(ds.regions.map((r) => [r.id, r]));
  return {
    type: "FeatureCollection",
    features: ds.regions.filter((r) => kinds.includes(r.kind)).map((r, i) => ({
      type: "Feature",
      id: i + 1,
      properties: {
        id: r.id, name: r.name, kind: r.kind, parent: r.parent, parentName: r.parent ? byId.get(r.parent)?.name ?? null : null,
        formation: r.formation, sources: r.sources.map((s) => s.label).join("; "), colorIndex: i % 12,
      },
      geometry: r.geom,
    })),
  };
}

/** The catalog the client's pickers and filters draw from. */
export function geoCatalog(ds: GeoRegionsDataset, fds: FormationsDataset, minFormationRecords = 20) {
  const byId = new Map(ds.regions.map((r) => [r.id, r]));
  const name = (id: string | null) => (id ? byId.get(id)?.name ?? null : null);
  return {
    version: `${ds.version}:${fds.version}`,
    builtAt: ds.builtAt,
    basins: ds.regions.filter((r) => r.kind === "basin").map((r) => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name)),
    subBasins: ds.regions.filter((r) => r.kind === "subbasin").map((r) => ({ id: r.id, name: r.name, parent: name(r.parent) })).sort((a, b) => a.name.localeCompare(b.name)),
    plays: ds.regions.filter((r) => r.kind === "play").map((r) => ({ id: r.id, name: r.name, formation: r.formation, basin: name(r.parent) })).sort((a, b) => a.name.localeCompare(b.name)),
    /** Formations with a real footprint in RRC's field list (≥ minFormationRecords field-reservoirs) plus every play formation. */
    formations: [...new Set([
      ...fds.formations.filter((f) => f.records >= minFormationRecords).map((f) => f.name),
      ...ds.regions.filter((r) => r.kind === "play" && r.formation).map((r) => r.formation!),
    ])].sort((a, b) => a.localeCompare(b)),
    uncovered: ds.uncovered,
    sources: ds.sources,
    formationSource: fds.source,
  };
}
