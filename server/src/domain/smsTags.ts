/**
 * The tags Mineral Hub writes onto HighLevel contacts (when the owner turns
 * it on). They are a convenience layer for filtering inside HighLevel — the
 * CRM's message history stays the source of truth, and every tag here is
 * DERIVED from it, so the tags always match Reports:
 *
 *  - "SMS - Text N Sent" (cumulative): the contact received at least N
 *    reached outreach texts before their first reply — the same `touches`
 *    Reports' "response after text #n" denominators use. Failed texts don't
 *    count.
 *  - "SMS - Responded - Text N": their first counted reply came after text N
 *    (summarizeContact outcome RESPONDED). Wrong-number replies and STOPs
 *    never earn it; replying again never changes it.
 *  - "Acquisition - …": ONE tag for where the contact stands in the minerals
 *    pipelines (Under Contract = Deal Created), from the furthest open or won
 *    opportunity; Not Interested when every one is dead/lost; Do Not Contact
 *    when they opted out (STOP) or HighLevel's SMS do-not-disturb is on and no
 *    offer is in play.
 *
 * Only tags in CRM_TAGS are ever added or removed; every other tag on the
 * contact is left alone.
 */
import type { FunnelStep } from "./smsFunnel.js";
import { stepRank } from "./smsFunnel.js";

export const SENT_TAGS = ["SMS - Text 1 Sent", "SMS - Text 2 Sent", "SMS - Text 3 Sent", "SMS - Text 4+ Sent"] as const;
export const RESPONDED_TAGS = ["SMS - Responded - Text 1", "SMS - Responded - Text 2", "SMS - Responded - Text 3", "SMS - Responded - Text 4+"] as const;
export const ACQUISITION_TAGS = {
  interested: "Acquisition - Interested",
  offer: "Acquisition - Offer Made",
  accepted: "Acquisition - Offer Accepted",
  contract: "Acquisition - Deal Created",
  closed: "Acquisition - Deal Closed",
  notInterested: "Acquisition - Not Interested",
  doNotContact: "Acquisition - Do Not Contact",
} as const;

export const CRM_TAGS: readonly string[] = [...SENT_TAGS, ...RESPONDED_TAGS, ...Object.values(ACQUISITION_TAGS)];

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
const CRM_TAG_SET = new Set(CRM_TAGS.map(norm));

/** One of the tags Mineral Hub manages (case- and spacing-insensitive). */
export const isCrmTag = (tag: string) => CRM_TAG_SET.has(norm(tag));

export interface TagInputs {
  /** Reached outreach texts before the first reply (summary.touches). */
  touches: number;
  outcome: string | null;
  /** HighLevel SMS do-not-disturb. */
  smsOptedOut: boolean;
  /** The contact's opportunities in MINERALS pipelines (not deleted in HighLevel). */
  opportunities: readonly { step: FunnelStep | string }[];
}

/** The acquisition tag for a contact, or null when none applies. */
export function acquisitionTag(x: TagInputs): string | null {
  const steps = x.opportunities.map((o) => o.step as FunnelStep);
  const live = steps.filter((s) => s !== "dead");
  const best = live.reduce<FunnelStep | null>((b, s) => (b == null || stepRank(s) > stepRank(b) ? s : b), null);
  const optedOut = x.smsOptedOut || x.outcome === "OPTED_OUT";
  if (best === "closed") return ACQUISITION_TAGS.closed;
  if (best === "contract") return ACQUISITION_TAGS.contract;
  if (best === "accepted") return ACQUISITION_TAGS.accepted;
  if (best === "offer" || best === "negotiating" || best === "not_accepted") return ACQUISITION_TAGS.offer;
  // Below an offer, an opt-out decides: they asked not to be contacted.
  if (optedOut) return ACQUISITION_TAGS.doNotContact;
  if (best === "opportunity") return ACQUISITION_TAGS.interested;
  if (steps.length > 0) return ACQUISITION_TAGS.notInterested; // every opportunity dead / lost
  return null;
}

/** Every CRM tag the contact should carry right now. */
export function desiredCrmTags(x: TagInputs): string[] {
  const out: string[] = [];
  const n = Math.max(0, Math.floor(x.touches));
  for (let i = 0; i < Math.min(n, SENT_TAGS.length); i++) out.push(SENT_TAGS[i]);
  if (x.outcome === "RESPONDED" && n >= 1) out.push(RESPONDED_TAGS[Math.min(n, RESPONDED_TAGS.length) - 1]);
  const acq = acquisitionTag(x);
  if (acq) out.push(acq);
  return out;
}

/**
 * What to change on HighLevel so the contact carries exactly `desired` among
 * the CRM tags: add the missing ones, remove CRM tags that no longer apply.
 * Tags that aren't CRM tags are never touched. Empty lists = nothing to do.
 */
export function tagDiff(current: readonly string[], desired: readonly string[]): { add: string[]; remove: string[] } {
  const have = new Map(current.map((t) => [norm(t), t]));
  const want = new Set(desired.map(norm));
  return {
    add: desired.filter((t) => !have.has(norm(t))),
    remove: [...have.entries()].filter(([k]) => CRM_TAG_SET.has(k) && !want.has(k)).map(([, t]) => t),
  };
}
