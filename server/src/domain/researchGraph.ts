/**
 * Research relationship & acquisition-chain analytics (pure, unit-tested).
 *
 * Given a flat list of ownership-transfer edges (one Grantor → Grantee per
 * recorded instrument), this module derives the market-intelligence layer of the
 * Research page:
 *
 *  - `aggregateRelationships`  — collapse repeated transfers between the same two
 *                                parties into a single weighted relationship.
 *  - `coBuyerPartnerships`     — entities that repeatedly acquire together on the
 *                                same instrument (grouped by transaction key).
 *  - `classifyEntities`        — label each entity by acquisition behaviour
 *                                (Terminal Hold / Distributor / Aggregator /
 *                                Feeder) from its in/out flow shape.
 *  - `buildChains`             — trace directed acquisition paths A→B→C… through
 *                                the relationship graph, cycle-free and deduped.
 *  - `buildGraph`              — nodes (sized by activity, coloured by class) and
 *                                weighted directed edges for the network view.
 *  - `entityNetwork`           — the same intelligence focused on one entity, for
 *                                the Buyer Profile Relationships section.
 *
 * Everything here is deterministic and side-effect free so the formulas stay
 * unit-testable; the route layer only loads rows and calls in.
 */
import { normalizeEntity, splitParties } from "./research.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One participant-level ownership-transfer edge (Grantor → Grantee).
 *
 * A multi-party instrument ("A; B → C") expands into one edge per
 * grantor×grantee pair, all sharing the same `id` (the ResearchDocument) —
 * so `id` is the TRANSACTION identity and everything that counts
 * transactions must count DISTINCT ids, never raw edges.
 */
export interface TxEdge {
  id: string;                 // ResearchDocument id — the transaction identity
  grantorNorm: string;        // normalized seller key
  grantor: string;            // seller display name
  granteeNorm: string;        // normalized buyer key
  grantee: string;            // buyer display name
  state: string;
  county: string;
  abstractId: string | null;
  date: Date;
  /** Instrument-level grouping key; edges sharing it are the same recording. */
  txKey: string | null;
  /**
   * The FULL party group this edge's participants belong to, as recorded on
   * the instrument — norm key and display name joined with " + ". Equal to
   * the single participant when the side has one party; absent on edges
   * built before group expansion (fall back to the participant fields).
   */
  grantorGroupNorm?: string;
  grantorGroupName?: string;
  granteeGroupNorm?: string;
  granteeGroupName?: string;
}

/** The ResearchDocument fields needed to expand a record into TxEdges. */
export interface TransferDocRow {
  id: string;
  grantor: string | null;
  grantorNorm: string | null;
  grantee: string | null;
  granteeNorm: string | null;
  grantorParties: string[];
  granteeParties: string[];
  grantorNorms: string[];
  granteeNorms: string[];
  state: string;
  county: string;
  abstractId: string | null;
  recordingDate: Date;
  instrumentNumber: string | null;
}

/** Sanity cap — a "party list" beyond this is a mangled cell, not a group. */
const MAX_PARTIES_PER_SIDE = 8;

/** Individual participants for one side of a record. Prefers the arrays the
 *  ingest stored; legacy rows (empty arrays) are split from the raw string at
 *  read time so pre-existing data participates without a backfill. */
function sideParties(
  raw: string | null, norm: string | null, parties: string[], norms: string[],
): { norm: string; name: string }[] {
  if (norms.length > 0) {
    return norms.slice(0, MAX_PARTIES_PER_SIDE).map((n, i) => ({ norm: n, name: parties[i]?.trim() || n }));
  }
  const split = splitParties(raw);
  if (split.length > 1) {
    return split.slice(0, MAX_PARTIES_PER_SIDE)
      .map((p) => ({ norm: normalizeEntity(p) ?? "", name: p }))
      .filter((p) => p.norm);
  }
  return norm ? [{ norm, name: raw?.trim() || norm }] : [];
}

/**
 * Expand a recorded instrument into participant-level edges: one edge per
 * grantor×grantee pair, all carrying the document's id. The record remains
 * ONE transaction; the expansion links every participant to it.
 */
export function expandDocToEdges(r: TransferDocRow): TxEdge[] {
  const grantors = sideParties(r.grantor, r.grantorNorm, r.grantorParties, r.grantorNorms);
  const grantees = sideParties(r.grantee, r.granteeNorm, r.granteeParties, r.granteeNorms);
  const txKey = r.instrumentNumber ? `${r.state}|${r.county}|${r.instrumentNumber}` : null;
  // The recorded group identity for each side: "(A + B)" stays one unit in
  // relationship displays even though participant edges exist for analytics.
  const grantorGroupNorm = grantors.map((g) => g.norm).join(" + ");
  const grantorGroupName = grantors.map((g) => g.name).join(" + ");
  const granteeGroupNorm = grantees.map((g) => g.norm).join(" + ");
  const granteeGroupName = grantees.map((g) => g.name).join(" + ");
  const out: TxEdge[] = [];
  for (const g of grantors) {
    for (const t of grantees) {
      out.push({
        id: r.id,
        grantorNorm: g.norm, grantor: g.name,
        granteeNorm: t.norm, grantee: t.name,
        state: r.state, county: r.county, abstractId: r.abstractId,
        date: r.recordingDate, txKey,
        grantorGroupNorm, grantorGroupName, granteeGroupNorm, granteeGroupName,
      });
    }
  }
  return out;
}

const SEP = "\u0000"; // NUL — safe pair delimiter (never appears in names)
const pairKey = (a: string, b: string) => `${a}${SEP}${b}`;

/** Pick the display name seen most often for a normalized key. */
function displayNames(edges: TxEdge[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  const bump = (norm: string, raw: string) => {
    if (!norm) return;
    const m = counts.get(norm) ?? new Map<string, number>();
    if (raw?.trim()) m.set(raw.trim(), (m.get(raw.trim()) ?? 0) + 1);
    counts.set(norm, m);
  };
  for (const e of edges) { bump(e.grantorNorm, e.grantor); bump(e.granteeNorm, e.grantee); }
  const out = new Map<string, string>();
  for (const [norm, m] of counts) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    out.set(norm, best ? best[0] : norm);
  }
  return out;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Grantor → Grantee relationships
// ---------------------------------------------------------------------------

export interface Relationship {
  grantorNorm: string;
  grantor: string;
  granteeNorm: string;
  grantee: string;
  count: number;                 // number of transfers between the two parties
  counties: string[];
  abstracts: string[];
  firstDate: string | null;      // ISO
  lastDate: string | null;
  txIds: string[];               // supporting ResearchDocument ids
}

/**
 * Collapse repeated transfers between identical parties into a single weighted
 * relationship. Self-loops (same normalized entity as grantor and grantee) are
 * dropped — they are almost always a name-normalization artefact, not a real
 * transfer of interest.
 */
export function aggregateRelationships(edges: TxEdge[]): Relationship[] {
  const names = displayNames(edges);
  interface Agg {
    grantorNorm: string; granteeNorm: string; count: number;
    counties: Set<string>; abstracts: Set<string>;
    first: number; last: number; txIds: string[];
  }
  const map = new Map<string, Agg>();
  for (const e of edges) {
    if (!e.grantorNorm || !e.granteeNorm || e.grantorNorm === e.granteeNorm) continue;
    const key = pairKey(e.grantorNorm, e.granteeNorm);
    let a = map.get(key);
    if (!a) {
      a = {
        grantorNorm: e.grantorNorm, granteeNorm: e.granteeNorm, count: 0,
        counties: new Set(), abstracts: new Set(),
        first: Infinity, last: -Infinity, txIds: [],
      };
      map.set(key, a);
    }
    a.count++;
    if (e.county) a.counties.add(e.county);
    if (e.abstractId) a.abstracts.add(e.abstractId);
    const t = e.date.getTime();
    if (t < a.first) a.first = t;
    if (t > a.last) a.last = t;
    a.txIds.push(e.id);
  }
  return [...map.values()]
    .map((a) => ({
      grantorNorm: a.grantorNorm, grantor: names.get(a.grantorNorm) ?? a.grantorNorm,
      granteeNorm: a.granteeNorm, grantee: names.get(a.granteeNorm) ?? a.granteeNorm,
      count: a.count,
      counties: [...a.counties].sort(),
      abstracts: [...a.abstracts].sort(),
      firstDate: Number.isFinite(a.first) ? iso(new Date(a.first)) : null,
      lastDate: Number.isFinite(a.last) ? iso(new Date(a.last)) : null,
      txIds: a.txIds,
    }))
    .sort((x, y) => y.count - x.count || x.grantor.localeCompare(y.grantor));
}

/**
 * Group-preserving relationship aggregation for the Grantor → Grantee views:
 * each recorded instrument keeps its ORIGINAL party structure — a multi-party
 * record displays as "(A + B) → (C + D)", one relationship and one
 * transaction, never four implied one-to-one relationships. Counting is per
 * distinct document (expanded participant edges of one record collapse back
 * into a single unit here). Participant-level analytics (chains, entity
 * classification, buyer profiles) continue to use `aggregateRelationships`.
 */
export function aggregateGroupRelationships(edges: TxEdge[]): Relationship[] {
  interface Agg {
    grantorNorm: string; grantor: string; granteeNorm: string; grantee: string;
    counties: Set<string>; abstracts: Set<string>;
    first: number; last: number; txIds: Set<string>;
  }
  const map = new Map<string, Agg>();
  for (const e of edges) {
    const gNorm = e.grantorGroupNorm ?? e.grantorNorm;
    const tNorm = e.granteeGroupNorm ?? e.granteeNorm;
    if (!gNorm || !tNorm || gNorm === tNorm) continue;
    const key = pairKey(gNorm, tNorm);
    let a = map.get(key);
    if (!a) {
      a = {
        grantorNorm: gNorm, grantor: e.grantorGroupName ?? e.grantor,
        granteeNorm: tNorm, grantee: e.granteeGroupName ?? e.grantee,
        counties: new Set(), abstracts: new Set(),
        first: Infinity, last: -Infinity, txIds: new Set(),
      };
      map.set(key, a);
    }
    if (e.county) a.counties.add(e.county);
    if (e.abstractId) a.abstracts.add(e.abstractId);
    const t = e.date.getTime();
    if (t < a.first) a.first = t;
    if (t > a.last) a.last = t;
    a.txIds.add(e.id);
  }
  return [...map.values()]
    .map((a) => ({
      grantorNorm: a.grantorNorm, grantor: a.grantor,
      granteeNorm: a.granteeNorm, grantee: a.grantee,
      count: a.txIds.size,
      counties: [...a.counties].sort(),
      abstracts: [...a.abstracts].sort(),
      firstDate: Number.isFinite(a.first) ? iso(new Date(a.first)) : null,
      lastDate: Number.isFinite(a.last) ? iso(new Date(a.last)) : null,
      txIds: [...a.txIds],
    }))
    .sort((x, y) => y.count - x.count || x.grantor.localeCompare(y.grantor));
}

// ---------------------------------------------------------------------------
// Co-buyer partnerships
// ---------------------------------------------------------------------------

export interface CoBuyerPartnership {
  members: { norm: string; name: string }[]; // 2+ entities, sorted
  count: number;                              // total partnership transactions (both roles)
  /** Recorded instruments where the group acquired together (co-grantees). */
  sharedAcquisitions: number;
  /** Recorded instruments where the group conveyed together (co-grantors). */
  sharedDispositions: number;
  firstDate: string | null;                   // first recorded transaction together (ISO, any role)
  lastDate: string | null;                    // most recent transaction together (ISO, any role)
  /** First/most recent SHARED ACQUISITION — what the Co-Buyer view surfaces. */
  acqFirstDate: string | null;
  acqLastDate: string | null;
  counties: string[];
  txKeys: string[];                           // instrument/document keys (for drill-in)
}

/**
 * Detect entities that acquire together on the same instrument. Edges are
 * grouped by `txKey`; any instrument naming two or more distinct grantees yields
 * a partnership of exactly that grantee set. Repeated partnerships are counted
 * and ranked by frequency.
 */
export function coBuyerPartnerships(edges: TxEdge[]): CoBuyerPartnership[] {
  const names = displayNames(edges);
  // Group participants per recorded transaction: by instrument key when one
  // exists (co-grantees may arrive as separate rows of one instrument), else
  // by document id (multi-party cells expand to edges sharing the id).
  interface TxGroup { grantors: Set<string>; grantees: Set<string>; counties: Set<string>; first: number; last: number }
  const byTx = new Map<string, TxGroup>();
  for (const e of edges) {
    const key = e.txKey ?? e.id;
    let g = byTx.get(key);
    if (!g) { g = { grantors: new Set(), grantees: new Set(), counties: new Set(), first: Infinity, last: -Infinity }; byTx.set(key, g); }
    if (e.grantorNorm) g.grantors.add(e.grantorNorm);
    if (e.granteeNorm) g.grantees.add(e.granteeNorm);
    if (e.county) g.counties.add(e.county);
    const t = e.date.getTime();
    if (t < g.first) g.first = t;
    if (t > g.last) g.last = t;
  }
  interface Agg {
    members: string[]; sharedAcquisitions: number; sharedDispositions: number;
    counties: Set<string>; txKeys: string[]; first: number; last: number;
    acqFirst: number; acqLast: number;
  }
  const map = new Map<string, Agg>();
  const bump = (txKey: string, g: TxGroup, side: Set<string>, kind: "sharedAcquisitions" | "sharedDispositions") => {
    if (side.size < 2) return;
    const members = [...side].sort();
    const key = members.join(SEP);
    let a = map.get(key);
    if (!a) { a = { members, sharedAcquisitions: 0, sharedDispositions: 0, counties: new Set(), txKeys: [], first: Infinity, last: -Infinity, acqFirst: Infinity, acqLast: -Infinity }; map.set(key, a); }
    a[kind]++;
    for (const c of g.counties) a.counties.add(c);
    a.txKeys.push(txKey);
    if (g.first < a.first) a.first = g.first;
    if (g.last > a.last) a.last = g.last;
    if (kind === "sharedAcquisitions") {
      if (g.first < a.acqFirst) a.acqFirst = g.first;
      if (g.last > a.acqLast) a.acqLast = g.last;
    }
  };
  for (const [txKey, g] of byTx) {
    bump(txKey, g, g.grantees, "sharedAcquisitions");  // group acquired together
    bump(txKey, g, g.grantors, "sharedDispositions");  // group conveyed together
  }
  return [...map.values()]
    .map((a) => ({
      members: a.members.map((norm) => ({ norm, name: names.get(norm) ?? norm })),
      count: a.sharedAcquisitions + a.sharedDispositions,
      sharedAcquisitions: a.sharedAcquisitions,
      sharedDispositions: a.sharedDispositions,
      firstDate: Number.isFinite(a.first) ? iso(new Date(a.first)) : null,
      lastDate: Number.isFinite(a.last) ? iso(new Date(a.last)) : null,
      acqFirstDate: Number.isFinite(a.acqFirst) ? iso(new Date(a.acqFirst)) : null,
      acqLastDate: Number.isFinite(a.acqLast) ? iso(new Date(a.acqLast)) : null,
      counties: [...a.counties].sort(),
      txKeys: [...new Set(a.txKeys)],
    }))
    .sort((x, y) => y.count - x.count || y.members.length - x.members.length);
}

// ---------------------------------------------------------------------------
// Entity classification
// ---------------------------------------------------------------------------

export type EntityClass =
  | "TERMINAL_HOLD"   // acquires, (almost) never sells — long-term holder
  | "DISTRIBUTOR"     // both buys and resells recurrently — wholesaler
  | "AGGREGATOR"      // buys from many, consolidates upward to few/larger
  | "FEEDER"          // buys, then consistently sells into 1–2 downstream buyers
  | "PASS_THROUGH"    // low-volume both-sides mover (default when it transacts both ways)
  | "SELLER"          // only ever a grantor in this dataset
  | "ONE_TIME_BUYER"  // a single recorded acquisition, nothing resold
  | "UNCLASSIFIED";   // insufficient signal

export interface EntityStats {
  norm: string;
  name: string;
  acquisitions: number;      // total inbound transfer count (as grantee)
  dispositions: number;      // total outbound transfer count (as grantor)
  distinctGrantors: number;  // upstream sources it bought from
  distinctGrantees: number;  // downstream buyers it sold to
  klass: EntityClass;
}

/** Minimum activity before an entity earns a behavioural label (vs UNCLASSIFIED). */
export const MIN_ACTIVITY = 2;

/**
 * Classify one entity from its flow shape. Thresholds favour interpretability:
 * fan-in / fan-out counts and the buy:sell ratio decide the label.
 */
export function classifyEntity(s: {
  acquisitions: number; dispositions: number; distinctGrantors: number; distinctGrantees: number;
}): EntityClass {
  const { acquisitions: inn, dispositions: out, distinctGrantors: srcs, distinctGrantees: dsts } = s;
  if (inn === 0 && out === 0) return "UNCLASSIFIED";
  if (inn === 0 && out > 0) return "SELLER";
  if (inn > 0 && out === 0) {
    return inn >= MIN_ACTIVITY ? "TERMINAL_HOLD" : "ONE_TIME_BUYER";
  }
  // Buys and sells. Distinguish the intermediary archetypes.
  // Aggregator: broad fan-in from many sources, narrow fan-out (consolidating up).
  if (srcs >= 3 && srcs >= dsts * 2 && dsts <= 2) return "AGGREGATOR";
  // Feeder: sells into a single (or very few) downstream buyer(s) consistently.
  if (dsts <= 2 && out >= MIN_ACTIVITY && srcs <= dsts + 1) return "FEEDER";
  // Distributor: recurring on both sides across multiple counterparties.
  if (inn >= MIN_ACTIVITY && out >= MIN_ACTIVITY && (srcs >= 2 || dsts >= 2)) return "DISTRIBUTOR";
  return "PASS_THROUGH";
}

/** Human labels for each class (shared server/client contract). */
export const ENTITY_CLASS_LABEL: Record<EntityClass, string> = {
  TERMINAL_HOLD: "Terminal Hold Platform",
  DISTRIBUTOR: "Short-Hold Distributor",
  AGGREGATOR: "Aggregator",
  FEEDER: "Feeder",
  PASS_THROUGH: "Pass-Through",
  SELLER: "Seller",
  ONE_TIME_BUYER: "One-Time Buyer",
  UNCLASSIFIED: "Unclassified",
};

/** Build per-entity flow stats + classification from aggregated relationships. */
export function classifyEntities(rels: Relationship[]): Map<string, EntityStats> {
  // Acquisitions/dispositions are counted per DISTINCT transaction (txId), not
  // per relationship pair: a multi-party instrument (A + B → C) links C to two
  // relationships but is still exactly one acquisition for C.
  interface Acc {
    name: string; acqTx: Set<string>; dispTx: Set<string>;
    grantors: Set<string>; grantees: Set<string>;
  }
  const acc = new Map<string, Acc>();
  const get = (norm: string, name: string): Acc => {
    let a = acc.get(norm);
    if (!a) { a = { name, acqTx: new Set(), dispTx: new Set(), grantors: new Set(), grantees: new Set() }; acc.set(norm, a); }
    if (name && a.name === norm) a.name = name;
    return a;
  };
  for (const r of rels) {
    const seller = get(r.grantorNorm, r.grantor);
    for (const id of r.txIds) seller.dispTx.add(id);
    seller.grantees.add(r.granteeNorm);
    const buyer = get(r.granteeNorm, r.grantee);
    for (const id of r.txIds) buyer.acqTx.add(id);
    buyer.grantors.add(r.grantorNorm);
  }
  const out = new Map<string, EntityStats>();
  for (const [norm, a] of acc) {
    const stats = {
      acquisitions: a.acqTx.size, dispositions: a.dispTx.size,
      distinctGrantors: a.grantors.size, distinctGrantees: a.grantees.size,
    };
    out.set(norm, { norm, name: a.name, ...stats, klass: classifyEntity(stats) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Acquisition chains
// ---------------------------------------------------------------------------

export interface ChainHop { fromNorm: string; from: string; toNorm: string; to: string; count: number }
export interface AcquisitionChain {
  nodes: { norm: string; name: string; klass: EntityClass }[];
  hops: ChainHop[];
  length: number;         // number of hops
  strength: number;       // minimum hop count along the path (bottleneck volume)
  totalCount: number;     // sum of hop counts
  counties: string[];
  firstDate: string | null;
  lastDate: string | null;
}

interface ChainOpts {
  maxDepth?: number;      // max hops (default 4)
  minHopCount?: number;   // ignore weak edges below this weight (default 1)
  maxChains?: number;     // cap output (default 60)
}

/**
 * Trace directed acquisition paths through the relationship graph. Starts from
 * source-like nodes (feeders / sellers with no meaningful inbound) and walks
 * forward, extending each path until it reaches a terminal node or the depth
 * cap. Cycles are prevented by never revisiting a node within a path; shorter
 * paths that are strict prefixes of a returned longer path are dropped.
 */
export function buildChains(rels: Relationship[], opts: ChainOpts = {}): AcquisitionChain[] {
  const maxDepth = opts.maxDepth ?? 4;
  const minHop = opts.minHopCount ?? 1;
  const maxChains = opts.maxChains ?? 60;

  const edges = rels.filter((r) => r.count >= minHop);
  if (edges.length === 0) return [];

  const stats = classifyEntities(rels);
  const outAdj = new Map<string, Relationship[]>();
  const inDeg = new Map<string, number>();
  const allNodes = new Set<string>();
  for (const r of edges) {
    (outAdj.get(r.grantorNorm) ?? outAdj.set(r.grantorNorm, []).get(r.grantorNorm)!).push(r);
    inDeg.set(r.granteeNorm, (inDeg.get(r.granteeNorm) ?? 0) + 1);
    allNodes.add(r.grantorNorm); allNodes.add(r.granteeNorm);
  }
  // Roots: nodes that originate flow (no inbound edges) — true chain starts.
  const roots = [...allNodes].filter((n) => !(inDeg.get(n)! > 0)).sort();

  const nameOf = (norm: string) => stats.get(norm)?.name ?? norm;
  const klassOf = (norm: string) => stats.get(norm)?.klass ?? "UNCLASSIFIED";

  const results: AcquisitionChain[] = [];
  // Track emitted node-sequences to drop prefixes/duplicates.
  const emitted = new Set<string>();

  const walk = (path: Relationship[], nodePath: string[], visited: Set<string>) => {
    // Record every path with ≥2 hops; prefix-dropping below keeps only the
    // maximal chains, so we can emit greedily as we descend.
    if (path.length >= 2) pushChain(path, nodePath);
    if (path.length >= maxDepth) return;
    const tail = nodePath[nodePath.length - 1];
    const nexts = (outAdj.get(tail) ?? []).filter((r) => !visited.has(r.granteeNorm));
    for (const r of nexts) {
      const nv = new Set(visited); nv.add(r.granteeNorm);
      walk([...path, r], [...nodePath, r.granteeNorm], nv);
    }
  };

  const pushChain = (path: Relationship[], nodePath: string[]) => {
    if (path.length < 2) return; // a chain needs at least A→B→C
    const sig = nodePath.join(SEP);
    if (emitted.has(sig)) return;
    emitted.add(sig);
    const counties = new Set<string>();
    let first = Infinity, last = -Infinity;
    const hops: ChainHop[] = path.map((r) => {
      for (const c of r.counties) counties.add(c);
      if (r.firstDate) first = Math.min(first, Date.parse(r.firstDate));
      if (r.lastDate) last = Math.max(last, Date.parse(r.lastDate));
      return { fromNorm: r.grantorNorm, from: r.grantor, toNorm: r.granteeNorm, to: r.grantee, count: r.count };
    });
    results.push({
      nodes: nodePath.map((norm) => ({ norm, name: nameOf(norm), klass: klassOf(norm) })),
      hops,
      length: hops.length,
      strength: Math.min(...hops.map((h) => h.count)),
      totalCount: hops.reduce((s, h) => s + h.count, 0),
      counties: [...counties].sort(),
      firstDate: Number.isFinite(first) ? iso(new Date(first)) : null,
      lastDate: Number.isFinite(last) ? iso(new Date(last)) : null,
    });
  };

  for (const root of roots) {
    for (const r of (outAdj.get(root) ?? [])) {
      walk([r], [root, r.granteeNorm], new Set([root, r.granteeNorm]));
    }
  }

  // Drop chains that are a strict prefix of a longer emitted chain — keep the
  // fullest acquisition path only.
  const sigs = results.map((c) => c.nodes.map((n) => n.norm).join(SEP));
  const kept = results.filter((_, i) => {
    const s = sigs[i] + SEP;
    return !sigs.some((other, j) => j !== i && other.startsWith(s));
  });

  return kept
    .sort((a, b) => b.strength - a.strength || b.length - a.length || b.totalCount - a.totalCount)
    .slice(0, maxChains);
}

/**
 * Summarise a chain into the acquisition-table shape: which nodes are feeders,
 * which are aggregators/mid-tier, and the end terminus (final holder).
 */
export interface ChainTableRow {
  chain: AcquisitionChain;
  feeders: string[];
  midTier: string[];
  terminus: string | null;
  path: string;             // "A → B → C"
}

export function chainTableRows(chains: AcquisitionChain[]): ChainTableRow[] {
  return chains.map((c) => {
    const feeders: string[] = [];
    const midTier: string[] = [];
    c.nodes.forEach((n, i) => {
      const isLast = i === c.nodes.length - 1;
      if (isLast) return;
      if (i === 0 || n.klass === "FEEDER" || n.klass === "SELLER") feeders.push(n.name);
      else midTier.push(n.name);
    });
    const terminus = c.nodes.length ? c.nodes[c.nodes.length - 1].name : null;
    return {
      chain: c,
      feeders: [...new Set(feeders)],
      midTier: [...new Set(midTier)],
      terminus,
      path: c.nodes.map((n) => n.name).join(" → "),
    };
  });
}

// ---------------------------------------------------------------------------
// Network graph (nodes + weighted edges)
// ---------------------------------------------------------------------------

export interface GraphNode {
  norm: string; name: string; klass: EntityClass;
  activity: number;          // acquisitions + dispositions (drives node size)
  acquisitions: number; dispositions: number;
}
export interface GraphEdge { fromNorm: string; toNorm: string; count: number }
export interface RelationshipGraph { nodes: GraphNode[]; edges: GraphEdge[] }

/**
 * Build a graph capped to the most active entities so the client render stays
 * legible. Entities are ranked by total activity; edges between kept nodes are
 * retained.
 */
export function buildGraph(rels: Relationship[], maxNodes = 60): RelationshipGraph {
  const stats = classifyEntities(rels);
  const ranked = [...stats.values()]
    .sort((a, b) => (b.acquisitions + b.dispositions) - (a.acquisitions + a.dispositions))
    .slice(0, maxNodes);
  const keep = new Set(ranked.map((s) => s.norm));
  const nodes: GraphNode[] = ranked.map((s) => ({
    norm: s.norm, name: s.name, klass: s.klass,
    activity: s.acquisitions + s.dispositions,
    acquisitions: s.acquisitions, dispositions: s.dispositions,
  }));
  const edges: GraphEdge[] = rels
    .filter((r) => keep.has(r.grantorNorm) && keep.has(r.granteeNorm))
    .map((r) => ({ fromNorm: r.grantorNorm, toNorm: r.granteeNorm, count: r.count }));
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Entity-focused network (Buyer Profile)
// ---------------------------------------------------------------------------

/**
 * Words in a RAW (un-normalized) party name that mark it as a business entity
 * rather than an individual seller. Checked against the raw spelling because
 * normalizeEntity strips exactly these suffixes to build grouping keys.
 */
const BUSINESS_WORDS = new Set([
  "LLC", "L.L.C", "LP", "L.P", "LLP", "LTD", "LIMITED", "INC", "INCORPORATED",
  "CORP", "CORPORATION", "CO", "COMPANY", "LC", "PLLC", "PC",
  "HOLDINGS", "PARTNERS", "PARTNERSHIP", "TRUST", "BANK",
  "ENERGY", "MINERALS", "MINERAL", "ROYALTY", "ROYALTIES", "RESOURCES",
  "PETROLEUM", "OIL", "GAS", "EXPLORATION", "PRODUCTION", "OPERATING",
  "INVESTMENTS", "PROPERTIES", "LAND", "CAPITAL", "GROUP", "VENTURES",
  "ACQUISITIONS", "INTERESTS", "FUND", "MANAGEMENT", "ASSOCIATES",
]);

export type PartyEntityType = "company" | "individual";

/** Classify a raw party name as a business entity or an individual seller. */
export function partyEntityType(rawName: string): PartyEntityType {
  const words = rawName.toUpperCase().replace(/[^A-Z0-9&.\s]/g, " ").split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (BUSINESS_WORDS.has(w) || BUSINESS_WORDS.has(w.replace(/\.+$/g, ""))) return "company";
  }
  // "SMITH & SONS", "A&B CATTLE" style names read as businesses too.
  if (rawName.includes("&") && words.length >= 3) return "company";
  return "individual";
}

export interface RankedParty { norm: string; name: string; count: number; entityType: PartyEntityType }

export interface EntityNetwork {
  norm: string;
  name: string;
  klass: EntityClass;
  classLabel: string;
  acquisitions: number;
  dispositions: number;
  /** Upstream sources the entity acquired from, ranked. */
  topGrantors: RankedParty[];
  /** Downstream buyers the entity sold to, ranked. */
  topGrantees: RankedParty[];
  /** Partners that co-acquired alongside the entity. */
  coBuyers: RankedParty[];
  /** Acquisition chains the entity participates in, with its role/position. */
  chains: { chain: AcquisitionChain; position: number; role: EntityClass }[];
  graph: RelationshipGraph;
  /**
   * Per-alias attribution: how much of the focus entity's activity each
   * normalized key (primary name or confirmed alias) contributed — so a merged
   * profile keeps visibility into which historical alias did what.
   */
  aliasBreakdown: { norm: string; name: string; acquisitions: number; dispositions: number }[];
}

/**
 * Focus the full analysis on one entity (identified by one or more normalized
 * keys — a buyer plus its aliases). Produces the Buyer Profile Relationships
 * payload: top grantors/grantees, co-buyers, participating chains, and a graph
 * of the entity's direct neighbourhood.
 */
export function entityNetwork(edges: TxEdge[], focusNorms: string[], displayName?: string): EntityNetwork | null {
  const focus = new Set(focusNorms.filter(Boolean));
  if (focus.size === 0) return null;
  const primary = focusNorms[0];

  const rels = aggregateRelationships(edges);
  const stats = classifyEntities(rels);

  // Aggregate focus stats across all alias keys — tracking, per alias key, how
  // much activity that historical name contributed (merged-profile attribution).
  // Transaction totals dedupe by txId — a multi-party instrument the focus
  // participated in counts once, even though it spans several relationships.
  // Counterparties are ranked by their RECORDED GROUP ("(A + B)" stays one
  // unit — the instrument's original structure, not implied 1:1 splits).
  const acqTx = new Set<string>(), dispTx = new Set<string>();
  const grantorAgg = new Map<string, { name: string; tx: Set<string> }>();
  const granteeAgg = new Map<string, { name: string; tx: Set<string> }>();
  const aliasAgg = new Map<string, { name: string; acqTx: Set<string>; dispTx: Set<string> }>();
  const aliasBump = (norm: string, name: string, kind: "acqTx" | "dispTx", id: string) => {
    const a = aliasAgg.get(norm) ?? { name, acqTx: new Set<string>(), dispTx: new Set<string>() };
    a[kind].add(id);
    aliasAgg.set(norm, a);
  };
  for (const e of edges) {
    const focusGrantee = focus.has(e.granteeNorm), focusGrantor = focus.has(e.grantorNorm);
    if (focusGrantee && !focusGrantor) {
      acqTx.add(e.id);
      const key = e.grantorGroupNorm ?? e.grantorNorm;
      const g = grantorAgg.get(key) ?? { name: e.grantorGroupName ?? e.grantor, tx: new Set<string>() };
      g.tx.add(e.id); grantorAgg.set(key, g);
      aliasBump(e.granteeNorm, e.grantee, "acqTx", e.id);
    }
    if (focusGrantor && !focusGrantee) {
      dispTx.add(e.id);
      const key = e.granteeGroupNorm ?? e.granteeNorm;
      const g = granteeAgg.get(key) ?? { name: e.granteeGroupName ?? e.grantee, tx: new Set<string>() };
      g.tx.add(e.id); granteeAgg.set(key, g);
      aliasBump(e.grantorNorm, e.grantor, "dispTx", e.id);
    }
  }
  const acquisitions = acqTx.size, dispositions = dispTx.size;
  const rank = (m: Map<string, { name: string; count: number }>): RankedParty[] =>
    [...m.entries()].map(([norm, v]) => ({ norm, name: v.name, count: v.count, entityType: partyEntityType(v.name) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const toCounts = (m: Map<string, { name: string; tx: Set<string> }>) =>
    new Map([...m.entries()].map(([k, v]) => [k, { name: v.name, count: v.tx.size }]));

  // Co-buyers: ACQUISITION partnerships only — partners the focus entity
  // bought with as co-grantees. Sell-side partnerships stay internal to
  // coBuyerPartnerships and never rank a co-buyer here.
  const parts = coBuyerPartnerships(edges);
  const coCounts = new Map<string, { name: string; count: number }>();
  for (const p of parts) {
    if (p.sharedAcquisitions === 0) continue;
    if (!p.members.some((m) => focus.has(m.norm))) continue;
    for (const m of p.members) {
      if (focus.has(m.norm)) continue;
      const c = coCounts.get(m.norm) ?? { name: m.name, count: 0 };
      c.count += p.sharedAcquisitions; coCounts.set(m.norm, c);
    }
  }

  // Chains involving the focus, with the focus entity's position in the path.
  //
  // Built from the FOCUS-CENTRED subgraph (every edge reachable within the
  // chain depth of any focus key), not the global org graph: buildChains caps
  // its output by strength, and on the global graph a big org's strongest
  // chains could crowd out this buyer's own paths entirely — which is exactly
  // how merged aliases "lost" their acquisition chains. On the subgraph the
  // cap only ever competes among this buyer's neighbourhood, so every alias
  // key contributes its chains.
  const reach = new Set<string>(focus);
  {
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string) => (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    for (const r of rels) { link(r.grantorNorm, r.granteeNorm); link(r.granteeNorm, r.grantorNorm); }
    let frontier = [...focus];
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next: string[] = [];
      for (const n of frontier) for (const m of adj.get(n) ?? []) if (!reach.has(m)) { reach.add(m); next.push(m); }
      frontier = next;
    }
  }
  const focusRels = rels.filter((r) => reach.has(r.grantorNorm) && reach.has(r.granteeNorm));
  const chains = buildChains(focusRels, { maxChains: 400 })
    .map((c) => {
      const idx = c.nodes.findIndex((n) => focus.has(n.norm));
      if (idx < 0) return null;
      return { chain: c, position: idx, role: c.nodes[idx].klass };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .slice(0, 100);

  // Direct-neighbourhood graph: focus + its immediate counterparties.
  const neighbours = new Set<string>(focus);
  for (const k of grantorAgg.keys()) neighbours.add(k);
  for (const k of granteeAgg.keys()) neighbours.add(k);
  for (const k of coCounts.keys()) neighbours.add(k);
  const localStats = classifyEntities(rels);
  const nodes: GraphNode[] = [...neighbours].map((norm) => {
    const s = localStats.get(norm);
    return {
      norm, name: s?.name ?? norm, klass: s?.klass ?? "UNCLASSIFIED",
      activity: (s?.acquisitions ?? 0) + (s?.dispositions ?? 0),
      acquisitions: s?.acquisitions ?? 0, dispositions: s?.dispositions ?? 0,
    };
  });
  const edgesOut: GraphEdge[] = rels
    .filter((r) => neighbours.has(r.grantorNorm) && neighbours.has(r.granteeNorm) &&
      (focus.has(r.grantorNorm) || focus.has(r.granteeNorm)))
    .map((r) => ({ fromNorm: r.grantorNorm, toNorm: r.granteeNorm, count: r.count }));

  const focusStats = stats.get(primary);
  const klass = classifyEntity({ acquisitions, dispositions, distinctGrantors: grantorAgg.size, distinctGrantees: granteeAgg.size });

  return {
    norm: primary,
    name: displayName ?? focusStats?.name ?? primary,
    klass,
    classLabel: ENTITY_CLASS_LABEL[klass],
    acquisitions,
    dispositions,
    topGrantors: rank(toCounts(grantorAgg)),
    topGrantees: rank(toCounts(granteeAgg)),
    coBuyers: rank(coCounts),
    chains,
    graph: { nodes, edges: edgesOut },
    aliasBreakdown: [...aliasAgg.entries()]
      .map(([n, a]) => ({ norm: n, name: a.name, acquisitions: a.acqTx.size, dispositions: a.dispTx.size }))
      .sort((a, b) => (b.acquisitions + b.dispositions) - (a.acquisitions + a.dispositions)),
  };
}
