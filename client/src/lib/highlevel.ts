/**
 * HighLevel integration card — wording and small calculations (pure, unit
 * tested in test/highlevel.test.ts). The server owns the sync; these only
 * turn GET /api/integrations/highlevel/status into plain sentences.
 */

export type HighLevelPhase = "preview" | "importing" | "live";

export interface HighLevelLastRun {
  at: string; ok: boolean; newMessages: number; updatedMessages: number; contactsFetched: number;
  summaries: number; ms: number; message: string;
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
    run.contactsFetched ? count(run.contactsFetched, "contact refreshed", "contacts refreshed") : null,
  ].filter(Boolean);
  return parts.length ? `Last check: ${parts.join(", ")}.` : null;
}
