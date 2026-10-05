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
  /** Winning buyer's activity the move set to CLOSED, with its previous values. */
  winner: { activityId: string; status: string | null; lastActivityDate: Iso | null; messageId: string } | null;
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

  // Closing a deal automatically marks the WINNING buyer's activity record
  // CLOSED — the buyer whose offer was accepted (the deal's selected buyer,
  // falling back to the selected/accepted offer). Every other buyer's
  // record, and all communication history/notes/timeline, stay untouched.
  let winner: StageUndoSnapshot["winner"] = null;
  if (toStage === "CLOSED") {
    let winnerBuyerId: string | null = deal.selectedBuyerId ?? null;
    if (!winnerBuyerId && deal.selectedOfferId) {
      const off = await tx.offer.findUnique({ where: { id: deal.selectedOfferId }, select: { buyerId: true } });
      winnerBuyerId = off?.buyerId ?? null;
    }
    if (!winnerBuyerId) {
      const off = await tx.offer.findFirst({
        where: { dealId: deal.id, status: "ACCEPTED" },
        orderBy: { updatedAt: "desc" }, select: { buyerId: true },
      });
      winnerBuyerId = off?.buyerId ?? null;
    }
    if (winnerBuyerId) {
      const act = await tx.dealBuyerActivity.findUnique({
        where: { dealId_buyerId: { dealId: deal.id, buyerId: winnerBuyerId } },
      });
      if (act && act.status !== "CLOSED") {
        await tx.dealBuyerActivity.update({
          where: { id: act.id },
          data: { status: "CLOSED", lastActivityDate: now },
        });
        // The change shows up in the buyer's interaction log like any other
        // status change, so the automation is visible and auditable.
        const msg = await tx.dealBuyerMessage.create({
          data: {
            organizationId: orgId, dealId: deal.id, buyerId: winnerBuyerId, activityId: act.id,
            kind: "STATUS_CHANGE",
            body: "Status automatically set to Closed — this buyer's accepted offer closed the deal.",
            createdByUserId: user.id,
          },
        });
        winner = {
          activityId: act.id,
          status: act.status,
          lastActivityDate: act.lastActivityDate ? act.lastActivityDate.toISOString() : null,
          messageId: msg.id,
        };
      }
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
    select: { stage: true, currentStageEnteredAt: true, deadReason: true, closedDate: true, updatedAt: true },
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

  // Deal: previous stage and stage-entered date (days-in-stage is right again),
  // dead reason, closed date, portal publication. updatedAt goes back too when
  // nothing else has touched the deal. The where clause re-checks the stage so
  // a concurrent move cannot be overwritten.
  const untouched = sameTime(deal.updatedAt, snap.afterUpdatedAt);
  const res = await tx.deal.updateMany({
    where: { id: snap.dealId, organizationId: snap.orgId, stage: snap.toStage, currentStageEnteredAt: new Date(snap.at) },
    data: {
      stage: snap.fromStage,
      currentStageEnteredAt: new Date(snap.prev.enteredAt),
      deadReason: snap.prev.deadReason,
      ...(snap.closedDateStamped ? { closedDate: null } : {}),
      ...(snap.unpublished ? { publishedToPortal: true } : {}),
      ...(untouched ? { updatedAt: new Date(snap.prev.updatedAt) } : {}),
    },
  });
  if (res.count !== 1) throw changed("the deal's stage was changed again");

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
  if (snap.winner) {
    const w = snap.winner;
    await tx.dealBuyerActivity.updateMany({
      where: { id: w.activityId, dealId: snap.dealId, status: "CLOSED" },
      data: { status: w.status as never },
    });
    await tx.dealBuyerActivity.updateMany({
      where: { id: w.activityId, dealId: snap.dealId, lastActivityDate: new Date(snap.at) },
      data: { lastActivityDate: w.lastActivityDate ? new Date(w.lastActivityDate) : null },
    });
    await tx.dealBuyerMessage.deleteMany({
      where: { id: w.messageId, dealId: snap.dealId, kind: "STATUS_CHANGE" },
    });
  }
  // The stage-history row and activity-feed entry the move wrote.
  await tx.dealStageHistory.deleteMany({ where: { id: snap.historyId, dealId: snap.dealId } });
  await tx.activityLog.deleteMany({
    where: { id: snap.activityLogId, dealId: snap.dealId, organizationId: snap.orgId, eventType: "STAGE_CHANGE" },
  });
}
