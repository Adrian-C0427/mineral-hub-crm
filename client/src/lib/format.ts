export function money(n: number | null | undefined, opts: { blank?: string; cents?: boolean } = {}): string {
  if (n == null) return opts.blank ?? "—";
  // cents: exact two-decimal display (expenses and anywhere entered amounts
  // must round-trip verbatim); default stays whole-dollar for big-figure UI.
  return n.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
}

/**
 * Compact money ("$93.7K", "−$1.2M") — the one implementation behind every
 * page's short-figure style, so all of them put the sign before the "$" and
 * roll 999,999 over to "$1M" instead of printing "$1000K".
 *   kFrom   — smallest figure shown in K (smaller ones use `small`)
 *   kDigits — decimals for a K figure (may depend on its size)
 *   trim    — drop trailing zeros ("$12K" rather than "$12.0K")
 */
export function compactMoney(v: number, opts: {
  mDigits?: number; kDigits?: (abs: number) => number; kFrom?: number; trim?: boolean; minus?: string; small?: (v: number) => string;
} = {}): string {
  const { mDigits = 1, kDigits = () => 1, kFrom = 1000, trim = true, minus = "-", small } = opts;
  const a = Math.abs(v);
  const fixed = (x: number, d: number) => (trim ? String(Number(x.toFixed(d))) : x.toFixed(d));
  const sign = v < 0 && a >= 0.5 ? minus : "";
  if (a >= kFrom) {
    const kd = kDigits(a);
    if (a < 1e6 && Number((a / 1000).toFixed(kd)) < 1000) return `${sign}$${fixed(a / 1000, kd)}K`;
    return `${sign}$${fixed(a / 1e6, mDigits)}M`;
  }
  return small ? small(v) : `${sign}$${Math.round(a)}`;
}

export function num(n: number | null | undefined, suffix = ""): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US") + suffix;
}

/** Acreage (NMA / NRA): up to the 4 decimals NMA ↔ NRA is calculated to. */
export function acres(n: number | null | undefined, suffix = ""): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 }) + suffix;
}

/** A ratio (0.333…) as a percent, to one decimal when it has one ("33.3%", "50%"). */
export function pct(rate: number | null | undefined): string {
  if (rate == null) return "—";
  return `${Number((rate * 100).toFixed(1))}%`;
}

/** A decimal interest (NRI / WI, 0.00390625) as a percent keeping its
 *  precision — up to 6 places ("0.390625%", "18.75%"). */
export function interestPct(decimal: number | null | undefined): string {
  if (decimal == null) return "—";
  return `${Number((decimal * 100).toFixed(6))}%`;
}

/**
 * Date-ONLY business fields (contract dates, closings, follow-ups, lease
 * expirations). These are stored as calendar dates at UTC midnight, so they
 * must render in UTC — local rendering would shift them a day for anyone
 * west of Greenwich.
 */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * TIMESTAMPS (createdAt, updatedAt, last-active, uploads). Real moments in
 * time render in the user's local zone — with the UTC rendering above,
 * anything created after ~6-7pm US Central displayed as tomorrow.
 */
export function fmtDateLocal(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** Timestamp with time-of-day, local zone — for runs, syncs, notifications. */
export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function toInputDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function prettyStage(stage: string): string {
  return stage.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}

export function prettyEnum(v: string): string {
  return v.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}

export function daysBetween(target: string | Date | null | undefined): number | null {
  if (!target) return null;
  const t = typeof target === "string" ? new Date(target) : target;
  const MS = 86400000;
  const a = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const now = new Date();
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((a - b) / MS);
}

/**
 * County-record document types arrive as enums ("OG_LEASE") or fused camel
 * case ("QuitclaimMineralDeed"). Render them like a landman would say them:
 * "O&G Lease", "Quitclaim Mineral Deed", "Mineral Conveyance".
 */
export function prettyDocType(v: string): string {
  const words = v.includes("_") ? v.split("_") : v.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
  return words
    .filter(Boolean)
    .map((w) => {
      const u = w.toUpperCase();
      if (u === "OG" || u === "O&G") return "O&G";
      if (u === "OF" || u === "AND" || u === "TO") return w.toLowerCase();
      return w[0].toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}
