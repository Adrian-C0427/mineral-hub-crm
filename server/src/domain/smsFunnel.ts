/**
 * Where a HighLevel opportunity sits on the outreach-to-close funnel. Owners
 * name their pipeline stages freely, so the step comes from the stage name
 * (and, for a pipeline that exists only to park declined offers, the pipeline
 * name). The opportunity's status overrides both: won = closed, lost /
 * abandoned = dead.
 *
 * Steps in order: opportunity → offer → negotiating → accepted → contract →
 * closed. "dead" ends the line anywhere; "not_accepted" means an offer was
 * made and turned down. maxRank remembers the furthest step an opportunity
 * ever reached, so a deal that died after an offer still counts as an offer.
 *
 * HighLevel's API reports only an opportunity's CURRENT stage (plus when it
 * last changed). The sync records each stage it observes from the day it is
 * connected; for earlier history the current stage is all there is.
 */

export type FunnelStep = "opportunity" | "offer" | "negotiating" | "accepted" | "contract" | "closed" | "dead" | "not_accepted";

export const FUNNEL_ORDER: readonly FunnelStep[] = ["opportunity", "offer", "negotiating", "accepted", "contract", "closed"];

/** Position on the success path; dead = 0, not_accepted = offer's rank. */
export function stepRank(step: FunnelStep): number {
  if (step === "dead") return 0;
  if (step === "not_accepted") return FUNNEL_ORDER.indexOf("offer") + 1;
  return FUNNEL_ORDER.indexOf(step) + 1;
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export function stageStep(stageName: string | null | undefined, pipelineName?: string | null, status?: string | null): FunnelStep {
  const st = norm(status);
  if (st === "won") return "closed";
  if (st === "lost" || st === "abandoned") return "dead";
  const s = norm(stageName);
  const p = norm(pipelineName);
  if (/\b(not accepted|rejected|declined|turned down)\b/.test(s) || /\bnot accepted\b/.test(p)) return "not_accepted";
  if (/\b(closed|won|funded|purchased|recorded)\b/.test(s)) return "closed";
  if (/\bcontract\b/.test(s)) return "contract";
  if (/\baccepted\b/.test(s)) return "accepted";
  if (/\b(negotiat\w*|counter\w*)\b/.test(s)) return "negotiating";
  if (/\b(offer made|offer sent|offered|offer out)\b/.test(s)) return "offer";
  if (/\b(dead|lost|abandon\w*|disqualif\w*|not interested)\b/.test(s)) return "dead";
  return "opportunity"; // Needs Offer, Follow Up, New Lead, …
}

/** True when the opportunity got at least as far as an offer. */
export const offerMade = (maxRank: number, step?: FunnelStep) =>
  step === "not_accepted" || maxRank >= stepRank("offer");
