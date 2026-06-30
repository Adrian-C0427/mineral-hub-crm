export function money(n: number | null | undefined, opts: { blank?: string } = {}): string {
  if (n == null) return opts.blank ?? "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function num(n: number | null | undefined, suffix = ""): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US") + suffix;
}

export function pct(rate: number | null | undefined): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
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
