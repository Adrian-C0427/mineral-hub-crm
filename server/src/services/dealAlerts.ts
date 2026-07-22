/**
 * Deal alert sweep — turns operational conditions into REAL notification rows
 * so every alert lives in one place (the bell), not on the dashboard:
 *
 *  - `deal_overdue`   : active deal past its effective Find-Buyer-By with no
 *                       buyer selected (same isOverdue() rule the lists use)
 *  - `follow_up_due`  : a buyer-activity nextFollowUpDate that has arrived
 *  - `task_due`       : an incomplete contact task whose due date has arrived
 *                       (cleared immediately when the task is completed)
 *
 * Rows target the deal's relationship owner / the activity's assignee when one
 * exists, else userId null (visible to org owners). Re-alert throttling is
 * data-driven — a condition only creates a new row when no row of the same
 * type+link exists within the re-alert window — so restarts never spam and a
 * dismissed (read) alert resurfaces after the window if the condition persists.
 */
import { prisma } from "../db.js";
import { isOverdue } from "../domain/priority.js";
import { TERMINAL_STAGE_KEYS } from "../domain/stages.js";

const TICK_MS = 6 * 60 * 60 * 1000;        // sweep every 6 hours
const REALERT_MS = 3 * 24 * 60 * 60 * 1000; // resurface a persisting condition after ~3 days

export async function runDealAlertSweep(now = new Date()): Promise<{ overdue: number; followUps: number; tasks: number }> {
  const since = new Date(now.getTime() - REALERT_MS);

  // Recent alert rows (any read state) — the dedupe/throttle set.
  const recent = await prisma.notification.findMany({
    where: { type: { in: ["deal_overdue", "follow_up_due", "task_due"] }, createdAt: { gte: since } },
    select: { type: true, link: true, organizationId: true },
  });
  const seen = new Set(recent.map((r) => `${r.organizationId}|${r.type}|${r.link}`));

  // --- Overdue deals -------------------------------------------------------
  const activeDeals = await prisma.deal.findMany({
    where: { stage: { notIn: [...TERMINAL_STAGE_KEYS] }, organizationId: { not: null } },
    select: {
      id: true, name: true, organizationId: true, relationshipOwnerId: true, selectedBuyerId: true,
      dateUnderContract: true, originalClosingDate: true, findBuyerByDateOverride: true, finalClosingDateOverride: true,
    },
  });
  let overdue = 0;
  for (const d of activeDeals) {
    if (!d.organizationId || !isOverdue(d, now)) continue;
    const key = `${d.organizationId}|deal_overdue|/deals/${d.id}`;
    if (seen.has(key)) continue;
    await prisma.notification.create({
      data: {
        organizationId: d.organizationId,
        userId: d.relationshipOwnerId,
        type: "deal_overdue",
        title: `Deal overdue: ${d.name}`,
        body: "Past its Find Buyer By date with no buyer selected.",
        link: `/deals/${d.id}`,
      },
    });
    seen.add(key);
    overdue++;
  }

  // --- Follow-ups due ------------------------------------------------------
  const due = await prisma.dealBuyerActivity.findMany({
    where: { nextFollowUpDate: { lte: now }, deal: { stage: { notIn: [...TERMINAL_STAGE_KEYS] } } },
    select: {
      id: true, nextFollowUpDate: true, assignedTeamMemberId: true,
      buyer: { select: { name: true } },
      deal: { select: { id: true, name: true, organizationId: true } },
    },
  });
  let followUps = 0;
  for (const a of due) {
    if (!a.deal.organizationId) continue;
    const key = `${a.deal.organizationId}|follow_up_due|/deals/${a.deal.id}`;
    if (seen.has(key)) continue;
    await prisma.notification.create({
      data: {
        organizationId: a.deal.organizationId,
        userId: a.assignedTeamMemberId,
        type: "follow_up_due",
        title: `Follow-up due: ${a.buyer.name}`,
        body: `Scheduled follow-up on ${a.deal.name} has arrived.`,
        link: `/deals/${a.deal.id}`,
      },
    });
    seen.add(key);
    followUps++;
  }

  // --- Tasks due -----------------------------------------------------------
  // Incomplete contact tasks whose due date has arrived. The link carries the
  // task id (`?task=<id>`) so completing the task can retire its alert exactly,
  // and so each task dedupes independently of its siblings on the same contact.
  const dueTasks = await prisma.contactActivity.findMany({
    where: { kind: "TASK", completedAt: null, dueDate: { lte: now } },
    select: {
      id: true, body: true, dueDate: true, organizationId: true,
      assignedToId: true, createdById: true,
      contact: { select: { id: true, firstName: true, lastName: true, entityName: true } },
    },
  });
  let tasks = 0;
  for (const t of dueTasks) {
    const link = `/contacts/${t.contact.id}?task=${t.id}`;
    const key = `${t.organizationId}|task_due|${link}`;
    if (seen.has(key)) continue;
    const who = [t.contact.firstName, t.contact.lastName].filter(Boolean).join(" ") || t.contact.entityName || "contact";
    const overdueDays = Math.floor((now.getTime() - t.dueDate!.getTime()) / 86_400_000);
    await prisma.notification.create({
      data: {
        organizationId: t.organizationId,
        userId: t.assignedToId ?? t.createdById,
        type: "task_due",
        title: overdueDays > 0 ? `Task overdue: ${t.body.slice(0, 80)}` : `Task due: ${t.body.slice(0, 80)}`,
        body: `On ${who}${overdueDays > 0 ? ` — ${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue.` : " — due today."}`,
        link,
      },
    });
    seen.add(key);
    tasks++;
  }

  return { overdue, followUps, tasks };
}

export function startDealAlertScheduler(): void {
  const tick = () => { void runDealAlertSweep().catch((e) => console.error("deal alert sweep failed:", e)); };
  // First pass shortly after boot (let the server settle), then every TICK_MS.
  setTimeout(tick, 15_000);
  setInterval(tick, TICK_MS);
}
