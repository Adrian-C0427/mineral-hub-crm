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

export function num(n: number | null | undefined, suffix = ""): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US") + suffix;
}

export function pct(rate: number | null | undefined): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
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
