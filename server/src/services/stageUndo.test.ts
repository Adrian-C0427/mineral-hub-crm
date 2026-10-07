/**
 * Stage change → undo round trips, against an in-memory stand-in for the
 * Prisma transaction client (no database needed). The stand-in implements only
 * the calls stageUndo.ts makes; the assertions compare the whole store before
 * the move with the whole store after the undo.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import type { Prisma } from "@prisma/client";
import { env } from "../config.js";
import { HttpError } from "../middleware/errors.js";
import {
  applyStageChange, applyStageUndo, signStageUndo, verifyStageUndo,
  STAGE_UNDO_TTL_SECONDS, type StageChangeDeal,
} from "./stageUndo.js";

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "dealId_buyerId") return matches(row, cond as Row);
    const v = row[k];
    const eq = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
    if (cond === null || cond instanceof Date || typeof cond !== "object") return eq(v, cond);
    const c = cond as Row;
    if ("not" in c) return !eq(v, c.not);
    if ("in" in c) return (c.in as unknown[]).includes(v);
    if ("contains" in c) return typeof v === "string" && v.includes(c.contains as string);
    if ("gt" in c) return (v as Date) > (c.gt as Date);
    throw new Error(`fake tx: unsupported filter on ${k}`);
  });
}

/** One in-memory table. `tick` supplies created/updated timestamps. */
class Table {
  rows: Row[] = [];
  private seq = 0;
  constructor(private name: string, private tick: () => Date, private touches = false) {}
  private pick = (where: Row = {}) => this.rows.filter((r) => matches(r, where));
  findMany = async ({ where }: { where?: Row } = {}) => this.pick(where).map((r) => ({ ...r }));
  findFirst = async ({ where, orderBy }: { where?: Row; orderBy?: Row | Row[] } = {}) => {
    const found = this.pick(where);
    for (const o of [orderBy ?? []].flat().reverse()) {
      const [key, dir] = Object.entries(o)[0] as [string, string];
      found.sort((a, b) => (a[key]! < b[key]! ? -1 : a[key]! > b[key]! ? 1 : 0) * (dir === "desc" ? -1 : 1));
    }
    return found[0] ? { ...found[0] } : null;
  };
  findUnique = async (args: { where: Row }) => this.findFirst(args);
  create = async ({ data }: { data: Row }) => {
    const row = { id: `${this.name}_${++this.seq}`, createdAt: this.tick(), ...data };
    this.rows.push(row);
    return { ...row };
  };
  updateMany = async ({ where, data }: { where: Row; data: Row }) => {
    const hit = this.pick(where);
    for (const r of hit) Object.assign(r, this.touches && !("updatedAt" in data) ? { updatedAt: this.tick() } : {}, data);
    return { count: hit.length };
  };
  update = async ({ where, data }: { where: Row; data: Row }) => {
    const { count } = await this.updateMany({ where, data });
    if (count !== 1) throw new Error(`fake tx: ${this.name}.update matched ${count}`);
    return { ...this.pick(where.id ? { id: where.id } : where)[0] };
  };
  deleteMany = async ({ where }: { where: Row }) => {
    const hit = this.pick(where);
    this.rows = this.rows.filter((r) => !hit.includes(r));
    return { count: hit.length };
  };
}

const T0 = new Date("2026-09-01T12:00:00.000Z");
const ENTERED = new Date("2026-08-20T09:30:00.000Z");
const FOLLOW_A = new Date("2026-09-10T00:00:00.000Z");
const FOLLOW_B = new Date("2026-09-12T00:00:00.000Z");
const ORG = "org_1";
const USER = { id: "user_1", name: "Dana" };

/** A published deal in CLOSING with a selected buyer, two buyer activities
 *  carrying follow-ups, and two unread notifications (one for another deal). */
function world() {
  let ms = T0.getTime();
  const tick = () => new Date((ms += 1000));
  const db = {
    deal: new Table("deal", tick, true),
    dealBuyerActivity: new Table("act", tick),
    dealBuyerMessage: new Table("msg", tick),
    notification: new Table("notif", tick),
    offer: new Table("offer", tick),
    dealStageHistory: new Table("hist", tick),
    activityLog: new Table("log", tick),
  };
  db.deal.rows.push({
    id: "deal_1", organizationId: ORG, name: "Smith 40", stage: "CLOSING", currentStageEnteredAt: ENTERED,
    deadReason: null, closedDate: null, publishedToPortal: true, selectedBuyerId: "buyer_w", selectedOfferId: null,
    updatedAt: T0,
  });
  db.dealBuyerActivity.rows.push(
    { id: "act_w", dealId: "deal_1", buyerId: "buyer_w", status: "OFFER_RECEIVED", lastActivityDate: ENTERED, nextFollowUpDate: FOLLOW_A },
    { id: "act_x", dealId: "deal_1", buyerId: "buyer_x", status: "SENT", lastActivityDate: null, nextFollowUpDate: FOLLOW_B },
    { id: "act_y", dealId: "deal_1", buyerId: "buyer_y", status: "PASSED", lastActivityDate: null, nextFollowUpDate: null },
  );
  db.notification.rows.push(
    { id: "n1", organizationId: ORG, link: "/deals/deal_1", readAt: null },
    { id: "n2", organizationId: ORG, link: "/deals/deal_1", readAt: ENTERED }, // already read before the move
    { id: "n3", organizationId: ORG, link: "/deals/deal_2", readAt: null },
  );
  db.dealStageHistory.rows.push({ id: "hist_0", dealId: "deal_1", fromStage: "MARKETING", toStage: "CLOSING", changedByUserId: USER.id, deadReason: null, createdAt: ENTERED });
  const tx = db as unknown as Prisma.TransactionClient;
  const deal = () => ({ ...db.deal.rows[0] }) as unknown as StageChangeDeal;
  const dump = () => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(db).map(([k, t]) => [k, t.rows]))));
  const move = (toStage: string, deadReason?: string) => applyStageChange(tx, deal(), { toStage, deadReason, orgId: ORG, user: USER, now: tick() });
  return { db, tx, deal, dump, move };
}

const caller = { dealId: "deal_1", orgId: ORG, userId: USER.id };
async function status(run: () => unknown): Promise<number | null> {
  try { await run(); return null; } catch (e) { if (e instanceof HttpError) return e.status; throw e; }
}

afterEach(() => vi.useRealTimers());

describe("stage change undo", () => {
  it("closed → undo restores every field the move changed", async () => {
    const w = world();
    const before = w.dump();
    const snap = await w.move("CLOSED");

    // The move really did all of it.
    const d = w.db.deal.rows[0];
    expect(d).toMatchObject({ stage: "CLOSED", publishedToPortal: false });
    expect(d.closedDate).toBeInstanceOf(Date);
    expect(w.db.dealBuyerActivity.rows.every((a) => a.nextFollowUpDate === null)).toBe(true);
    expect(w.db.dealBuyerActivity.rows[0].status).toBe("CLOSED");
    expect(w.db.notification.rows[0].readAt).toBeInstanceOf(Date);
    expect(w.db.dealBuyerMessage.rows).toHaveLength(1);
    expect(w.db.dealStageHistory.rows).toHaveLength(2);
    expect(w.db.activityLog.rows).toHaveLength(1);
    expect(snap.followUps).toHaveLength(2);
    expect(snap.notificationIds).toEqual(["n1"]);

    await applyStageUndo(w.tx, verifyStageUndo(signStageUndo(snap)!, caller));
    // Stage, stage-entered date, closed date, publication, updatedAt, both
    // follow-ups, the winning buyer's status + last activity, the unread
    // notification, and no leftover history / activity / message rows.
    expect(w.dump()).toEqual(before);
  });

  it("keeps a closed date that was already set, and a deal that was not published stays unpublished", async () => {
    const w = world();
    const earlier = new Date("2026-08-30T00:00:00.000Z");
    Object.assign(w.db.deal.rows[0], { closedDate: earlier, publishedToPortal: false });
    const before = w.dump();
    const snap = await w.move("CLOSED");
    expect(snap).toMatchObject({ closedDateStamped: false, unpublished: false });
    await applyStageUndo(w.tx, snap);
    expect(w.dump()).toEqual(before);
  });

  it("dead → undo clears the reason and restores the rest", async () => {
    const w = world();
    const before = w.dump();
    const snap = await w.move("DEAD", "  Seller withdrew ");
    expect(w.db.deal.rows[0]).toMatchObject({ stage: "DEAD", deadReason: "Seller withdrew", publishedToPortal: false, closedDate: null });
    expect(w.db.dealStageHistory.rows[1].deadReason).toBe("Seller withdrew");
    expect(w.db.dealBuyerActivity.rows[0].status).toBe("OFFER_RECEIVED"); // Dead closes no buyer
    await applyStageUndo(w.tx, snap);
    expect(w.db.deal.rows[0].deadReason).toBeNull();
    expect(w.dump()).toEqual(before);
  });

  it("an ordinary move → undo keeps the original days-in-stage", async () => {
    const w = world();
    const before = w.dump();
    const snap = await w.move("MARKETING");
    expect(w.db.deal.rows[0].currentStageEnteredAt).not.toEqual(ENTERED);
    expect(w.db.deal.rows[0].publishedToPortal).toBe(true); // untouched by a non-terminal move
    await applyStageUndo(w.tx, snap);
    expect(w.db.deal.rows[0].currentStageEnteredAt).toEqual(ENTERED);
    expect(w.dump()).toEqual(before);
  });

  it("refuses a tampered, foreign-signed or wrong-purpose token", async () => {
    const w = world();
    const token = signStageUndo(await w.move("CLOSED"))!;
    const [h, p, s] = token.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    payload.snap.fromStage = "MARKETING";
    const forged = [h, Buffer.from(JSON.stringify(payload)).toString("base64url"), s].join(".");
    expect(await status(() => verifyStageUndo(forged, caller))).toBe(400);
    const otherKey = jwt.sign({ snap: payload.snap }, "not-the-server-secret", { audience: "deal-stage-undo", expiresIn: 60 });
    expect(await status(() => verifyStageUndo(otherKey, caller))).toBe(400);
    // A genuine server-signed token minted for something else (a session).
    const session = jwt.sign({ snap: payload.snap, userId: USER.id }, env.JWT_SECRET, { expiresIn: 60 });
    expect(await status(() => verifyStageUndo(session, caller))).toBe(400);
    expect(await status(() => verifyStageUndo("garbage", caller))).toBe(400);
    expect(w.db.deal.rows[0].stage).toBe("CLOSED");
  });

  it("refuses an expired token", async () => {
    const w = world();
    vi.useFakeTimers({ now: T0 });
    const token = signStageUndo(await w.move("CLOSED"))!;
    vi.setSystemTime(new Date(T0.getTime() + (STAGE_UNDO_TTL_SECONDS - 5) * 1000));
    expect(verifyStageUndo(token, caller).toStage).toBe("CLOSED");
    vi.setSystemTime(new Date(T0.getTime() + (STAGE_UNDO_TTL_SECONDS + 5) * 1000));
    expect(await status(() => verifyStageUndo(token, caller))).toBe(410);
  });

  it("refuses another user, another organization and another deal", async () => {
    const w = world();
    const token = signStageUndo(await w.move("CLOSED"))!;
    expect(await status(() => verifyStageUndo(token, { ...caller, userId: "user_2" }))).toBe(403);
    expect(await status(() => verifyStageUndo(token, { ...caller, orgId: "org_2" }))).toBe(400);
    expect(await status(() => verifyStageUndo(token, { ...caller, dealId: "deal_2" }))).toBe(400);
  });

  it("refuses with 409, changing nothing, after a later stage change", async () => {
    const w = world();
    const first = await w.move("CLOSED");
    const second = await w.move("MARKETING");
    const afterBoth = w.dump();
    expect(await status(() => applyStageUndo(w.tx, first))).toBe(409);
    expect(w.dump()).toEqual(afterBoth);
    // Moved away and back to the same stage: still not the move the token describes.
    await w.move("CLOSED");
    expect(await status(() => applyStageUndo(w.tx, first))).toBe(409);
    expect(second.fromStage).toBe("CLOSED");
  });

  it("refuses with 409 after an edit to a snapshotted field", async () => {
    for (const edit of [
      (w: ReturnType<typeof world>) => { w.db.deal.rows[0].closedDate = new Date("2026-09-02T00:00:00.000Z"); },
      (w: ReturnType<typeof world>) => { w.db.dealBuyerActivity.rows[0].status = "PASSED"; },
    ]) {
      const w = world();
      const snap = await w.move("CLOSED");
      edit(w);
      const edited = w.dump();
      expect(await status(() => applyStageUndo(w.tx, snap))).toBe(409);
      expect(w.dump()).toEqual(edited);
    }
    const w = world();
    const snap = await w.move("DEAD", "Title issues");
    w.db.deal.rows[0].deadReason = "Buyer withdrew";
    expect(await status(() => applyStageUndo(w.tx, snap))).toBe(409);
  });

  it("cannot be replayed", async () => {
    const w = world();
    const snap = await w.move("CLOSED");
    await applyStageUndo(w.tx, snap);
    expect(await status(() => applyStageUndo(w.tx, snap))).toBe(409);
  });

  describe("closing settles the winning buyer", () => {
    const offer = (o: Partial<Row>): Row => ({ id: "offer_1", dealId: "deal_1", buyerId: "buyer_w", status: "ACTIVE", amount: 150000, dateSubmitted: ENTERED, updatedAt: ENTERED, ...o });

    it("accepts the selected buyer's open offer and records it as the deal's selection; undo restores both", async () => {
      const w = world();
      w.db.offer.rows.push(offer({ id: "offer_old", status: "COUNTERED", dateSubmitted: new Date("2026-08-01T00:00:00.000Z") }), offer({}));
      const before = w.dump();
      const snap = await w.move("CLOSED");
      expect(w.db.offer.rows.find((o) => o.id === "offer_1")!.status).toBe("ACCEPTED");
      expect(w.db.offer.rows.find((o) => o.id === "offer_old")!.status).toBe("COUNTERED");
      expect(w.db.deal.rows[0]).toMatchObject({ selectedOfferId: "offer_1", selectedBuyerId: "buyer_w" });
      expect(w.db.dealBuyerActivity.rows[0].status).toBe("CLOSED");
      expect(snap.acceptedOffer).toEqual({ offerId: "offer_1", status: "ACTIVE" });
      expect(snap.selection).toEqual({ offerId: "offer_1", buyerId: "buyer_w", prevBuyerId: "buyer_w" });
      await applyStageUndo(w.tx, verifyStageUndo(signStageUndo(snap)!, caller));
      expect(w.dump()).toEqual(before);
    });

    it("an already-accepted, selected offer is left alone", async () => {
      const w = world();
      w.db.offer.rows.push(offer({ status: "ACCEPTED" }));
      w.db.deal.rows[0].selectedOfferId = "offer_1";
      const before = w.dump();
      const snap = await w.move("CLOSED");
      expect(snap).toMatchObject({ acceptedOffer: null, selection: null });
      expect(w.db.dealBuyerActivity.rows[0].status).toBe("CLOSED");
      await applyStageUndo(w.tx, snap);
      expect(w.dump()).toEqual(before);
    });

    it("finds the winner from the accepted offer when the deal has no selection", async () => {
      const w = world();
      Object.assign(w.db.deal.rows[0], { selectedBuyerId: null, selectedOfferId: null });
      w.db.offer.rows.push(offer({ id: "offer_x", buyerId: "buyer_x", status: "ACTIVE" }), offer({ status: "ACCEPTED" }));
      const before = w.dump();
      const snap = await w.move("CLOSED");
      expect(w.db.deal.rows[0]).toMatchObject({ selectedOfferId: "offer_1", selectedBuyerId: "buyer_w" });
      expect(w.db.dealBuyerActivity.rows.map((a) => a.status)).toEqual(["CLOSED", "SENT", "PASSED"]);
      expect(w.db.offer.rows.find((o) => o.id === "offer_x")!.status).toBe("ACTIVE"); // only the winner's offer
      expect(snap.selection).toEqual({ offerId: "offer_1", buyerId: "buyer_w", prevBuyerId: null });
      await applyStageUndo(w.tx, snap);
      expect(w.dump()).toEqual(before);
    });

    it("gives a winner with no activity row one, marked CLOSED; undo removes it", async () => {
      const w = world();
      w.db.dealBuyerActivity.rows.shift(); // buyer_w was taken off the deal
      w.db.offer.rows.push(offer({ status: "ACCEPTED" }));
      w.db.deal.rows[0].selectedOfferId = "offer_1";
      const before = w.dump();
      const snap = await w.move("CLOSED");
      const created = w.db.dealBuyerActivity.rows.find((a) => a.buyerId === "buyer_w")!;
      expect(created).toMatchObject({ status: "CLOSED", offerAmount: 150000, dealId: "deal_1" });
      expect(snap.winner).toMatchObject({ activityId: created.id, status: null, created: true });
      expect(w.db.dealBuyerMessage.rows[0].activityId).toBe(created.id);
      await applyStageUndo(w.tx, snap);
      expect(w.dump()).toEqual(before);
    });

    it("refuses with 409 once the accepted offer or the selection was changed after the close", async () => {
      const w = world();
      w.db.offer.rows.push(offer({}));
      const snap = await w.move("CLOSED");
      w.db.offer.rows[0].status = "WITHDRAWN";
      expect(await status(() => applyStageUndo(w.tx, snap))).toBe(409);
      w.db.offer.rows[0].status = "ACCEPTED";
      w.db.deal.rows[0].selectedOfferId = "offer_other";
      expect(await status(() => applyStageUndo(w.tx, snap))).toBe(409);
    });

    it("a token from before offers were part of the snapshot still undoes", async () => {
      const w = world();
      const snap = await w.move("CLOSED");
      const legacy = { ...snap } as Partial<typeof snap>;
      delete legacy.acceptedOffer;
      delete legacy.selection;
      await applyStageUndo(w.tx, verifyStageUndo(signStageUndo(legacy as typeof snap)!, caller));
      expect(w.db.deal.rows[0].stage).toBe("CLOSING");
    });
  });

  it("leaves newer work alone: a re-set follow-up, an unrelated deal edit", async () => {
    const w = world();
    const snap = await w.move("CLOSED");
    const newer = new Date("2026-10-01T00:00:00.000Z");
    w.db.dealBuyerActivity.rows[1].nextFollowUpDate = newer; // someone scheduled a new one
    await w.db.deal.updateMany({ where: { id: "deal_1" }, data: { name: "Smith 40 (renamed)" } });
    await applyStageUndo(w.tx, snap);
    expect(w.db.dealBuyerActivity.rows[1].nextFollowUpDate).toEqual(newer);
    expect(w.db.dealBuyerActivity.rows[0].nextFollowUpDate).toEqual(FOLLOW_A);
    expect(w.db.deal.rows[0]).toMatchObject({ stage: "CLOSING", name: "Smith 40 (renamed)" });
    // The deal was edited after the move, so its updatedAt is not rolled back.
    expect((w.db.deal.rows[0].updatedAt as Date).getTime()).toBeGreaterThan(new Date(snap.afterUpdatedAt).getTime());
  });
});
