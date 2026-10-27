/**
 * Boot-time, additive backfill of Basin / Formation tags on deals and
 * opportunities that have none, from the same answer the forms use
 * (services/geoRegions.ts geoContext → domain/geoRegions.ts suggestedTags):
 * the majority basin when it is at least medium confidence (plus sub-basins
 * the footprint lies in), and formations with well evidence on the footprint,
 * else the plays covering it. County field lists are never applied. Records
 * that already carry a basin keep it untouched; a record whose formations are
 * empty gets formations even when its basins were set by hand, and vice versa.
 *
 * Runs after the basin regions and abstract shares are in place (index.ts),
 * org by org; idempotent — a second boot finds nothing empty that it can fill.
 */
import { prisma } from "../db.js";
import { suggestedTags, type GeoContext } from "../domain/geoRegions.js";
import { isAbstractId, normalizeAbstractId } from "../domain/opportunities.js";
import { geoContext, geoRegionsDataset } from "./geoRegions.js";

export interface GeoTagRecord { basins: string[]; formations: string[]; states: string[]; state: string | null; counties: string[]; abstractIds: string[] }

/** Whether a record is worth asking about: Texas (or no state) with a county or an abstract, and a blank tag list. */
export function geoTagCandidate(r: GeoTagRecord): boolean {
  const states = r.states.length ? r.states : r.state ? [r.state] : [];
  if (states.length && !states.some((s) => s.toUpperCase() === "TX")) return false;
  if (!r.counties.length && !r.abstractIds.length) return false;
  return r.basins.length === 0 || r.formations.length === 0;
}

/** The update to write, or null when the answer adds nothing to the record's blank lists. */
export function geoTagUpdate(r: Pick<GeoTagRecord, "basins" | "formations">, ctx: GeoContext): { basins?: string[]; formations?: string[] } | null {
  const s = suggestedTags(ctx);
  const out: { basins?: string[]; formations?: string[] } = {};
  if (r.basins.length === 0 && s.basins.length) out.basins = s.basins;
  if (r.formations.length === 0 && s.formations.length) out.formations = s.formations;
  return Object.keys(out).length ? out : null;
}

export interface GeoBackfillResult { dealsChecked: number; dealsTagged: number; oppsChecked: number; oppsTagged: number }

export async function backfillGeoTags(log: (m: string) => void = (m) => console.log(m)): Promise<GeoBackfillResult | null> {
  if (!geoRegionsDataset()) return null;
  const out: GeoBackfillResult = { dealsChecked: 0, dealsTagged: 0, oppsChecked: 0, oppsTagged: 0 };
  const deals = await prisma.deal.findMany({
    where: { OR: [{ basins: { isEmpty: true } }, { formations: { isEmpty: true } }] },
    select: { id: true, basins: true, formations: true, states: true, state: true, counties: true, abstractIds: true },
  });
  for (const d of deals) {
    if (!geoTagCandidate(d)) continue;
    out.dealsChecked++;
    const ctx = await geoContext({ abstractIds: d.abstractIds, counties: d.counties, state: "TX" });
    const data = ctx && geoTagUpdate(d, ctx);
    if (!data) continue;
    await prisma.deal.update({ where: { id: d.id }, data });
    out.dealsTagged++;
  }
  const opps = await prisma.opportunity.findMany({
    where: { convertedDealId: null, OR: [{ basins: { isEmpty: true } }, { formations: { isEmpty: true } }] },
    select: { id: true, basins: true, formations: true, state: true, county: true, abstract: true },
  });
  for (const o of opps) {
    const r: GeoTagRecord = {
      basins: o.basins, formations: o.formations, states: [], state: o.state, counties: o.county ? [o.county] : [],
      abstractIds: o.abstract && isAbstractId(o.abstract) ? [normalizeAbstractId(o.abstract)] : [],
    };
    if (!geoTagCandidate(r)) continue;
    out.oppsChecked++;
    const ctx = await geoContext({ abstractIds: r.abstractIds, counties: r.counties, state: "TX" });
    const data = ctx && geoTagUpdate(r, ctx);
    if (!data) continue;
    await prisma.opportunity.update({ where: { id: o.id }, data });
    out.oppsTagged++;
  }
  log(`[geo] basin/formation backfill: ${out.dealsTagged}/${out.dealsChecked} deals and ${out.oppsTagged}/${out.oppsChecked} opportunities tagged`);
  return out;
}
