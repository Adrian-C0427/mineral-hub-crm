/**
 * Legal tract-description parsing (metes and bounds → polygon).
 *
 * Modular by state: `parseTract(text, state)` dispatches through PARSERS, so a
 * PLSS-grammar parser for, say, Oklahoma slots in without touching the Texas
 * one. Texas ships first: quadrant bearings, distances in feet/varas/chains/
 * rods/meters, POB detection, abstract/survey/county/acreage references,
 * closure + shoelace acreage.
 *
 * The parser never fails silently: everything it can't resolve (curves without
 * chords, clauses with no measurable call, lot/block-only descriptions) lands
 * in `warnings` / `unresolved` so the UI can point the user at exactly the
 * text that needs review.
 */

export interface TractCall {
  /** 1-based order in the boundary walk. */
  seq: number;
  /** The clause text this call was read from (trimmed, for display/hover). */
  raw: string;
  /** Azimuth in degrees clockwise from north, or null if unparseable. */
  azimuth: number | null;
  /** Original quadrant form for display, e.g. "N 45°30' E". */
  bearing: string | null;
  /** Distance in feet (converted from the source unit), or null. */
  distanceFt: number | null;
  /** Distance as written, e.g. "410.5 varas". */
  distanceRaw: string | null;
  /** True when this clause described a curve we approximated or skipped. */
  curve: boolean;
  /** Why this call needs human review (unparseable bearing, missing distance…). */
  issue: string | null;
}

export interface TractRefs {
  abstracts: string[]; // "A-123" style, digits normalized
  surveys: string[];
  county: string | null;
  state: string;
  statedAcres: number | null;
  sections: string[];
  blocks: string[];
  lots: string[];
  quarters: string[]; // e.g. "NE/4"
}

export interface TractClosure {
  /** Whether the walked boundary returns to the POB within tolerance. */
  closes: boolean;
  /** Gap between last computed point and the POB, in feet. */
  gapFt: number;
  /** Traverse precision, e.g. 5000 means 1:5000 (higher is better). 0 if open. */
  precision: number;
}

export interface ParsedTract {
  ok: boolean; // true when at least 3 resolvable calls produced a polygon
  pobText: string | null; // the BEGINNING… clause, for display/highlight
  calls: TractCall[];
  /** Local polygon vertices in feet, POB at (0,0), +x east +y north. Closed
   *  only implicitly — first point is not repeated. */
  points: [number, number][];
  refs: TractRefs;
  closure: TractClosure | null;
  computedAcres: number | null;
  warnings: string[];
  /** Clause texts the parser recognized as boundary language but couldn't
   *  turn into geometry — the "requires review" list. */
  unresolved: string[];
  /** How this reading was produced. Always "rules" for new parses; "ai" only
   *  survives on tracts parsed before the engine became fully deterministic. */
  source: "rules" | "ai";
  /** Deterministic confidence 0–100, scored from measurable parse quality
   *  (POB found, calls resolved, closure, acreage agreement, assumptions). */
  confidence: number | null;
  /** Interpretive choices the parser made (each is a review prompt). */
  assumptions: string[];
  /** Which corner of the referenced survey/abstract the POB (or commencement
   *  point) is tied to, when the description names one. Lets the anchorer
   *  derive a precise POB from the abstract polygon instead of an arbitrary
   *  interior point. */
  pobCorner?: "NE" | "NW" | "SE" | "SW" | null;
  /** Commencement tie-line calls (excluded from the boundary walk) — applied
   *  as a vector from the resolved corner to locate the true POB. */
  tieCalls?: TractCall[];
}

// ---------------------------------------------------------------------------
// Units. The Texas vara is statutorily 33 1/3 inches.
const FT_PER: Record<string, number> = {
  ft: 1, foot: 1, feet: 1, "'": 1,
  vara: 2.7777778, varas: 2.7777778, vrs: 2.7777778, vr: 2.7777778, "vrs.": 2.7777778,
  chain: 66, chains: 66, chs: 66, ch: 66,
  rod: 16.5, rods: 16.5, pole: 16.5, poles: 16.5, perch: 16.5, perches: 16.5,
  meter: 3.2808399, meters: 3.2808399, metre: 3.2808399, metres: 3.2808399, m: 3.2808399,
};

const num = (s: string): number => Number(s.replace(/,/g, ""));

/** "N 45° 30' 20\" E" / "South 89 deg. 59 min. West" / "N45E" → azimuth. */
export function parseBearing(text: string): { azimuth: number; display: string } | null {
  const re = /\b(N(?:orth)?|S(?:outh)?)\s*[.,]?\s*(\d{1,3}(?:\.\d+)?)\s*(?:°|º|deg(?:rees)?\.?)?\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:'|′|min(?:utes)?\.?))?\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:"|″|sec(?:onds)?\.?))?\s*[.,]?\s*(E(?:ast)?|W(?:est)?)\b/i;
  const m = re.exec(text);
  if (!m) {
    // Cardinal-only: "THENCE North 100 feet" → 0/90/180/270.
    const c = /\b(north|south|east|west)\b/i.exec(text);
    if (!c) return null;
    const az = { north: 0, east: 90, south: 180, west: 270 }[c[1].toLowerCase()]!;
    return { azimuth: az, display: c[1][0].toUpperCase() + c[1].slice(1).toLowerCase() };
  }
  const ns = m[1][0].toUpperCase() as "N" | "S";
  const ew = m[5][0].toUpperCase() as "E" | "W";
  const deg = num(m[2]) + (m[3] ? num(m[3]) / 60 : 0) + (m[4] ? num(m[4]) / 3600 : 0);
  if (deg > 90.000001) return null; // quadrant bearings never exceed 90°
  let az: number;
  if (ns === "N" && ew === "E") az = deg;
  else if (ns === "S" && ew === "E") az = 180 - deg;
  else if (ns === "S" && ew === "W") az = 180 + deg;
  else az = 360 - deg;
  az = ((az % 360) + 360) % 360;
  const dm = m[3] ? `${String(Math.trunc(num(m[3]))).padStart(2, "0")}'` : "";
  const dsec = m[4] ? `${String(Math.trunc(num(m[4]))).padStart(2, "0")}"` : "";
  return { azimuth: az, display: `${ns} ${m[2]}°${dm}${dsec} ${ew}` };
}

/** First distance in a clause, converted to feet. */
export function parseDistance(text: string): { feet: number; raw: string } | null {
  const re = /\b([\d,]+(?:\.\d+)?)\s*(feet|foot|ft\.?|varas?|vrs\.?|vr\.?|chains?|chs?\.?|rods?|poles?|perch(?:es)?|met(?:er|re)s?)\b/i;
  const m = re.exec(text);
  if (!m) return null;
  const unit = m[2].toLowerCase().replace(/\.$/, "");
  const per = FT_PER[unit];
  if (!per) return null;
  const feet = num(m[1]) * per;
  if (!isFinite(feet) || feet <= 0) return null;
  return { feet, raw: `${m[1]} ${m[2]}` };
}

// ---------------------------------------------------------------------------

function extractRefs(text: string, state: string): TractRefs {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const abstracts: string[] = [];
  for (const m of text.matchAll(/\bABSTRACT\s+(?:NO\.?\s*)?(\d+)/gi)) abstracts.push(`A-${m[1]}`);
  for (const m of text.matchAll(/\bA-(\d+)\b/g)) abstracts.push(`A-${m[1]}`);
  const surveys: string[] = [];
  for (const m of text.matchAll(/([A-Z][A-Za-z.&'\- ]{2,60}?)\s+SURVEY\b/gi)) {
    // Trim leading boundary words that ride along ("of the", "in the").
    const s = m[1].replace(/^(?:of|in|the|said|original|to)\s+/gi, "").replace(/^(?:of|in|the|said)\s+/gi, "").trim();
    if (s.length > 2) surveys.push(s.toUpperCase());
  }
  const county = /([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+County/i.exec(text)?.[1] ?? null;
  const acres = /\b(?:containing|being|comprising)\s+(?:approximately\s+|about\s+)?([\d,]+(?:\.\d+)?)\s+acres?\b/i.exec(text)
    ?? /\b([\d,]+(?:\.\d+)?)\s+acres?\s+of\s+land\b/i.exec(text);
  const sections = [...text.matchAll(/\bSECTION\s+(?:NO\.?\s*)?(\d+)/gi)].map((m) => m[1]);
  const blocks = [...text.matchAll(/\bBLOCK\s+(?:NO\.?\s*)?([A-Z0-9-]+)/gi)].map((m) => m[1].toUpperCase());
  const lots = [...text.matchAll(/\bLOTS?\s+(?:NO\.?\s*)?(\d+[A-Z]?)/gi)].map((m) => m[1].toUpperCase());
  const quarters = [...text.matchAll(/\b(NE|NW|SE|SW)\s*\/?\s*4\b|\b(north|south)\s*(east|west)\s+quarter\b/gi)]
    .map((m) => (m[1] ? `${m[1].toUpperCase()}/4` : `${m[2]![0]}${m[3]![0]}/4`.toUpperCase()));
  return {
    abstracts: uniq(abstracts), surveys: uniq(surveys), county,
    state,
    statedAcres: acres ? num(acres[1]) : null,
    sections: uniq(sections), blocks: uniq(blocks), lots: uniq(lots), quarters: uniq(quarters),
  };
}

/** Shoelace area of the local polygon in acres (auto-closes the ring). */
export function polygonAcres(points: [number, number][]): number {
  if (points.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2) / 43560;
}

const DEG = Math.PI / 180;

/**
 * Shared back half of every parse path: walk the resolvable calls into local
 * points, judge closure, compute acreage, and emit the standard warnings.
 * Rules parsing and AI extraction differ only in how `calls` were produced —
 * the geometry math is always this deterministic code, never model output.
 */
function assembleTract(args: {
  pobText: string | null;
  calls: TractCall[];
  refs: TractRefs;
  warnings: string[];
  unresolved: string[];
  source: "rules" | "ai";
  confidence: number | null;
  assumptions: string[];
}): ParsedTract {
  const { pobText, calls, refs, warnings, unresolved, source, confidence, assumptions } = args;
  const points: [number, number][] = [[0, 0]];
  let x = 0, y = 0;
  for (const c of calls) {
    if (c.azimuth === null || c.distanceFt === null) continue;
    x += c.distanceFt * Math.sin(c.azimuth * DEG);
    y += c.distanceFt * Math.cos(c.azimuth * DEG);
    points.push([x, y]);
  }

  let closure: TractClosure | null = null;
  if (points.length >= 3) {
    const [lx, ly] = points[points.length - 1];
    const gap = Math.hypot(lx, ly);
    let perim = 0;
    for (let i = 1; i < points.length; i++) perim += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    const closes = gap <= Math.max(1, perim / 200);
    closure = { closes, gapFt: Math.round(gap * 100) / 100, precision: gap > 0.01 ? Math.round(perim / gap) : 1_000_000 };
    if (!closes) warnings.push(`Boundary does not close: ${closure.gapFt.toLocaleString()} ft gap back to the POB (precision 1:${closure.precision}). A call may be missing or misread.`);
    if (closes && gap < perim / 10000 && points.length > 3) points.pop(); // final call landed on the POB
  }

  const ok = points.length >= 3;
  if (!ok) {
    if (calls.length === 0 && (refs.lots.length || refs.blocks.length || refs.sections.length)) {
      warnings.push("No metes-and-bounds calls found — this reads as a lot/block or section reference. Plat/section geometry cannot be reconstructed automatically; review and map manually.");
    } else if (calls.length === 0) {
      warnings.push("No boundary calls (“THENCE…”) found in this description.");
    } else {
      warnings.push("Fewer than 3 resolvable calls — not enough to form a polygon.");
    }
  }
  const computedAcres = ok ? Math.round(polygonAcres(points) * 1000) / 1000 : null;
  if (ok && refs.statedAcres && computedAcres) {
    const diff = Math.abs(computedAcres - refs.statedAcres) / refs.statedAcres;
    if (diff > 0.05) warnings.push(`Computed acreage (${computedAcres.toLocaleString()} ac) differs from the stated ${refs.statedAcres.toLocaleString()} ac by ${(diff * 100).toFixed(1)}% — check the flagged calls.`);
  }

  return { ok, pobText, calls, points, refs, closure, computedAcres, warnings, unresolved, source, confidence, assumptions };
}

/**
 * Deterministic confidence 0–100 from measurable parse quality. Every input is
 * observable (nothing model-reported): POB found, share of calls resolved,
 * closure quality, acreage agreement, and how many interpretive assumptions
 * were needed. A description with no polygon caps low; a clean, closing,
 * acreage-matching boundary with zero assumptions scores at the top.
 */
export function scoreConfidence(p: Pick<ParsedTract, "ok" | "pobText" | "calls" | "closure" | "computedAcres" | "refs" | "assumptions" | "unresolved">): number {
  let score = 100;
  if (!p.pobText) score -= 20;
  const total = p.calls.length;
  const unresolvedN = p.calls.filter((c) => c.azimuth === null || c.distanceFt === null).length;
  if (total > 0) score -= Math.round(55 * (unresolvedN / total));
  // Resolved-but-flagged calls (curve approximations etc.) cost a little each.
  const flagged = p.calls.filter((c) => c.issue && c.azimuth !== null && c.distanceFt !== null).length;
  score -= Math.min(15, flagged * 4);
  score -= Math.min(12, (p.assumptions?.length ?? 0) * 3);
  if (p.closure) {
    if (!p.closure.closes) score -= 20;
    else if (p.closure.precision < 5000) score -= 5;
  }
  if (p.computedAcres != null && p.refs.statedAcres) {
    const diff = Math.abs(p.computedAcres - p.refs.statedAcres) / p.refs.statedAcres;
    if (diff > 0.05) score -= 10;
  }
  if (!p.ok) score = Math.min(score, 20);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function parseTexas(text: string): ParsedTract {
  const clean = text.replace(/\s+/g, " ").trim();
  const warnings: string[] = [];
  const unresolved: string[] = [];
  const assumptions: string[] = [];

  // POB: the clause that starts the boundary walk.
  const pobMatch = /\b((?:BEGINNING|COMMENCING)\s+(?:at|on|in)\b[^;]*?)(?=\s*[;]|\s+THENCE\b|$)/i.exec(clean);
  let pobText = pobMatch ? pobMatch[1].trim() : null;
  if (!pobText) warnings.push("No Point of Beginning (“BEGINNING at…”) found — POB placed at the first call.");

  // Boundary calls: everything between successive THENCE keywords.
  let clauses = clean.split(/\bTHENCE\b/i).slice(1).map((c) => c.replace(/^[\s,:;]+/, "").trim()).filter(Boolean);

  // Commencement tie-line: "COMMENCING at … THENCE … to the POINT OF
  // BEGINNING; THENCE …". The calls up to and including the clause that
  // arrives at the POB locate it — they are not part of the boundary walk,
  // but they ARE kept (tieCalls) so the anchorer can apply them as a vector
  // from a resolved survey/abstract corner to compute the true POB.
  const tieCalls: TractCall[] = [];
  if (/\bCOMMENC/i.test(clean)) {
    const pobIdx = clauses.findIndex((c) => /(POINT|PLACE|TRUE\s+POINT)\s+OF\s+BEGINNING/i.test(c));
    if (pobIdx >= 0 && pobIdx < clauses.length - 1) {
      const tie = clauses.slice(0, pobIdx + 1);
      clauses = clauses.slice(pobIdx + 1);
      for (const [i, clause] of tie.entries()) {
        const b = parseBearing(clause);
        const d = parseDistance(clause);
        tieCalls.push({
          seq: i + 1, raw: clause.length > 160 ? clause.slice(0, 157) + "…" : clause,
          azimuth: b?.azimuth ?? null, bearing: b?.display ?? null,
          distanceFt: d ? Math.round(d.feet * 100) / 100 : null, distanceRaw: d?.raw ?? null,
          curve: /\bcurve\b/i.test(clause), issue: b && d ? null : "Tie-line call could not be fully read.",
        });
      }
      pobText = `${pobText ?? "COMMENCING clause"} … ${tie[tie.length - 1]}`.slice(0, 400);
      assumptions.push(`Read the first ${tie.length} call(s) as a commencement tie-line locating the POB — they are excluded from the boundary walk.`);
    } else if (pobIdx < 0) {
      warnings.push("“COMMENCING” found but no “POINT OF BEGINNING” — all calls treated as the boundary walk; verify the POB.");
    }
  }

  // Corner reference: "BEGINNING/COMMENCING at the northeast corner of said
  // survey / the JOHN DOE SURVEY / Abstract No. 123". Resolving this against
  // the abstract's actual polygon gives a precise POB with no manual placement.
  const cornerM = /\b(north\s*east|north\s*west|south\s*east|south\s*west|NE|NW|SE|SW)\s+corner\b/i.exec(pobText ?? "");
  const pobCorner = cornerM
    ? (cornerM[1].replace(/\s+/g, "").toUpperCase().replace("NORTHEAST", "NE").replace("NORTHWEST", "NW").replace("SOUTHEAST", "SE").replace("SOUTHWEST", "SW") as "NE" | "NW" | "SE" | "SW")
    : null;

  const calls: TractCall[] = [];
  let seq = 0;
  let prevBearing: { azimuth: number; display: string } | null = null;

  for (const clause of clauses) {
    seq += 1;
    const short = clause.length > 160 ? clause.slice(0, 157) + "…" : clause;
    const isCurve = /\bcurve\b/i.test(clause);
    let bearing = parseBearing(clause);
    let dist = parseDistance(clause);
    let issue: string | null = null;

    if (isCurve) {
      // Approximate a curve by its long chord when one is given; otherwise flag.
      const chord = /\b(?:long\s+)?chord\b(.{0,120})/i.exec(clause);
      if (chord) {
        bearing = parseBearing(chord[1]) ?? bearing;
        dist = parseDistance(chord[1]) ?? dist;
        if (bearing && dist) issue = "Curve approximated by its long chord.";
      } else if (bearing && dist) {
        issue = "Curve without an explicit long chord — its stated bearing/distance used as the chord.";
      }
      if (!bearing || !dist) issue = "Curve call without a resolvable long chord — segment skipped.";
    } else if (!bearing && dist && prevBearing && /\b(same\s+(course|bearing)|continuing)\b/i.test(clause)) {
      // "THENCE continuing on the same course, 300 feet" — reuse the prior bearing.
      bearing = prevBearing;
      issue = null;
      assumptions.push(`Call ${seq}: read “same course/continuing” as repeating the previous bearing (${prevBearing.display}).`);
    } else if (!bearing && !dist) issue = "No bearing or distance recognized in this call.";
    else if (!bearing) issue = "Distance found but the bearing could not be read.";
    else if (!dist) issue = "Bearing found but the distance could not be read.";

    if (bearing && !isCurve) prevBearing = bearing;

    // Calls missing either component are excluded from the walk entirely
    // (assembleTract skips null azimuth/distance) and flagged for review.
    if (!bearing || !dist) unresolved.push(short);
    calls.push({
      seq, raw: short,
      azimuth: bearing?.azimuth ?? null, bearing: bearing?.display ?? null,
      distanceFt: dist ? Math.round(dist.feet * 100) / 100 : null, distanceRaw: dist?.raw ?? null,
      curve: isCurve, issue,
    });
  }

  const parsed = assembleTract({
    pobText, calls, refs: extractRefs(clean, "TX"), warnings, unresolved,
    source: "rules", confidence: null, assumptions,
  });
  parsed.pobCorner = pobCorner;
  parsed.tieCalls = tieCalls;
  parsed.confidence = scoreConfidence(parsed);
  return parsed;
}

/**
 * Apply commencement tie-line calls as a vector from an origin (a resolved
 * survey/abstract corner) to the POB. Returns null if any tie call is
 * unresolvable — a partial tie must never silently misplace the POB.
 */
export function applyTieLine(origin: { lon: number; lat: number }, tie: Pick<TractCall, "azimuth" | "distanceFt">[]): { lon: number; lat: number } | null {
  let dxFt = 0, dyFt = 0;
  for (const t of tie) {
    if (t.azimuth === null || t.distanceFt === null) return null;
    dxFt += t.distanceFt * Math.sin(t.azimuth * DEG);
    dyFt += t.distanceFt * Math.cos(t.azimuth * DEG);
  }
  const cosLat = Math.cos(origin.lat * DEG);
  return {
    lon: origin.lon + (dxFt * M_PER_FT) / (M_PER_DEG_LAT * cosLat),
    lat: origin.lat + (dyFt * M_PER_FT) / M_PER_DEG_LAT,
  };
}

// ---------------------------------------------------------------------------
// State registry. Add new grammars here; unknown states fall back to the Texas
// metes-and-bounds reader (the general grammar travels reasonably well).
const PARSERS: Record<string, (text: string) => ParsedTract> = { TX: parseTexas };

export function parseTract(text: string, state = "TX"): ParsedTract {
  const parser = PARSERS[state.toUpperCase()] ?? parseTexas;
  const parsed = parser(text);
  if (!PARSERS[state.toUpperCase()] && state.toUpperCase() !== "TX") {
    parsed.warnings.unshift(`No ${state.toUpperCase()}-specific parser yet — interpreted with the Texas metes-and-bounds grammar.`);
  }
  parsed.refs.state = state.toUpperCase();
  return parsed;
}

// ---------------------------------------------------------------------------
// Anchoring: local feet → GeoJSON around a POB lon/lat.

const M_PER_FT = 0.3048;
const M_PER_DEG_LAT = 111_320;

/** Convert the local-feet ring to lon/lat around the anchored POB. */
export function anchorPolygon(points: [number, number][], pob: { lon: number; lat: number }): GeoJSONPolygon {
  const cosLat = Math.cos(pob.lat * DEG);
  const ring: [number, number][] = points.map(([fx, fy]) => [
    pob.lon + (fx * M_PER_FT) / (M_PER_DEG_LAT * cosLat),
    pob.lat + (fy * M_PER_FT) / M_PER_DEG_LAT,
  ]);
  ring.push(ring[0]); // close
  return { type: "Polygon", coordinates: [ring] };
}

export interface GeoJSONPolygon { type: "Polygon"; coordinates: [number, number][][] }
