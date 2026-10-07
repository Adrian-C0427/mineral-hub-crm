/**
 * Deal stage change + its exact undo.
 *
 * A stage change has side effects beyond `Deal.stage` (entering Closed/Dead
 * unpublishes the offering, clears buyer follow-ups, marks notifications read,
 * stamps the closed date, closes the winning buyer's activity…). Moving the
 * deal "back" reverses none of them and resets days-in-stage, so the Pipeline
 * board's Undo needs the real thing.
 *
 * There is no table for a "before" snapshot, so the snapshot travels with the
 * client instead: `applyStageChange` returns it, the route signs it into a
 * short-lived token (same secret + audience-pinning pattern as the integration
 * OAuth state), and `applyStageUndo` only acts on a token that verifies, belongs
 * to the caller, and still describes the deal's current state. Every row the
 * undo touches is named by id in the token — nothing is inferred at undo time.
 */
import jwt from "jsonwebtoken";
import type { Prisma } from "@prisma/client";
import { env } from "../config.js";
import { HttpError } from "../middleware/errors.js";

/** How long an Undo stays redeemable. The toast offering it lives a few seconds. */
export const STAGE_UNDO_TTL_SECONDS = 5 * 60;
/** Above this the token is not issued (a deal with thousands of cleared
 *  follow-ups/notifications); the move itself is unaffected. */
export const STAGE_UNDO_MAX_TOKEN_BYTES = 256 * 1024;

const UNDO_AUDIENCE = "deal-stage-undo";
const UNDO_ALGORITHM = "HS256" as const;

type Iso = string;

export interface StageUndoSnapshot {
  v: 1;
  dealId: string;
  orgId: string;
  userId: string;
  fromStage: string;
  toStage: string;
  /** Dead reason the move stored (Dead moves only). */
  reason: string | null;
  /** The single timestamp the forward move stamped everywhere. */
  at: Iso;
  /** Deal fields as they were before the move. */
  prev: { enteredAt: Iso; deadReason: string | null; updatedAt: Iso };
  /** Deal.updatedAt right after the move (to tell "untouched since"). */
  afterUpdatedAt: Iso;
  /** The move stamped Deal.closedDate (it was empty before). */
  closedDateStamped: boolean;
  /** The move unpublished a live portal offering. */
  unpublished: boolean;
  /** Buyer follow-ups the move cleared: [DealBuyerActivity.id, previous date]. */
  followUps: [string, Iso][];
  /** Notifications the move marked read. */
  notificationIds: string[];
  /** Winning buyer's activity the move set to CLOSED, with its previous values
   *  (`created`: the buyer had no activity row and the move added one). */
  winner: { activityId: string; status: string | null; lastActivityDate: Iso | null; messageId: string; created?: boolean } | null;
  /** The winning buyer's offer the move marked ACCEPTED, with its previous status. */
  acceptedOffer?: { offerId: string; status: string } | null;
  /** The selected offer/buyer the move recorded on the deal (it had no
   *  selected offer), with the selected buyer it had before. */
  selection?: { offerId: string; buyerId: string; prevBuyerId: string | null } | null;
  /** Rows the move wrote. */
  historyId: string;
  activityLogId: string;
}

export function signStageUndo(snapshot: StageUndoSnapshot): string | null {
  const token = jwt.sign({ snap: snapshot }, env.JWT_SECRET, {
    algorithm: UNDO_ALGORITHM,
    expiresIn: STAGE_UNDO_TTL_SECONDS,
    audience: UNDO_AUDIENCE,
  });
  return Buffer.byteLength(token) > STAGE_UNDO_MAX_TOKEN_BYTES ? null : token;
}

/**
 * Verify signature, audience and expiry, then bind the token to the caller:
 * same deal, same organization, same user who made the move.
 */
export function verifyStageUndo(
  token: string,
  caller: { dealId: string; orgId: string; userId: string },
): StageUndoSnapshot {
  let snap: StageUndoSnapshot | undefined;
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: [UNDO_ALGORITHM], audience: UNDO_AUDIENCE });
    snap = (decoded as { snap?: StageUndoSnapshot }).snap;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new HttpError(410, "This move can no longer be undone — the undo window has expired.");
    throw new HttpError(400, "Invalid undo token");
  }
  if (!snap || snap.v !== 1) throw new HttpError(400, "Invalid undo token");
  if (snap.dealId !== caller.dealId || snap.orgId !== caller.orgId) throw new HttpError(400, "Invalid undo token");
  if (snap.userId !== caller.userId) throw new HttpError(403, "Only the person who moved this deal can undo the move.");
  return snap;
}

function prettyStage(s: string): string {
  return s.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}

/** The deal columns the forward move reads. */
export interface StageChangeDeal {
  id: string;
  name: string;
  stage: string;
  currentStageEnteredAt: Date;
  deadReason: string | null;
  closedDate: Date | null;
  publishedToPortal: boolean;
  selectedBuyerId: string | null;
  selectedOfferId: string | null;
  updatedAt: Date;
}

type WinnerOffer = { id: string; buyerId: string; status: string; amount: number };
const winnerOfferSelect = { id: true, buyerId: true, status: true, amount: true } as const;

/**
 * Who a closing deal is closing with, and on which offer.
 *   Winner = the deal's selected buyer; else the buyer of its selected offer;
 *            else the buyer of its most recently accepted offer; else, when a
 *            single buyer holds an open offer, that buyer; else nobody.
 *   Offer  = the selected offer when it is that buyer's; else the buyer's most
 *            recently accepted offer; else their latest ACTIVE offer (the open
 *            offer from the buyer the deal closed with IS the accepted one).
 * `select` says the deal has no selected offer yet and the move should record
 * this one.
 */
async function resolveWinner(
  tx: Prisma.TransactionClient,
  deal: StageChangeDeal,
): Promise<{ buyerId: string; offer: WinnerOffer | null; select: boolean } | null> {
  let buyerId: string | null = deal.selectedBuyerId ?? null;
  let offer: WinnerOffer | null = null;
  if (deal.selectedOfferId) {
    offer = await tx.offer.findFirst({ where: { id: deal.selectedOfferId, dealId: deal.id }, select: winnerOfferSelect });
    if (!buyerId) buyerId = offer?.buyerId ?? null;
    else if (offer && offer.buyerId !== buyerId) offer = null; // selection out of step with the buyer
  }
  if (!buyerId) {
    offer = await tx.offer.findFirst({
      where: { dealId: deal.id, status: "ACCEPTED" },
      orderBy: { updatedAt: "desc" }, select: winnerOfferSelect,
    });
    buyerId = offer?.buyerId ?? null;
  }
  // Nothing selected or accepted: when exactly ONE buyer holds an open offer,
  // the deal can only be closing with them. Several open offers stay as they
  // are — guessing a winner would be wrong.
  if (!buyerId) {
    const open = await tx.offer.findMany({
      where: { dealId: deal.id, status: "ACTIVE" },
      orderBy: { dateSubmitted: "desc" }, select: winnerOfferSelect,
    });
    const buyers = new Set(open.map((o) => o.buyerId));
    if (buyers.size === 1) { offer = open[0]; buyerId = open[0].buyerId; }
  }
  if (!buyerId) return null;
  if (!offer) {
    offer =
      (await tx.offer.findFirst({
        where: { dealId: deal.id, buyerId, status: "ACCEPTED" },
        orderBy: { updatedAt: "desc" }, select: winnerOfferSelect,
      })) ??
      (await tx.offer.findFirst({
        where: { dealId: deal.id, buyerId, status: "ACTIVE" },
        orderBy: { dateSubmitted: "desc" }, select: winnerOfferSelect,
      }));
  }
  return { buyerId, offer, select: !!offer && !deal.selectedOfferId };
}

/**
 * Move a deal to `toStage` with every side effect, inside the caller's
 * transaction. Validation (stage exists, Dead reason present, not a no-op) is
 * the route's job. Returns the snapshot `applyStageUndo` needs to reverse it.
 */
export async function applyStageChange(
  tx: Prisma.TransactionClient,
  deal: StageChangeDeal,
  p: { toStage: string; deadReason?: string; orgId: string; user: { id: string; name: string }; now?: Date },
): Promise<StageUndoSnapshot> {
  const { toStage, orgId, user } = p;
  const now = p.now ?? new Date();
  const reason = toStage === "DEAD" ? p.deadReason!.trim() : null;
  const terminal = toStage === "CLOSED" || toStage === "DEAD";
  const stampClosed = toStage === "CLOSED" && !deal.closedDate;
  // Resolved before the deal update so a missing selection is written in the
  // same statement (one updatedAt for the undo to pin).
  const win = toStage === "CLOSED" ? await resolveWinner(tx, deal) : null;
  const select = win?.select && win.offer ? { offerId: win.offer.id, buyerId: win.buyerId, prevBuyerId: deal.selectedBuyerId ?? null } : null;

  const u = await tx.deal.update({
    where: { id: deal.id },
    data: {
      stage: toStage,
      currentStageEnteredAt: now,
      deadReason: toStage === "DEAD" ? reason : deal.deadReason,
      // Auto-stamp the closed date on the first move to CLOSED (editable after).
      ...(stampClosed ? { closedDate: now } : {}),
      // A closed or dead deal is off the market — unpublish from the buyer portal.
      ...(terminal ? { publishedToPortal: false } : {}),
      // Closing records the winning offer as the deal's selection when nothing
      // was selected yet, so every surface keyed on it agrees.
      ...(select ? { selectedOfferId: select.offerId, selectedBuyerId: select.buyerId } : {}),
    },
    select: { updatedAt: true },
  });

  // Closed/Dead deals generate no further timeline activity: clear outstanding
  // buyer follow-up reminders and mark this deal's pending notifications read.
  // The affected rows are read first so the undo can name them.
  let followUps: [string, Iso][] = [];
  let notificationIds: string[] = [];
  if (terminal) {
    const due = await tx.dealBuyerActivity.findMany({
      where: { dealId: deal.id, nextFollowUpDate: { not: null } },
      select: { id: true, nextFollowUpDate: true },
    });
    followUps = due.map((a) => [a.id, a.nextFollowUpDate!.toISOString()]);
    await tx.dealBuyerActivity.updateMany({
      where: { dealId: deal.id, nextFollowUpDate: { not: null } },
      data: { nextFollowUpDate: null },
    });
    const unread = await tx.notification.findMany({
      where: { organizationId: orgId, readAt: null, link: { contains: deal.id } },
      select: { id: true },
    });
    notificationIds = unread.map((n) => n.id);
    await tx.notification.updateMany({
      where: { organizationId: orgId, readAt: null, link: { contains: deal.id } },
      data: { readAt: now },
    });
  }

  // Closing a deal settles the WINNING buyer (see resolveWinner): their offer
  // is the accepted one and their activity record is CLOSED. Every other
  // buyer's record, and all communication history/notes/timeline, stay
  // untouched.
  let winner: StageUndoSnapshot["winner"] = null;
  let acceptedOffer: StageUndoSnapshot["acceptedOffer"] = null;
  if (win) {
    if (win.offer && win.offer.status !== "ACCEPTED") {
      await tx.offer.update({ where: { id: win.offer.id }, data: { status: "ACCEPTED" } });
      acceptedOffer = { offerId: win.offer.id, status: win.offer.status };
    }
    const act = await tx.dealBuyerActivity.findUnique({
      where: { dealId_buyerId: { dealId: deal.id, buyerId: win.buyerId } },
    });
    if (!act || act.status !== "CLOSED") {
      // The winner's row was removed at some point (buyer taken off the deal):
      // closing puts one back so the closed deal names its buyer.
      const row = act ?? await tx.dealBuyerActivity.create({
        data: {
          dealId: deal.id, buyerId: win.buyerId, status: "CLOSED", responseReceived: true,
          offerAmount: win.offer?.amount ?? null, dateSent: now, lastActivityDate: now, sentByUserId: user.id,
        },
      });
      if (act) {
        await tx.dealBuyerActivity.update({
          where: { id: act.id },
          data: { status: "CLOSED", lastActivityDate: now },
        });
      }
      // The change shows up in the buyer's interaction log like any other
      // status change, so the automation is visible and auditable.
      const msg = await tx.dealBuyerMessage.create({
        data: {
          organizationId: orgId, dealId: deal.id, buyerId: win.buyerId, activityId: row.id,
          kind: "STATUS_CHANGE",
          body: "Status automatically set to Closed — this buyer's accepted offer closed the deal.",
          createdByUserId: user.id,
        },
      });
      winner = {
        activityId: row.id,
        status: act ? act.status : null,
        lastActivityDate: act?.lastActivityDate ? act.lastActivityDate.toISOString() : null,
        messageId: msg.id,
        ...(act ? {} : { created: true }),
      };
    }
  }

  const history = await tx.dealStageHistory.create({
    data: {
      dealId: deal.id,
      fromStage: deal.stage,
      toStage,
      changedByUserId: user.id,
      deadReason: reason,
    },
  });
  // Same row logActivity() writes; created directly because the undo needs its id.
  const log = await tx.activityLog.create({
    data: {
      eventType: "STAGE_CHANGE",
      summary: `${user.name} moved "${deal.name}" to ${prettyStage(toStage)}${toStage === "DEAD" ? ` (${reason})` : ""}`,
      organizationId: orgId,
      actorUserId: user.id,
      dealId: deal.id,
      buyerId: null,
    },
  });

  return {
    v: 1,
    dealId: deal.id,
    orgId,
    userId: user.id,
    fromStage: deal.stage,
    toStage,
    reason,
    at: now.toISOString(),
    prev: {
      enteredAt: deal.currentStageEnteredAt.toISOString(),
      deadReason: deal.deadReason,
      updatedAt: deal.updatedAt.toISOString(),
    },
    afterUpdatedAt: u.updatedAt.toISOString(),
    closedDateStamped: stampClosed,
    unpublished: terminal && deal.publishedToPortal,
    followUps,
    notificationIds,
    winner,
    acceptedOffer,
    selection: select,
    historyId: history.id,
    activityLogId: log.id,
  };
}

const sameTime = (d: Date | null | undefined, iso: Iso) => !!d && d.getTime() === new Date(iso).getTime();

/**
 * Reverse a stage change described by a verified snapshot, inside the caller's
 * transaction. Refuses with 409 (changing nothing) when the deal is no longer
 * in the state that move left it in.
 */
export async function applyStageUndo(tx: Prisma.TransactionClient, snap: StageUndoSnapshot): Promise<void> {
  const changed = (what: string) =>
    new HttpError(409, `This move can no longer be undone — ${what} since it was made.`);

  const deal = await tx.deal.findFirst({
    where: { id: snap.dealId, organizationId: snap.orgId },
    select: { stage: true, currentStageEnteredAt: true, deadReason: true, closedDate: true, updatedAt: true, selectedOfferId: true },
  });
  if (!deal) throw new HttpError(404, "Deal not found");
  // Any later stage change (this route, accept-offer, convert, bulk archive…)
  // rewrites the stage-entered date, so these two pin "no move since".
  if (deal.stage !== snap.toStage || !sameTime(deal.currentStageEnteredAt, snap.at)) {
    throw changed("the deal's stage was changed again");
  }
  if (snap.toStage === "DEAD" && deal.deadReason !== snap.reason) {
    throw changed("the dead reason was edited");
  }
  if (snap.closedDateStamped && !sameTime(deal.closedDate, snap.at)) {
    throw changed("the closed date was edited");
  }
  // The row this move wrote must still be the deal's latest history entry.
  const latest = await tx.dealStageHistory.findFirst({
    where: { dealId: snap.dealId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latest && latest.id !== snap.historyId) throw changed("the deal's stage was changed again");
  if (snap.winner) {
    const act = await tx.dealBuyerActivity.findFirst({
      where: { id: snap.winner.activityId, dealId: snap.dealId },
      select: { status: true },
    });
    if (act && act.status !== "CLOSED") throw changed("the winning buyer's status was changed");
  }
  if (snap.selection && deal.selectedOfferId !== snap.selection.offerId) throw changed("the accepted offer was changed");
  if (snap.acceptedOffer) {
    const off = await tx.offer.findFirst({ where: { id: snap.acceptedOffer.offerId, dealId: snap.dealId }, select: { status: true } });
    if (off && off.status !== "ACCEPTED") throw changed("the winning buyer's offer was changed");
  }

  // Deal: previous stage and stage-entered date (days-in-stage is right again),
  // dead reason, closed date, portal publication, selected offer/buyer.
  // updatedAt goes back too when nothing else has touched the deal. The where
  // clause re-checks the stage so a concurrent move cannot be overwritten.
  const untouched = sameTime(deal.updatedAt, snap.afterUpdatedAt);
  const res = await tx.deal.updateMany({
    where: { id: snap.dealId, organizationId: snap.orgId, stage: snap.toStage, currentStageEnteredAt: new Date(snap.at) },
    data: {
      stage: snap.fromStage,
      currentStageEnteredAt: new Date(snap.prev.enteredAt),
      deadReason: snap.prev.deadReason,
      ...(snap.closedDateStamped ? { closedDate: null } : {}),
      ...(snap.unpublished ? { publishedToPortal: true } : {}),
      ...(snap.selection ? { selectedOfferId: null, selectedBuyerId: snap.selection.prevBuyerId } : {}),
      ...(untouched ? { updatedAt: new Date(snap.prev.updatedAt) } : {}),
    },
  });
  if (res.count !== 1) throw changed("the deal's stage was changed again");
  // The winning buyer's offer: back to the status it had before the close.
  if (snap.acceptedOffer) {
    await tx.offer.updateMany({
      where: { id: snap.acceptedOffer.offerId, dealId: snap.dealId, status: "ACCEPTED" },
      data: { status: snap.acceptedOffer.status as never },
    });
  }

  // Follow-ups: put each cleared date back, unless someone has set a new one.
  for (const [id, date] of snap.followUps) {
    await tx.dealBuyerActivity.updateMany({
      where: { id, dealId: snap.dealId, nextFollowUpDate: null },
      data: { nextFollowUpDate: new Date(date) },
    });
  }
  // Notifications: unread again — only the ones this move marked (same stamp).
  if (snap.notificationIds.length) {
    await tx.notification.updateMany({
      where: { id: { in: snap.notificationIds }, organizationId: snap.orgId, readAt: new Date(snap.at) },
      data: { readAt: null },
    });
  }
  // Winning buyer: previous status; previous last-activity date unless newer
  // activity was logged; and remove the automatic "set to Closed" log entry.
  // A row the move created (the buyer had none) is removed again.
  if (snap.winner) {
    const w = snap.winner;
    await tx.dealBuyerMessage.deleteMany({
      where: { id: w.messageId, dealId: snap.dealId, kind: "STATUS_CHANGE" },
    });
    if (w.created) {
      await tx.dealBuyerActivity.deleteMany({ where: { id: w.activityId, dealId: snap.dealId, status: "CLOSED" } });
    } else {
      await tx.dealBuyerActivity.updateMany({
        where: { id: w.activityId, dealId: snap.dealId, status: "CLOSED" },
        data: { status: w.status as never },
      });
      await tx.dealBuyerActivity.updateMany({
        where: { id: w.activityId, dealId: snap.dealId, lastActivityDate: new Date(snap.at) },
        data: { lastActivityDate: w.lastActivityDate ? new Date(w.lastActivityDate) : null },
      });
    }
  }
  // The stage-history row and activity-feed entry the move wrote.
  await tx.dealStageHistory.deleteMany({ where: { id: snap.historyId, dealId: snap.dealId } });
  await tx.activityLog.deleteMany({
    where: { id: snap.activityLogId, dealId: snap.dealId, organizationId: snap.orgId, eventType: "STAGE_CHANGE" },
  });
}
