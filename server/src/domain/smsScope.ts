/**
 * Which business a HighLevel contact belongs to, and what its phone tags say
 * about the number. One HighLevel account can carry minerals AND real-estate
 * texting; Reports counts minerals only by default, so every SMS figure goes
 * through classifyContact() with the org's saved scope (Settings →
 * Integrations → HighLevel → Minerals filter).
 *
 * Rule (in this order):
 *  1. In a minerals pipeline, or carrying any minerals tag → "minerals".
 *     Minerals wins over a real-estate tag: county / lease tags are only ever
 *     put on mineral owners, while a few generic tags overlap.
 *  2. Otherwise carrying any real-estate tag → "real_estate".
 *  3. Otherwise → "unclassified" (shown as its own count so gaps are visible).
 * Tags compare case- and whitespace-insensitively; HighLevel stores them
 * lower-case but the API has returned mixed case before.
 */

export type BusinessLine = "minerals" | "real_estate" | "unclassified";

export interface SmsScope {
  mineralTags: string[];
  realEstateTags: string[];
  /** HighLevel pipeline ids whose opportunities are minerals. */
  mineralPipelineIds: string[];
}

export const normalizeTag = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

/** A scope's lookup sets, built once per scope object (not once per contact). */
type CompiledScope = { minerals: Set<string>; realEstate: Set<string>; pipelines: Set<string> };
const compiled = new WeakMap<SmsScope, CompiledScope>();

function compileScope(scope: SmsScope): CompiledScope {
  let c = compiled.get(scope);
  if (!c) {
    c = {
      minerals: new Set(scope.mineralTags.map(normalizeTag)),
      realEstate: new Set(scope.realEstateTags.map(normalizeTag)),
      pipelines: new Set(scope.mineralPipelineIds),
    };
    compiled.set(scope, c);
  }
  return c;
}

export function classifyContact(tags: readonly string[], pipelineIds: readonly string[], scope: SmsScope): BusinessLine {
  // Callers classify thousands of contacts against one scope (up to 5000 tags a
  // side): rebuilding its Sets per contact made one preview O(contacts × tags).
  const { minerals, realEstate, pipelines } = compileScope(scope);
  if (pipelineIds.some((id) => pipelines.has(id))) return "minerals";
  const have = new Set(tags.map(normalizeTag));
  for (const t of have) if (minerals.has(t)) return "minerals";
  for (const t of have) if (realEstate.has(t)) return "real_estate";
  return "unclassified";
}

/**
 * Starting point for an org that hasn't saved a scope: county tags and
 * anything named "mineral…" are minerals, and so are pipelines with "mineral"
 * in the name. Nothing is assumed to be real estate. The admin reviews and
 * completes it in settings.
 */
export function suggestScope(allTags: readonly string[], pipelines: readonly { id: string; name: string }[]): SmsScope {
  return {
    mineralTags: allTags.filter((t) => /\bcounty$|mineral/i.test(normalizeTag(t))),
    realEstateTags: [],
    mineralPipelineIds: pipelines.filter((p) => /mineral/i.test(p.name)).map((p) => p.id),
  };
}

// --- Phone-list quality, from the tags XLeads' phone-rotation workflows set ---
// XLeads keeps up to three numbers on one contact and rotates through them;
// its workflows tag what happened to each number (wrong number-2 = phone 2
// reached someone else). These tags are cumulative — never removed.

export type PhoneTagKind = "wrongNumber" | "disconnected" | "landline" | "smsIncapable" | "exhausted" | "rotated";

const PHONE_TAG_RULES: [PhoneTagKind, RegExp][] = [
  ["wrongNumber", /^wrong number(-[1-9])?$/],
  ["disconnected", /^disconnected number(-[1-9])?$/],
  ["landline", /^landline$/],
  ["smsIncapable", /^sms incapable$/],
  ["exhausted", /^all numbers exhausted$/],
  // Moved on to a second or third number.
  ["rotated", /^switch phone \([23]\)$/],
];

/** Which phone-quality signals a contact's tags carry. */
export function phoneTagKinds(tags: readonly string[]): Set<PhoneTagKind> {
  const kinds = new Set<PhoneTagKind>();
  for (const raw of tags) {
    const t = normalizeTag(raw);
    for (const [kind, re] of PHONE_TAG_RULES) if (re.test(t)) kinds.add(kind);
  }
  return kinds;
}

/** SQL-friendly regular expressions for the same tags (Postgres `~`). */
export const PHONE_TAG_SQL: Record<PhoneTagKind, string> = Object.fromEntries(
  PHONE_TAG_RULES.map(([k, re]) => [k, re.source]),
) as Record<PhoneTagKind, string>;
