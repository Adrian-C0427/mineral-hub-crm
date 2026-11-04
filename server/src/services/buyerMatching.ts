/**
 * Buyer matching — the data behind domain/buyerMatch.ts.
 *
 * Loads, once and cached, what the engine needs that is expensive to gather:
 *   - the org's ACQUISITION INDEX: every Research transaction record keyed by
 *     each grantee (one record = one acquisition, however many aliases of a
 *     buyer appear on it), with its abstracts resolved to GIS ids;
 *   - COUNTY ADJACENCY from the GIS county layer (process-wide);
 *   - a deal's GEO CONTEXT: distance from the deal's tract(s) to every abstract
 *     the index references, and which of them share a boundary (PostGIS).
 * CRM history (closed deals, offers, passes, responses) is small and read
 * fresh on every request so a new offer or status shows up at once.
 *
 * Caches expire on their own (TTL) and are dropped explicitly when Research
 * records or buyer aliases change (invalidateBuyerMatchCaches). A deal's geo
 * context is keyed by its abstract set, so editing the deal's location misses
 * the cache naturally. No PostGIS (a fresh local database) degrades to
 * county-level geography — nothing fails.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";
import { BUYER_MATCH_WEIGHTS } from "../config.js";
import { normalizeEntity } from "../domain/research.js";
import { abstractNumber } from "../domain/abstractLabel.js";
import { sideParties } from "../domain/researchGraph.js";
import { royaltyValue } from "../domain/royalty.js";
import { effectiveStatus, ENGAGED_STATUSES } from "../domain/buyerStatus.js";
import {
  MATCH_CONFIG, scoreBuyer,
  type Acquisition, type BuyerMatchResult, type CrmHistory, type GeoContext, type MatchBuyBox, type MatchDeal, type MatchWeights,
} from "../domain/buyerMatch.js";

type Db = PrismaClient | Prisma.TransactionClient;

const INDEX_TTL_MS = 10 * 60_000;
const GIS_TTL_MS = 60 * 60_000;
const GEO_TTL_MS = 10 * 60_000;
const GEO_MAX_KEYS = 200;
/** Candidates farther than this from the deal are not worth a distance. */
const GEO_RADIUS_M = 40 * MATCH_CONFIG.mile;

const countyKey = (state: string | null | undefined, county: string) => `${(state ?? "TX").trim().toUpperCase()}|${county.trim().toLowerCase()}`;

// ---------------------------------------------------------------------------
// Buyer identity
// ---------------------------------------------------------------------------

/** The research entity keys that are this buyer: its company name plus every
 *  confirmed alias, normalized the way grantees are at import. */
export function buyerEntityKeys(companyName: string, aliases: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const raw of [companyName, ...aliases]) {
    const k = normalizeEntity(raw);
    if (k) keys.add(k);
  }
  return [...keys];
}

// ---------------------------------------------------------------------------
// Acquisition index
// ---------------------------------------------------------------------------

export interface AcquisitionIndex {
  /** grantee norm → the records it acquired under (shared objects). */
  byNorm: Map<string, Acquisition[]>;
  /** Every GIS abstract id any record resolves to, by state. */
  abstractIdsByState: Map<string, Set<string>>;
  coveredCounties: Set<string>;
  builtAt: number;
}

let indexVersion = 0;
const indexCache = new Map<string, { at: number; index: Promise<AcquisitionIndex> }>();
const geoCache = new Map<string, { at: number; ctx: Promise<GeoContext> }>();
let fipsCache: { at: number; map: Promise<Map<string, string>> } | null = null;
let adjacencyCache: { at: number; map: Promise<Map<string, Set<string>>> } | null = null;

/** Research records or buyer aliases changed: rebuild on the next request. */
export function invalidateBuyerMatchCaches(): void {
  indexVersion++;
  indexCache.clear();
  geoCache.clear();
}

/** TX county name → 3-digit county FIPS, from the GIS county layer. Empty
 *  when the layer is absent (then records keep county-level geography). */
async function countyFips(db: Db, now = Date.now()): Promise<Map<string, string>> {
  if (fipsCache && now - fipsCache.at < GIS_TTL_MS) return fipsCache.map;
  const map = (async () => {
    try {
      const rows = await db.$queryRawUnsafe<{ fips: string; state: string; name: string }[]>(`SELECT fips, state, name FROM gis.counties`);
      return new Map(rows.filter((r) => r.state === "TX").map((r) => [countyKey(r.state, r.name), r.fips.slice(-3)]));
    } catch {
      return new Map<string, string>();
    }
  })();
  fipsCache = { at: now, map };
  map.then((m) => { if (m.size === 0 && fipsCache?.map === map) fipsCache = null; }).catch(() => { fipsCache = null; });
  return map;
}

/** County key → the county keys it touches (statewide, all GIS states). */
export async function countyAdjacency(db: Db = prisma, now = Date.now()): Promise<Map<string, Set<string>>> {
  if (adjacencyCache && now - adjacencyCache.at < GIS_TTL_MS) return adjacencyCache.map;
  const map = (async () => {
    const out = new Map<string, Set<string>>();
    try {
      const rows = await db.$queryRawUnsafe<{ sa: string; na: string; sb: string; nb: string }[]>(
        `SELECT a.state sa, a.name na, b.state sb, b.name nb FROM gis.counties a JOIN gis.counties b ON a.fips < b.fips AND ST_Touches(a.geom, b.geom)`);
      for (const r of rows) {
        const a = countyKey(r.sa, r.na), b = countyKey(r.sb, r.nb);
        (out.get(a) ?? out.set(a, new Set()).get(a)!).add(b);
        (out.get(b) ?? out.set(b, new Set()).get(b)!).add(a);
      }
    } catch {
      /* no GIS schema: no adjacency */
    }
    return out;
  })();
  adjacencyCache = { at: now, map };
  map.then((m) => { if (m.size === 0 && adjacencyCache?.map === map) adjacencyCache = null; }).catch(() => { adjacencyCache = null; });
  return map;
}

/** GIS abstract id for a Research abstract number in a Texas county. */
export function gisAbstractId(fips: string | undefined, abstractNo: string): string | null {
  const n = abstractNumber(abstractNo);
  if (!fips || !n || !/^\d+$/.test(n)) return null;
  return `TX-${fips}${Number(n)}`;
}

async function buildAcquisitionIndex(db: Db, orgIds: string[]): Promise<AcquisitionIndex> {
  const fips = await countyFips(db);
  const byNorm = new Map<string, Acquisition[]>();
  const abstractIdsByState = new Map<string, Set<string>>();
  const coveredCounties = new Set<string>();
  const seenTx = new Set<string>();
  const BATCH = 2000;
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.researchDocument.findMany({
      where: { organizationId: { in: orgIds }, docClass: "TRANSACTION" },
      select: {
        id: true, state: true, county: true, abstractIds: true, recordingDate: true, docType: true, interestPct: true, acreage: true, instrumentNumber: true,
        grantee: true, granteeNorm: true, granteeParties: true, granteeNorms: true,
      },
      orderBy: { id: "asc" }, take: BATCH, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    for (const d of rows) {
      const ck = countyKey(d.state, d.county);
      coveredCounties.add(ck);
      // The same instrument imported twice (two files, two ids) is one acquisition.
      const txKey = d.instrumentNumber ? `${ck}|${d.instrumentNumber.trim().toUpperCase()}` : null;
      if (txKey) { if (seenTx.has(txKey)) continue; seenTx.add(txKey); }
      const st = (d.state || "TX").toUpperCase();
      const ids = st === "TX" ? d.abstractIds.map((a) => gisAbstractId(fips.get(ck), a)).filter((v): v is string => !!v) : [];
      for (const id of ids) (abstractIdsByState.get(st) ?? abstractIdsByState.set(st, new Set()).get(st)!).add(id);
      const acq: Acquisition = { docId: d.id, date: d.recordingDate, state: st, county: d.county, abstractIds: ids, docType: d.docType, interestPct: d.interestPct, acreage: d.acreage };
      const seenNorm = new Set<string>();
      for (const p of sideParties(d.grantee, d.granteeNorm, d.granteeParties, d.granteeNorms)) {
        if (seenNorm.has(p.norm)) continue;
        seenNorm.add(p.norm);
        (byNorm.get(p.norm) ?? byNorm.set(p.norm, []).get(p.norm)!).push(acq);
      }
    }
    if (rows.length < BATCH) break;
    cursor = rows[rows.length - 1].id;
  }
  return { byNorm, abstractIdsByState, coveredCounties, builtAt: Date.now() };
}

export function acquisitionIndex(orgIds: string[], db: Db = prisma, now = Date.now()): Promise<AcquisitionIndex> {
  const key = `${indexVersion}:${[...new Set(orgIds)].sort().join(",")}`;
  const hit = indexCache.get(key);
  if (hit && now - hit.at < INDEX_TTL_MS) return hit.index;
  const index = buildAcquisitionIndex(db, orgIds);
  index.catch(() => { if (indexCache.get(key)?.index === index) indexCache.delete(key); });
  indexCache.set(key, { at: now, index });
  return index;
}

/** This buyer's acquisitions across all its names, each record once. */
export function acquisitionsFor(index: AcquisitionIndex, keys: readonly string[]): Acquisition[] {
  const seen = new Set<string>();
  const out: Acquisition[] = [];
  for (const k of keys) for (const a of index.byNorm.get(k) ?? []) {
    if (seen.has(a.docId)) continue;
    seen.add(a.docId);
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geo context
// ---------------------------------------------------------------------------

export interface DealGeoRow { state: string | null; counties: string[]; abstractIds: string[] }

async function buildGeoContext(db: Db, deal: DealGeoRow, index: AcquisitionIndex): Promise<GeoContext> {
  const adjacency = await countyAdjacency(db);
  const neighborCounties = new Set<string>();
  for (const c of deal.counties) for (const n of adjacency.get(countyKey(deal.state, c)) ?? []) neighborCounties.add(n);
  const ctx: GeoContext = { dealLocated: false, distanceM: new Map(), adjacent: new Set(), neighborCounties, coveredCounties: index.coveredCounties };
  const dealIds = deal.abstractIds.filter((id) => /^[A-Z]{2}-\S+$/.test(id));
  if (!dealIds.length) return ctx;
  const st = (deal.state ?? dealIds[0].slice(0, 2)).toUpperCase();
  const candidates = [...(index.abstractIdsByState.get(st) ?? [])].filter((id) => !dealIds.includes(id));
  try {
    const [{ located }] = await db.$queryRawUnsafe<{ located: boolean }[]>(`SELECT count(*) > 0 AS located FROM gis.abstracts WHERE id = ANY($1::text[])`, dealIds);
    ctx.dealLocated = located;
    if (!located || !candidates.length) return ctx;
    const rows = await db.$queryRawUnsafe<{ id: string; m: number; adj: boolean }[]>(
      `WITH d AS (SELECT ST_Union(geom) AS g FROM gis.abstracts WHERE id = ANY($1::text[]))
       SELECT a.id, ST_Distance(a.geom::geography, d.g::geography) AS m, ST_Intersects(a.geom, d.g) AS adj
         FROM gis.abstracts a, d
        WHERE a.id = ANY($2::text[]) AND ST_DWithin(a.geom::geography, d.g::geography, $3)`,
      dealIds, candidates, GEO_RADIUS_M);
    for (const r of rows) {
      ctx.distanceM.set(r.id, Number(r.m));
      if (r.adj) ctx.adjacent.add(r.id);
    }
  } catch {
    /* no PostGIS: county-level geography only */
  }
  return ctx;
}

export function geoContextFor(deal: DealGeoRow, index: AcquisitionIndex, db: Db = prisma, now = Date.now()): Promise<GeoContext> {
  const key = `${indexVersion}:${index.builtAt}:${(deal.state ?? "").toUpperCase()}:${[...deal.counties].sort().join(",")}:${[...deal.abstractIds].sort().join(",")}`;
  const hit = geoCache.get(key);
  if (hit && now - hit.at < GEO_TTL_MS) return hit.ctx;
  const ctx = buildGeoContext(db, deal, index);
  ctx.catch(() => { if (geoCache.get(key)?.ctx === ctx) geoCache.delete(key); });
  geoCache.set(key, { at: now, ctx });
  while (geoCache.size > GEO_MAX_KEYS) geoCache.delete(geoCache.keys().next().value!);
  return ctx;
}

// ---------------------------------------------------------------------------
// CRM history
// ---------------------------------------------------------------------------

export interface CrmScope {
  orgId: string;
  buyerIds: string[];
  /** The deal being scored — its own outcome never counts as history. */
  dealId: string | null;
  dealCounties: string[];
  dealState: string | null;
  /** Only events up to this instant (the historical backtest). */
  asOf?: Date | null;
}

const MEANINGFUL_KINDS = ["EMAIL_IN", "PHONE", "MEETING", "NEGOTIATION"] as const;

export async function crmHistories(scope: CrmScope, buyers: { id: string; relationshipStatus: string; lastContactDate: Date | null }[], db: Db = prisma): Promise<Map<string, CrmHistory>> {
  const { orgId, buyerIds, dealId, asOf } = scope;
  const upTo = asOf ?? null;
  const before = (d: Date | null | undefined) => !upTo || (d != null && d.getTime() <= upTo.getTime());
  const dealCounties = new Set(scope.dealCounties.map((c) => countyKey(scope.dealState, c)));
  const notThis = dealId ? { id: { not: dealId } } : {};
  const [deals, offers, activities, messages] = await Promise.all([
    // Portal submissions awaiting review are not offers yet (domain/metrics.ts).
    db.deal.findMany({ where: { organizationId: orgId, ...notThis, OR: [{ selectedBuyerId: { in: buyerIds } }, { offers: { some: { buyerId: { in: buyerIds }, status: { not: "PENDING_REVIEW" } } } }] },
      select: { id: true, stage: true, state: true, counties: true, acreageNma: true, askPrice: true, selectedBuyerId: true, closedDate: true, updatedAt: true } }),
    db.offer.findMany({ where: { buyerId: { in: buyerIds }, status: { not: "PENDING_REVIEW" }, deal: { organizationId: orgId, ...notThis } }, select: { dealId: true, buyerId: true, status: true, amount: true, dateSubmitted: true } }),
    db.dealBuyerActivity.findMany({ where: { buyerId: { in: buyerIds }, deal: { organizationId: orgId, ...notThis } },
      select: { dealId: true, buyerId: true, status: true, responseStatus: true, responseReceived: true, dateSent: true, lastActivityDate: true } }),
    db.dealBuyerMessage.findMany({ where: { buyerId: { in: buyerIds }, kind: { in: [...MEANINGFUL_KINDS] }, deal: { organizationId: orgId, ...notThis } }, select: { buyerId: true, occurredAt: true } }),
  ]);
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const out = new Map<string, CrmHistory>();
  for (const b of buyers) {
    const h: CrmHistory = {
      closedDeals: 0, closedSameCounty: 0, offersMade: 0, offersAccepted: 0, offersRejected: 0, passed: 0, passedSameCounty: 0,
      contacted: 0, responded: 0, engaged: 0, lastMeaningfulAt: null, relationshipStatus: (b.relationshipStatus as CrmHistory["relationshipStatus"]) ?? null, dealSizes: [],
    };
    const touch = (d: Date | null | undefined) => { if (d && before(d) && (!h.lastMeaningfulAt || d > h.lastMeaningfulAt)) h.lastMeaningfulAt = d; };
    const sizes = new Map<string, { nma: number | null; price: number | null }>();
    for (const d of deals) {
      if (d.selectedBuyerId !== b.id || d.stage !== "CLOSED") continue;
      if (!before(d.closedDate ?? d.updatedAt)) continue;
      h.closedDeals++;
      if (d.counties.some((c) => dealCounties.has(countyKey(d.state, c)))) h.closedSameCounty++;
      sizes.set(d.id, { nma: d.acreageNma, price: d.askPrice });
    }
    for (const o of offers) {
      if (o.buyerId !== b.id || !before(o.dateSubmitted)) continue;
      h.offersMade++;
      if (o.status === "ACCEPTED") h.offersAccepted++;
      if (o.status === "REJECTED" || o.status === "EXPIRED" || o.status === "WITHDRAWN") h.offersRejected++;
      touch(o.dateSubmitted);
      const d = dealById.get(o.dealId);
      if (!sizes.has(o.dealId)) sizes.set(o.dealId, { nma: d?.acreageNma ?? null, price: o.amount });
    }
    for (const a of activities) {
      if (a.buyerId !== b.id || !before(a.dateSent ?? a.lastActivityDate)) continue;
      h.contacted++;
      const status = effectiveStatus(a);
      const d = dealById.get(a.dealId);
      const same = d ? d.counties.some((c) => dealCounties.has(countyKey(d.state, c))) : false;
      if (status === "PASSED") { h.passed++; if (same) h.passedSameCounty++; }
      if (a.responseReceived || (status !== "CONTACTED" && status !== "NO_RESPONSE")) h.responded++;
      if ((ENGAGED_STATUSES as string[]).includes(status)) { h.engaged++; touch(a.lastActivityDate); }
    }
    for (const m of messages) if (m.buyerId === b.id) touch(m.occurredAt);
    if (!upTo) touch(b.lastContactDate);
    h.dealSizes = [...sizes.values()];
    out.set(b.id, h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring a deal's buyers
// ---------------------------------------------------------------------------

export interface MatchDealRow extends DealGeoRow {
  id: string | null;
  acreageNma: number | null;
  nra: number | null;
  askPrice: number | null;
  assetTypes: string[];
  operator: string | null;
  leaseStatuses: string[];
  royaltyRate: string | null;
}

export interface MatchBuyerRow {
  id: string;
  companyName: string;
  aliases: string[];
  relationshipStatus: string;
  lastContactDate: Date | null;
  buyBox: Partial<MatchBuyBox> | null;
}

export function toMatchDeal(d: MatchDealRow): MatchDeal {
  return {
    state: d.state, counties: d.counties, abstractIds: d.abstractIds, acreageNma: d.acreageNma, nra: d.nra, askPrice: d.askPrice,
    assetTypes: d.assetTypes, operator: d.operator, leaseStatuses: d.leaseStatuses ?? [], royalty: royaltyValue(d.royaltyRate),
  };
}

export function toMatchBuyBox(b: Partial<MatchBuyBox> | null | undefined): MatchBuyBox | null {
  if (!b) return null;
  return {
    states: b.states ?? [], counties: b.counties ?? [], assetTypes: b.assetTypes ?? [],
    minAcreage: b.minAcreage ?? null, maxAcreage: b.maxAcreage ?? null, minPrice: b.minPrice ?? null, maxPrice: b.maxPrice ?? null,
    minNra: b.minNra ?? null, maxNra: b.maxNra ?? null, maxPricePerNma: b.maxPricePerNma ?? null,
    leaseStatuses: b.leaseStatuses ?? [], operators: b.operators ?? [], minRoyalty: b.minRoyalty ?? null, strictKeys: b.strictKeys ?? [],
  };
}

export interface MatchRunOptions {
  db?: Db;
  orgId: string;
  /** Orgs whose Research records count (the demo reads the reference org's). */
  researchOrgIds: string[];
  deal: MatchDealRow;
  buyers: MatchBuyerRow[];
  now?: Date;
  /** Backtest: score as of this instant — later Research records and CRM events are ignored. */
  asOf?: Date | null;
  weights?: MatchWeights;
}

export async function matchBuyersForDeal(opts: MatchRunOptions): Promise<Map<string, BuyerMatchResult>> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const asOf = opts.asOf ?? null;
  const index = await acquisitionIndex(opts.researchOrgIds, db);
  const geo = await geoContextFor(opts.deal, index, db);
  const crm = await crmHistories({ orgId: opts.orgId, buyerIds: opts.buyers.map((b) => b.id), dealId: opts.deal.id, dealCounties: opts.deal.counties, dealState: opts.deal.state, asOf }, opts.buyers, db);
  const deal = toMatchDeal(opts.deal);
  const weights = opts.weights ?? BUYER_MATCH_WEIGHTS;
  const out = new Map<string, BuyerMatchResult>();
  for (const b of opts.buyers) {
    let acquisitions = acquisitionsFor(index, buyerEntityKeys(b.companyName, b.aliases));
    if (asOf) acquisitions = acquisitions.filter((a) => a.date.getTime() <= asOf.getTime());
    out.set(b.id, scoreBuyer({
      deal, geo, now: asOf ?? now, weights,
      buyer: { id: b.id, buyBox: toMatchBuyBox(b.buyBox), acquisitions, crm: crm.get(b.id)! },
    }));
  }
  return out;
}
