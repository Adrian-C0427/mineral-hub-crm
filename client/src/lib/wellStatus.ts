/**
 * The normalized well-status vocabulary every map surface speaks (Texas RRC
 * and Louisiana SONRIS wells alike). Mirrors server/src/domain/wellStatus.ts —
 * keep the two in step.
 */
export const WELL_STATUSES = [
  "Permitted", "Drilling", "Producing", "Shut-In", "Plugged", "Injection", "Disposal", "Other/Unknown",
] as const;
export type WellStatus = (typeof WELL_STATUSES)[number];

/** Map/legend color per status. */
export const STATUS_COLORS: Record<WellStatus, string> = {
  Permitted: "#3b82f6",
  Drilling: "#dc2626",
  Producing: "#22c55e",
  "Shut-In": "#f59e0b",
  Plugged: "#6b7280",
  Injection: "#7c3aed",
  Disposal: "#c026d3",
  "Other/Unknown": "#a8a29e",
};

/** Pre-2026-10 map statuses → the normalized set (saved filter presets may still hold them). */
export const LEGACY_STATUS: Record<string, WellStatus> = {
  "Dry Hole": "Plugged",
  Active: "Injection",
  "Canceled/Abandoned": "Other/Unknown",
  "Surface location": "Other/Unknown",
  Unknown: "Other/Unknown",
};

export function normalizeWellStatus(s: string): string {
  return (WELL_STATUSES as readonly string[]).includes(s) ? s : LEGACY_STATUS[s] ?? s;
}

/** Status-flag code → what it means, in plain words. */
export const STATUS_FLAG_LABEL: Record<string, string> = {
  "needs-investigation": "Needs investigation",
  "no-recent-production": "No recent production reported",
  "map-only": "From the RRC map symbol only",
  unverified: "Not fully confirmed",
  "retired-in-source": "No longer in RRC's data",
};

/** Where a status (or other value) came from — RRC source ids → names. */
export const SOURCE_LABEL: Record<string, string> = {
  "wellbore-query": "RRC Wellbore Query",
  permit: "RRC drilling permit",
  permits: "RRC drilling permits",
  uic: "RRC injection (UIC) permit",
  "map-symbol": "RRC map symbol",
  "gis-wells": "RRC well layers",
  "wellbore-master": "RRC wellbore master",
  production: "RRC production reports",
  "rrc-refresh": "RRC data refresh",
};

/** Text tone for a status in tables ("Producing" green, "Shut-In" amber…). */
export function statusTone(s: string | null | undefined): "success" | "warn" | "danger" | "neutral" {
  switch (normalizeWellStatus(s ?? "")) {
    case "Producing": return "success";
    case "Shut-In": case "Drilling": return "warn";
    case "Plugged": return "neutral";
    default: return "neutral";
  }
}
