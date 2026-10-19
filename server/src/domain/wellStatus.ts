/**
 * Well status — ONE normalized vocabulary for every well the map, filters,
 * Well Analysis and Research show (Texas RRC and Louisiana SONRIS alike), and
 * the rules that derive a Texas well's status from RRC's authoritative
 * records. Pure: the offline builder (scripts/buildRrcRefresh.ts) runs these
 * over the raw RRC files and bundles the results; nothing here touches a DB.
 *
 * Normalized statuses (the map legend, the Well Status filter):
 *   Permitted · Drilling · Producing · Shut-In · Plugged · Injection ·
 *   Disposal · Other/Unknown
 * The finer administrative distinction RRC records (temporarily abandoned,
 * 14(b)(2) inactive, dry hole, expired permit, water supply…) is kept beside
 * it as `detail`, never folded away.
 *
 * Source priority (newest, most specific first):
 *   1. RRC Wellbore Query (OG_WELLBORE_EWA) rows ON the proration schedule —
 *      RRC's current administrative well type per completion, plus the
 *      wellbore's inactive (shut-in) date and 14(b)(2) flag.
 *   2. A plugging date (W-3) on any Wellbore Query row.
 *   3. The drilling permit (daf802): approval, spud date, expiry, cancellation.
 *   4. The UIC permit (uif700): disposal vs enhanced-recovery injection.
 *   5. The RRC map symbol (well layers, SYMNUM) — only as a tie-breaker, or
 *      as the sole evidence for wells RRC never gave an API number.
 * Production (PDQ) is NEVER used to call a well Producing. It only raises an
 * uncertainty flag when RRC's schedule says producing but no production has
 * been reported for a year.
 */

export const WELL_STATUSES = [
  "Permitted", "Drilling", "Producing", "Shut-In", "Plugged", "Injection", "Disposal", "Other/Unknown",
] as const;
export type WellStatus = (typeof WELL_STATUSES)[number];

/** Lower-case slug per status (rrc.wells.category — CSS classes, legacy readers). */
export const STATUS_CATEGORY: Record<WellStatus, string> = {
  Permitted: "permitted", Drilling: "drilling", Producing: "producing", "Shut-In": "shutin",
  Plugged: "plugged", Injection: "injection", Disposal: "disposal", "Other/Unknown": "other",
};

/**
 * The pre-2026-10 map vocabulary (tools/rrc/build_wells.py SYM statuses) →
 * the normalized status. Used to migrate saved filter presets and anything
 * else still holding an old value. "Surface location" (a horizontal well's
 * surface spot) had no status at all; it maps to Other/Unknown here only as a
 * last resort — the builder derives the real status from the wellbore.
 */
export const LEGACY_STATUS: Record<string, WellStatus> = {
  Producing: "Producing",
  "Shut-In": "Shut-In",
  Plugged: "Plugged",
  Permitted: "Permitted",
  "Dry Hole": "Plugged",
  Active: "Injection",
  "Canceled/Abandoned": "Other/Unknown",
  "Surface location": "Other/Unknown",
  Unknown: "Other/Unknown",
};

/** Normalized status of any status string (new or legacy); Other/Unknown when unrecognized. */
export function normalizeStatus(s: string | null | undefined): WellStatus {
  const t = (s ?? "").trim();
  if ((WELL_STATUSES as readonly string[]).includes(t)) return t as WellStatus;
  return LEGACY_STATUS[t] ?? "Other/Unknown";
}

// ---------------------------------------------------------------------------
// RRC map symbols (well layer SYMNUM)
// ---------------------------------------------------------------------------

export interface SymbolInfo { label: string; type: WellType; status: WellStatus; detail: string | null }

/** Product / service type — the Well Type filter. Wellbore profile is separate (`profile`). */
export type WellType = "Oil" | "Gas" | "Oil/Gas" | "Injection/Disposal" | "Water Supply" | "Dry Hole" | "Location" | "Unknown";

/**
 * SYMNUM → what the RRC map symbol says. `status` is what the symbol alone
 * would imply; derivations below only fall back to it where no record exists.
 * 86/87 are surface spots of horizontal/directional wells — their real status
 * rides on the bottom-hole record (well layer "b"), never on the surface spot.
 */
export const RRC_SYMBOLS: Record<number, SymbolInfo> = {
  2: { label: "Permitted Location", type: "Location", status: "Permitted", detail: "Permitted location" },
  3: { label: "Dry Hole", type: "Dry Hole", status: "Plugged", detail: "Dry hole" },
  4: { label: "Oil", type: "Oil", status: "Producing", detail: null },
  5: { label: "Gas", type: "Gas", status: "Producing", detail: null },
  6: { label: "Oil/Gas", type: "Oil/Gas", status: "Producing", detail: null },
  7: { label: "Plugged Oil", type: "Oil", status: "Plugged", detail: null },
  8: { label: "Plugged Gas", type: "Gas", status: "Plugged", detail: null },
  9: { label: "Canceled/Abandoned Location", type: "Location", status: "Other/Unknown", detail: "Canceled or abandoned location" },
  10: { label: "Plugged Oil/Gas", type: "Oil/Gas", status: "Plugged", detail: null },
  11: { label: "Injection/Disposal", type: "Injection/Disposal", status: "Injection", detail: null },
  19: { label: "Shut-In (Oil)", type: "Oil", status: "Shut-In", detail: null },
  20: { label: "Shut-In (Gas)", type: "Gas", status: "Shut-In", detail: null },
  21: { label: "Injection/Disposal from Oil", type: "Injection/Disposal", status: "Injection", detail: null },
  22: { label: "Well", type: "Location", status: "Other/Unknown", detail: null },
  23: { label: "Injection/Disposal from Oil/Gas", type: "Injection/Disposal", status: "Injection", detail: null },
  74: { label: "Water Supply", type: "Water Supply", status: "Other/Unknown", detail: "Water supply well" },
  75: { label: "Water Supply from Oil", type: "Water Supply", status: "Other/Unknown", detail: "Water supply well" },
  76: { label: "Water Supply from Gas", type: "Water Supply", status: "Other/Unknown", detail: "Water supply well" },
  86: { label: "Horizontal Well (Surface Loc.)", type: "Unknown", status: "Other/Unknown", detail: null },
  87: { label: "Directional/Sidetrack (Surface Loc.)", type: "Unknown", status: "Other/Unknown", detail: null },
};
export const symbolInfo = (sym: number | null | undefined): SymbolInfo | null => (sym != null ? RRC_SYMBOLS[sym] ?? null : null);
/** Symbols that by themselves mean the hole is plugged (dry holes are plugged by rule). */
const PLUGGED_SYMBOLS = new Set([3, 7, 8, 10]);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One Wellbore Query row (a completion/lease record on the wellbore), already trimmed. */
export interface WellboreQueryRow {
  onSchedule: boolean;
  /** RRC's administrative well type ("PRODUCING", "SHUT IN", "TEMP ABANDONED"…); "" when off schedule. */
  wellType: string;
  oilGas: "O" | "G" | "";
  district: string;
  leaseNo: string;
  /** Wellbore inactive since (YYYYMM), from RRC's inactive-well tracking; null when active. */
  wbShutIn: string | null;
  /** 14(b)(2) inactive-well extension flag. */
  b14b2: boolean;
  plugDate: string | null;       // YYYYMMDD
  completionDate: string | null; // YYYYMMDD
  w2g1Date: string | null;       // YYYYMMDD
}

export interface PermitFacts {
  permitNo: string;
  issued: string | null;    // YYYYMMDD
  spud: string | null;      // YYYYMMDD
  expires: string | null;   // YYYYMMDD
  cancelled: string | null; // YYYYMMDD
  /** DA-CANCELLED-FLAG: 'P' permit cancelled, 'F' filing cancelled, '' none. */
  cancelledFlag: string;
  horizontal: boolean;
}

export type InjectionKind = "Disposal" | "Injection";
export interface UicFacts { kind: InjectionKind; detail: string }

export interface StatusInputs {
  /** RRC map symbol for this wellbore (the bottom-hole record's for 86/87 surfaces). */
  symbol: number | null;
  hasApi: boolean;
  ewa: readonly WellboreQueryRow[];
  permit: PermitFacts | null;
  uic: UicFacts | null;
  /** Newest month with reported production on any of the wellbore's on-schedule leases (YYYYMM). */
  lastProdYm: string | null;
  /** Newest production month RRC has published (PDQ), YYYYMM. */
  prodNewestYm: string;
  /** Snapshot date the rules are evaluated at (YYYYMMDD) — permit expiry, drilling window. */
  asOf: string;
}

export type StatusFlag =
  | "needs-investigation"  // records contradict or leave the status undetermined
  | "no-recent-production" // schedule says producing, no production reported for 12+ months
  | "map-only"             // no RRC record beyond the map symbol (often: no API number)
  | "unverified";          // a reasonable classification the records don't fully confirm

export type StatusSource = "wellbore-query" | "permit" | "uic" | "map-symbol";

export interface DerivedStatus {
  status: WellStatus;
  /** RRC's finer wording: "Temporarily abandoned", "Dry hole", "Permit expired 2014-03-01"… */
  detail: string | null;
  flag: StatusFlag | null;
  /** Plain-language reason for the flag (or for a non-obvious classification). */
  note: string | null;
  source: StatusSource;
  /** RRC's own administrative well type(s) on the schedule, verbatim ("PRODUCING, SWR-10-WELL"). */
  adminStatus: string | null;
  /** Date the status took effect where RRC records one (YYYY-MM-DD) — plug, shut-in, spud, issue. */
  since: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * "20160810" → "2016-08-10"; "201704" → "2017-04-01"; null for blank/zero/
 * invalid. RRC records partial precision as "00" month/day — clamped to the
 * first (and a day past month-end to the last day).
 */
export function rrcIsoDate(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  if (/^\d{6}$/.test(t)) return rrcIsoDate(`${t}01`);
  if (!/^\d{8}$/.test(t) || /^0+$/.test(t)) return null;
  const y = Number(t.slice(0, 4));
  if (y < 1850 || y > 2100) return null;
  const m = Math.min(Math.max(Number(t.slice(4, 6)), 1), 12);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(Math.max(Number(t.slice(6, 8)), 1), lastDay);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** YYYYMM shifted by n months. */
export function shiftYm(ym: string, n: number): string {
  const total = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1 + n;
  return `${Math.floor(total / 12)}${String((total % 12) + 1).padStart(2, "0")}`;
}

/** YYYYMMDD shifted by whole months (day clamped to 28 — window math only). */
function shiftYmd(ymd: string, months: number): string {
  return `${shiftYm(ymd.slice(0, 6), months)}${String(Math.min(Number(ymd.slice(6, 8)) || 1, 28)).padStart(2, "0")}`;
}

const ymLabel = (ym: string) => `${ym.slice(0, 4)}-${ym.slice(4, 6)}`;
const maxOf = (vals: readonly (string | null)[]): string | null =>
  vals.reduce<string | null>((m, v) => (v && (!m || v > m) ? v : m), null);

/** Schedule well types that keep a well producing (SWR 10 = commingled downhole with a producing completion). */
const PRODUCING_TYPES = new Set(["PRODUCING", "SWR-10-WELL", "PROD FACTOR WELL"]);
/** Schedule well types RRC uses for a completed well that is not producing. */
const SHUT_IN_TYPES: Record<string, string> = {
  "SHUT IN": "Shut in",
  "SHUT IN-MULTI-COMPL": "Shut in (multiple completion)",
  "TEMP ABANDONED": "Temporarily abandoned",
  "NO PRODUCTION": "No production (RRC well type)",
  "NOT ELIGIBLE FOR ALLOWABLE": "Not eligible for allowable",
  "PARTIAL PLUG": "Partially plugged",
};
/** Storage / service injection types — injection, not disposal. */
const INJECTION_TYPES = new Set(["INJECTION", "GAS STRG-INJECTION", "LPG STORAGE", "GAS STRG-SALT FORMATION", "BRINE MINING"]);
/** Completed service wells that are none of the eight statuses. */
const OTHER_TYPES: Record<string, string> = {
  "WATER SUPPLY": "Water supply well",
  OBSERVATION: "Observation well",
  "DOMESTIC USE WELL": "Domestic use well",
  "GEOTHERMAL WELL": "Geothermal well",
  "OTHER TYPE SERVICE": "Service well",
  "GAS STRG-WITHDRAWAL": "Gas storage (withdrawal)",
  SEALED: "Sealed",
  ABANDONED: "Abandoned (no plugging record)",
};

/** How many months a spudded well may go without a completion report and still read as Drilling. */
export const DRILLING_WINDOW_MONTHS = 24;
/** Months without reported production before a scheduled "producing" well gets flagged. */
export const NO_PRODUCTION_FLAG_MONTHS = 12;

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Derive one wellbore's normalized status from RRC's records (see the header
 * for the source priority). Deterministic; every non-obvious outcome carries a
 * `note`, and anything the records leave open carries a `flag`.
 */
export function deriveWellStatus(i: StatusInputs): DerivedStatus {
  const sym = symbolInfo(i.symbol);
  const on = i.ewa.filter((r) => r.onSchedule);
  const plug = maxOf(i.ewa.map((r) => r.plugDate));
  const completion = maxOf(i.ewa.flatMap((r) => [r.completionDate, r.w2g1Date]));
  const mapPlugged = i.symbol != null && PLUGGED_SYMBOLS.has(i.symbol);

  // 1. On RRC's current proration schedule: the administrative well type rules.
  if (on.length) {
    const types = [...new Set(on.map((r) => r.wellType).filter(Boolean))].sort();
    const adminStatus = types.join(", ") || null;
    const base = { source: "wellbore-query" as const, adminStatus };
    const producingRows = on.filter((r) => PRODUCING_TYPES.has(r.wellType));
    const injection = types.find((t) => INJECTION_TYPES.has(t));

    if (injection && !producingRows.length) {
      if (injection !== "INJECTION") return { ...base, status: "Injection", detail: titleCase(injection), flag: null, note: null, since: null };
      if (i.uic) return { ...base, status: i.uic.kind, detail: i.uic.detail, flag: null, note: null, since: null, source: "uic" };
      return {
        ...base, status: "Injection", detail: null, flag: "unverified", since: null,
        note: "RRC lists this as an injection well but no UIC permit was found, so injection vs disposal is not confirmed.",
      };
    }

    if (producingRows.length) {
      // RRC's inactive-well tracking: a wellbore shut-in date means no
      // production for 12+ months even though the completion keeps its
      // PRODUCING classification on the schedule.
      const inactive = producingRows.every((r) => r.wbShutIn);
      if (inactive) {
        const since = maxOf(producingRows.map((r) => r.wbShutIn));
        const b14 = producingRows.some((r) => r.b14b2);
        return {
          ...base, status: "Shut-In",
          detail: `Inactive since ${since ? ymLabel(since) : "an unrecorded date"}${b14 ? " · 14(b)(2) extension" : ""}`,
          flag: null, since: rrcIsoDate(since),
          note: "RRC classifies the completion as producing but tracks the wellbore as inactive (no production for 12+ months).",
        };
      }
      const cutoff = shiftYm(i.prodNewestYm, -(NO_PRODUCTION_FLAG_MONTHS - 1));
      const stale = !i.lastProdYm || i.lastProdYm < cutoff;
      return {
        ...base, status: "Producing",
        detail: types.length > 1 ? `Schedule: ${adminStatus}` : null,
        flag: stale ? "no-recent-production" : null,
        note: stale
          ? (i.lastProdYm
            ? `On RRC's schedule as producing, but its lease last reported production in ${ymLabel(i.lastProdYm)}.`
            : "On RRC's schedule as producing, but no production is reported for its lease.")
          : null,
        since: null,
      };
    }

    const shutType = types.find((t) => t in SHUT_IN_TYPES);
    if (shutType) {
      const since = maxOf(on.map((r) => r.wbShutIn));
      const b14 = on.some((r) => r.b14b2);
      return {
        ...base, status: "Shut-In",
        detail: `${SHUT_IN_TYPES[shutType]}${since ? ` since ${ymLabel(since)}` : ""}${b14 ? " · 14(b)(2) extension" : ""}`,
        flag: null, note: null, since: rrcIsoDate(since),
      };
    }
    const otherType = types.find((t) => t in OTHER_TYPES);
    if (otherType) {
      return {
        ...base, status: "Other/Unknown", detail: OTHER_TYPES[otherType],
        flag: otherType === "ABANDONED" ? "needs-investigation" : null,
        note: otherType === "ABANDONED" ? "RRC's schedule lists the well as abandoned but no plugging report is on file." : null,
        since: null,
      };
    }
    return {
      ...base, status: "Other/Unknown", detail: adminStatus, flag: "needs-investigation", since: null,
      note: `On RRC's schedule with an unrecognized well type (${adminStatus ?? "blank"}).`,
    };
  }

  // 2. Plugged (W-3 on file).
  if (plug) {
    return {
      status: "Plugged", detail: i.symbol === 3 ? "Dry hole" : null, flag: null, note: null,
      source: "wellbore-query", adminStatus: null, since: rrcIsoDate(plug),
    };
  }

  // 3. Completed but off the schedule, with no plugging report.
  if (completion) {
    if (mapPlugged) {
      return {
        status: "Plugged", detail: sym?.detail ?? null, flag: "unverified", source: "map-symbol", adminStatus: null, since: null,
        note: "No plugging date in RRC's Wellbore Query; the RRC map shows the well as plugged.",
      };
    }
    return {
      status: "Other/Unknown", detail: "Off schedule, no plugging record", flag: "needs-investigation",
      source: "wellbore-query", adminStatus: null, since: null,
      note: `Completed ${completion.slice(0, 4)}, no longer on RRC's proration schedule, and no plugging report is on file.`,
    };
  }

  // 4. Never completed: the drilling permit says where it stands.
  const p = i.permit;
  if (p) {
    const base = { source: "permit" as const, adminStatus: null };
    const cancelled = !!(p.cancelled || p.cancelledFlag === "P" || p.cancelledFlag === "F");
    const expired = !p.spud && !!p.expires && p.expires < i.asOf;
    // An old permit that lapsed on paper doesn't mean nothing was drilled:
    // when RRC's map shows the hole plugged (or a dry hole), it was drilled.
    if ((cancelled || expired) && mapPlugged) {
      return {
        ...base, status: "Plugged", detail: sym?.detail ?? null, flag: "unverified", source: "map-symbol", since: null,
        note: `The RRC map shows the well plugged; its permit ${p.permitNo} ${cancelled ? "was cancelled" : "expired"} with no spud or completion on file.`,
      };
    }
    if (cancelled) {
      return { ...base, status: "Other/Unknown", detail: `Permit ${p.permitNo} cancelled${p.cancelled ? ` ${rrcIsoDate(p.cancelled)}` : ""}`, flag: null, note: null, since: rrcIsoDate(p.cancelled) };
    }
    if (p.spud) {
      if (p.spud >= shiftYmd(i.asOf, -DRILLING_WINDOW_MONTHS)) {
        return { ...base, status: "Drilling", detail: `Spudded ${rrcIsoDate(p.spud)} · completion not yet filed`, flag: null, note: null, since: rrcIsoDate(p.spud) };
      }
      if (mapPlugged) {
        return { ...base, status: "Plugged", detail: sym?.detail ?? null, flag: "unverified", source: "map-symbol", since: null, note: `Spudded ${rrcIsoDate(p.spud)}; no completion or plugging report on file; the RRC map shows it plugged.` };
      }
      return {
        ...base, status: "Other/Unknown", detail: `Spudded ${rrcIsoDate(p.spud)} · no completion filed`, flag: "needs-investigation", since: rrcIsoDate(p.spud),
        note: `Spudded more than ${DRILLING_WINDOW_MONTHS} months ago with no completion or plugging report on file.`,
      };
    }
    if (!p.expires || p.expires >= i.asOf) {
      return { ...base, status: "Permitted", detail: `Permit ${p.permitNo} approved ${rrcIsoDate(p.issued) ?? ""}`.trim(), flag: null, note: null, since: rrcIsoDate(p.issued) };
    }
    return { ...base, status: "Other/Unknown", detail: `Permit expired ${rrcIsoDate(p.expires)} · not drilled`, flag: null, note: null, since: rrcIsoDate(p.expires) };
  }

  // 5. Only the map symbol is left.
  return fromSymbolOnly(i.symbol, i.hasApi, i.ewa.length > 0);
}

/**
 * Status from the RRC map symbol alone — wells with no API number (common
 * for pre-1960s holes) or none of RRC's records. Symbols that say the hole is
 * plugged or shut in are taken at their word; symbols that claim the well is
 * active (oil/gas, injection, permitted location) can't be confirmed without a
 * record, so they read Other/Unknown with the symbol kept as the detail.
 */
export function fromSymbolOnly(symbol: number | null, hasApi: boolean, hasWellboreRecord = false): DerivedStatus {
  const sym = symbolInfo(symbol);
  const why = !hasApi
    ? "the well has no API number"
    : hasWellboreRecord
      ? "RRC's wellbore record for this API carries no completion, schedule, plugging or permit details"
      : "RRC has no wellbore, permit or plugging record for this API";
  const base = { source: "map-symbol" as const, adminStatus: null, since: null };
  if (!sym) return { ...base, status: "Other/Unknown", detail: null, flag: "map-only", note: `No RRC record: ${why}.` };
  if (sym.status === "Plugged" || sym.status === "Shut-In") {
    return { ...base, status: sym.status, detail: sym.detail, flag: "map-only", note: `From the RRC map symbol only (${why}).` };
  }
  return {
    ...base, status: "Other/Unknown", detail: `${sym.label} (RRC map symbol)`, flag: "map-only",
    note: `The RRC map symbol says "${sym.label}", which can't be confirmed: ${why}.`,
  };
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** UIC injection-type code (uif700 UIC-TYPE-INJ) → disposal vs injection. */
export function uicKind(code: string): UicFacts | null {
  switch (code.trim()) {
    case "1": return { kind: "Disposal", detail: "Disposal into a non-productive zone (W-14)" };
    case "2": return { kind: "Disposal", detail: "Disposal into a productive zone (H-1)" };
    case "3": return { kind: "Injection", detail: "Secondary/tertiary recovery" };
    case "4": return { kind: "Injection", detail: "Miscellaneous injection" };
    case "5": return { kind: "Injection", detail: "Liquid storage (salt formation)" };
    case "6": return { kind: "Injection", detail: "Gas storage (reservoir)" };
    case "7": return { kind: "Injection", detail: "Gas storage (salt formation)" };
    default: return null;
  }
}

/**
 * Product type of a wellbore: what its current (else most recent) completion
 * produces, else the map symbol's; service wells by status.
 */
export function deriveWellType(i: { status: WellStatus; ewa: readonly WellboreQueryRow[]; symbol: number | null; completed: boolean }): WellType {
  if (i.status === "Injection" || i.status === "Disposal") return "Injection/Disposal";
  const on = i.ewa.filter((r) => r.onSchedule);
  const codes = new Set((on.length ? on : i.ewa).map((r) => r.oilGas).filter(Boolean));
  const sym = symbolInfo(i.symbol);
  if (sym?.type === "Water Supply" || sym?.type === "Dry Hole") return sym.type;
  if (codes.size === 2) return "Oil/Gas";
  if (codes.has("O")) return "Oil";
  if (codes.has("G")) return "Gas";
  if (sym && sym.type !== "Unknown") return sym.type;
  return i.completed ? "Unknown" : "Location";
}

export type WellProfile = "Vertical" | "Horizontal" | "Directional";
/** Wellbore profile from the surface symbol (86/87), the bottom-hole STCODE (H1…/D1… codes) or the permit's horizontal flag. */
export function deriveProfile(surfaceSymbol: number | null, stcodes: readonly string[], permitHorizontal: boolean): WellProfile {
  if (surfaceSymbol === 86 || stcodes.some((s) => s.startsWith("H")) || permitHorizontal) return "Horizontal";
  if (surfaceSymbol === 87 || stcodes.some((s) => s.startsWith("D"))) return "Directional";
  return "Vertical";
}
