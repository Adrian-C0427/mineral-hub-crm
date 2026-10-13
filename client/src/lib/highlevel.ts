/**
 * HighLevel integration card — wording and small calculations (pure, unit
 * tested in test/highlevel.test.ts). The server owns the sync; these only
 * turn GET /api/integrations/highlevel/status into plain sentences.
 */

export type HighLevelPhase = "preview" | "importing" | "live";

export interface HighLevelLastRun {
  at: string; ok: boolean; newMessages: number; updatedMessages: number; contactsFetched: number;
  summaries: number; ms: number; message: string;
  opportunities?: number; stageMoves?: number; rescanned?: number;
}

/** GET /api/integrations/highlevel/status (server/src/services/highlevel/sync.ts). */
export interface HighLevelStatus {
  connected: boolean;
  status: "NOT_CONNECTED" | "CONNECTED" | "ERROR";
  locationId: string | null;
  locationName: string | null;
  phase: HighLevelPhase | null;
  preview: { texts: number; at: string } | null;
  imported: number;
  contacts: number;
  lastSyncAt: string | null;
  lastError: string | null;
  lastRun: HighLevelLastRun | null;
  responseWindowDays: number;
  storageEstimateMb: number | null;
  /** Optional read permissions the key lacks (e.g. "opportunities.readonly"). */
  missingScopes?: string[];
  /** "Re-read tags now" — the latest one, while running and after. */
  tagRefresh?: HighLevelTagRefresh | null;
  /** Mineral Hub's own SMS / Acquisition tags in HighLevel. */
  crmTags?: HighLevelCrmTags;
}

export interface HighLevelCrmTags {
  enabled: boolean; removing: boolean; working: boolean; pending: number; tagged: number;
  error: "permission" | null; lastWriteAt: string | null; written: number;
}

/** The tags Mineral Hub writes (mirrors server/src/domain/smsTags.ts). */
export const CRM_TAG_GROUPS: { label: string; tags: readonly string[] }[] = [
  { label: "Texts reached before the first reply (cumulative)", tags: ["SMS - Text 1 Sent", "SMS - Text 2 Sent", "SMS - Text 3 Sent", "SMS - Text 4+ Sent"] },
  { label: "The text their first real reply came after", tags: ["SMS - Responded - Text 1", "SMS - Responded - Text 2", "SMS - Responded - Text 3", "SMS - Responded - Text 4+"] },
  { label: "Where they stand in your minerals pipelines (one at a time)", tags: [
    "Acquisition - Interested", "Acquisition - Offer Made", "Acquisition - Offer Accepted", "Acquisition - Deal Created",
    "Acquisition - Deal Closed", "Acquisition - Not Interested", "Acquisition - Do Not Contact",
  ] },
];

/** The card line for Mineral Hub's tags in HighLevel, or null when they're off and nothing's happening. */
export function crmTagsText(t: HighLevelCrmTags | null | undefined): { text: string; warn: boolean } | null {
  if (!t) return null;
  if (t.error === "permission" && (t.enabled || t.removing)) {
    return { warn: true, text: "HighLevel refused to change tags — in XLeads, edit the “Mineral Hub CRM” Private Integration, add the contacts.write permission (the key stays the same), then press Sync now." };
  }
  if (t.removing) return { warn: false, text: `Removing Mineral Hub's tags from HighLevel: ${count(t.pending, "contact", "contacts")} left.` };
  if (!t.enabled) return null;
  if (t.working && t.pending > 0) return { warn: false, text: `Tagging contacts in HighLevel: ${count(t.pending, "contact", "contacts")} left to check.` };
  return { warn: false, text: `SMS & Acquisition tags on ${count(t.tagged, "contact", "contacts")} in HighLevel · kept in step with Reports ${HL_SYNC_EVERY}.` };
}

export interface HighLevelTagRefresh {
  running: boolean; startedAt: string; finishedAt: string | null; auto: boolean;
  total: number; done: number; changed: number; etaMinutes: number;
}

/** The card line for a tag re-read: progress while it runs, the outcome after. */
export function tagRefreshText(t: HighLevelTagRefresh | null | undefined, fmtWhen: (iso: string) => string): string | null {
  if (!t) return null;
  if (t.running) {
    const eta = t.etaMinutes > 0 ? ` · about ${count(t.etaMinutes, "minute", "minutes")} left` : "";
    return `Re-reading tags from HighLevel: ${t.done.toLocaleString("en-US")} of ${count(t.total, "contact", "contacts")}${eta}. Reports re-sort as it goes.`;
  }
  if (!t.finishedAt) return null;
  return `Tags re-read ${fmtWhen(t.finishedAt)} — ${t.changed === 0 ? "no contact's tags had changed" : `${count(t.changed, "contact's tags", "contacts' tags")} changed`}.`;
}

/** Mirrors RESPONSE_WINDOW_OPTIONS in server/src/domain/smsMetrics.ts. */
export const RESPONSE_WINDOW_CHOICES = [7, 14, 30, 60, 90] as const;
/** How often the card re-reads status while the first import runs. */
export const HL_POLL_MS = 10_000;
/** The live sync cadence (server: the 15-minute integration tick). */
export const HL_SYNC_EVERY = "every 15 minutes";

/** The permissions to tick on the Private Integration — nothing that can write. */
export const HL_SCOPES = [
  "contacts.readonly",
  "conversations.readonly",
  "conversations/message.readonly",
  "opportunities.readonly",
  "users.readonly",
  "locations.readonly",
  "locations/customFields.readonly",
  "locations/tags.readonly",
] as const;

const n = (v: number) => v.toLocaleString("en-US");

/** "about 3.9 MB" / "less than 0.1 MB". */
export function sizeText(mb: number | null): string | null {
  if (mb == null) return null;
  return mb < 0.1 ? "less than 0.1 MB" : `about ${mb.toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;
}

/** The preview sentence shown before anything is imported. */
export function previewText(texts: number, mb: number | null): string {
  const size = sizeText(mb);
  return `Found ${n(texts)} text${texts === 1 ? "" : "s"} in HighLevel${size ? ` (${size})` : ""}. Nothing has been imported yet.`;
}

/** Import progress 0–1 (imported ÷ the preview count; never shows 100% before it's done). */
export function importProgress(imported: number, total: number | null | undefined): number {
  if (!total || total <= 0) return 0;
  return Math.min(0.99, Math.max(0, imported / total));
}

/** "Importing… 2,000 of about 5,957 texts · 528 contacts". */
export function importingText(s: Pick<HighLevelStatus, "imported" | "contacts" | "preview">): string {
  const total = s.preview?.texts ?? 0;
  const of = total > s.imported ? ` of about ${n(total)}` : "";
  return `Importing… ${n(s.imported)}${of} texts · ${n(s.contacts)} contact${s.contacts === 1 ? "" : "s"}`;
}

/** "5,957 texts from 1,500 contacts". */
export function totalsText(s: Pick<HighLevelStatus, "imported" | "contacts">): string {
  return `${n(s.imported)} text${s.imported === 1 ? "" : "s"} from ${n(s.contacts)} contact${s.contacts === 1 ? "" : "s"}`;
}

const count = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

/**
 * One line about the most recent sync round, or null when there's nothing
 * worth saying (a quiet check, or an import whose progress line says it all).
 */
export function lastRunText(run: HighLevelLastRun | null, phase: HighLevelPhase | null): string | null {
  if (!run) return null;
  if (!run.ok) return `Last check didn't finish: ${run.message}`;
  if (phase !== "live") return null;
  const parts = [
    run.newMessages ? count(run.newMessages, "new text", "new texts") : null,
    run.updatedMessages ? count(run.updatedMessages, "delivery update", "delivery updates") : null,
    run.stageMoves ? count(run.stageMoves, "pipeline stage change", "pipeline stage changes") : null,
    run.contactsFetched ? count(run.contactsFetched, "contact refreshed", "contacts refreshed") : null,
  ].filter(Boolean);
  return parts.length ? `Last check: ${parts.join(", ")}.` : null;
}

/** The card's note when the key can't read something optional, or null. */
export function missingScopesText(scopes: readonly string[] | null | undefined): string | null {
  const s = scopes ?? [];
  if (!s.length) return null;
  const what = [
    s.includes("opportunities.readonly") ? "opportunities (offers and the funnel stay empty)" : null,
    s.includes("locations/tags.readonly") ? "the tag list (the Minerals filter only shows tags found on texted people)" : null,
  ].filter(Boolean);
  const named = what.length ? what.join(" or ") : s.join(", ");
  return `This key can't read ${named}. Use Replace key with a key that has ${s.join(" and ")} ticked.`;
}

// --- Minerals filter (Configure) ---------------------------------------------
// The server classifies (server/src/domain/smsScope.ts); these only edit the
// draft filter and word its preview.

/** The org's Minerals filter (server SmsScope). */
export interface SmsScope { mineralTags: string[]; realEstateTags: string[]; mineralPipelineIds: string[] }

/** POST /api/integrations/highlevel/scope-preview — texted people under a filter. */
export interface LineCounts { texted: number; minerals: number; realEstate: number; unclassified: number }

/** GET /api/integrations/highlevel/scope. */
export interface HighLevelScopeSettings {
  saved: boolean;
  scope: SmsScope;
  suggested: SmsScope;
  tags: { name: string; texted: number }[];
  pipelines: { id: string; name: string; texted: number }[];
  counts: LineCounts;
  /** The form's other settings as stored now (the page's integration list may be older). */
  pricePerSegment: number | null;
  responseWindowDays: number;
  crmTagsEnabled: boolean;
  notes: string;
}

export type TagLine = "minerals" | "realEstate" | "neither";

/** Mirrors normalizeTag in server/src/domain/smsScope.ts. */
export const normalizeTag = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

export function tagLine(scope: SmsScope, tag: string): TagLine {
  const k = normalizeTag(tag);
  if (scope.mineralTags.some((t) => normalizeTag(t) === k)) return "minerals";
  if (scope.realEstateTags.some((t) => normalizeTag(t) === k)) return "realEstate";
  return "neither";
}

/** The filter with `tag` moved to `line` (removed from the other list). */
export function setTagLine(scope: SmsScope, tag: string, line: TagLine): SmsScope {
  const k = normalizeTag(tag);
  const without = (list: string[]) => list.filter((t) => normalizeTag(t) !== k);
  return {
    ...scope,
    mineralTags: line === "minerals" ? [...without(scope.mineralTags), k] : without(scope.mineralTags),
    realEstateTags: line === "realEstate" ? [...without(scope.realEstateTags), k] : without(scope.realEstateTags),
  };
}

export function togglePipeline(scope: SmsScope, id: string, on: boolean): SmsScope {
  const rest = scope.mineralPipelineIds.filter((p) => p !== id);
  return { ...scope, mineralPipelineIds: on ? [...rest, id] : rest };
}

/** Tags matching the search box and the Minerals / Real estate / Neither view. */
export function filterTags<T extends { name: string }>(tags: readonly T[], scope: SmsScope, query: string, view: TagLine | "all"): T[] {
  const q = normalizeTag(query);
  return tags.filter((t) => (!q || normalizeTag(t.name).includes(q)) && (view === "all" || tagLine(scope, t.name) === view));
}

/** "Minerals 312 · Real estate 54 · Not classified 16 texted people". */
export function previewCountsText(c: LineCounts): string {
  return `Minerals ${n(c.minerals)} · Real estate ${n(c.realEstate)} · Not classified ${n(c.unclassified)} texted ${c.texted === 1 ? "person" : "people"}`;
}

/**
 * The price box → dollars per segment: "" = not set (null); a number from 0
 * to 1 with at most 6 decimals ("$0.0091" and "0,0091" are accepted); else
 * "invalid".
 */
export function parsePrice(input: string): number | null | "invalid" {
  const t = input.trim().replace(/^\$/, "").replace(",", ".").trim();
  if (!t) return null;
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return "invalid";
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0 || v > 1) return "invalid";
  return Math.round(v * 1_000_000) / 1_000_000;
}

/** The Configure form's settings besides the Minerals filter, as the form holds them. */
export interface ConfigureFields { price: string; windowDays: string; notes: string; crmTags: boolean }

/** Stored settings → form fields. */
export function configureFields(c: { pricePerSegment?: number | null; responseWindowDays?: number; notes?: string; crmTagsEnabled?: boolean }): ConfigureFields {
  return {
    price: c.pricePerSegment == null ? "" : String(c.pricePerSegment),
    windowDays: String(c.responseWindowDays ?? 30),
    notes: c.notes ?? "",
    crmTags: !!c.crmTagsEnabled,
  };
}

/**
 * The form opens with the page's (possibly older) settings; when the fresh
 * stored ones arrive they become its starting point, and every field the
 * admin hasn't edited yet shows them. An edit already made is kept.
 */
export function adoptStored(form: { loaded: ConfigureFields; now: ConfigureFields }, stored: ConfigureFields): { loaded: ConfigureFields; now: ConfigureFields } {
  const pick = <K extends keyof ConfigureFields>(k: K): ConfigureFields[K] => (form.now[k] === form.loaded[k] ? stored[k] : form.now[k]);
  return { loaded: stored, now: { price: pick("price"), windowDays: pick("windowDays"), notes: pick("notes"), crmTags: pick("crmTags") } };
}

/**
 * The settings to save: only what the admin changed from the starting point,
 * so a field they didn't touch never overwrites a value saved meanwhile in
 * another tab or by another admin. (The form checks the price before saving.)
 */
export function configureChanges(loaded: ConfigureFields, now: ConfigureFields): {
  pricePerSegment?: number | null; responseWindowDays?: number; notes?: string; crmTagsEnabled?: boolean;
} {
  const out: ReturnType<typeof configureChanges> = {};
  const price = parsePrice(now.price);
  if (price !== "invalid" && price !== parsePrice(loaded.price)) out.pricePerSegment = price;
  if (now.windowDays !== loaded.windowDays) out.responseWindowDays = Number(now.windowDays);
  if (now.notes !== loaded.notes) out.notes = now.notes;
  if (now.crmTags !== loaded.crmTags) out.crmTagsEnabled = now.crmTags;
  return out;
}
