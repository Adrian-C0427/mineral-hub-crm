import { describe, it, expect } from "vitest";
import {
  summarizeContact, touchRates, isOptOutReply, isReachedStatus, isUnconfirmedStatus, isSentStatus, isWrongNumberReply, smsSegments, carrierHealth, textingCost,
  type SmsMessageInput, type TouchOutcomeCount,
} from "./smsMetrics.js";

const T0 = Date.UTC(2026, 9, 1, 15);
const at = (days: number) => new Date(T0 + days * 86_400_000);
const out = (days: number, status = "delivered", hlUserId: string | null = "u1"): SmsMessageInput =>
  ({ direction: "outbound", status, sentAt: at(days), hlUserId, optOut: false });
const inn = (days: number, optOut = false): SmsMessageInput =>
  ({ direction: "inbound", status: "delivered", sentAt: at(days), hlUserId: null, optOut });

describe("statuses", () => {
  it("counts delivered and receipt-less texts as reached, never failed or pending ones", () => {
    expect(isReachedStatus("delivered")).toBe(true);
    expect(isReachedStatus("sent")).toBe(true);
    expect(isUnconfirmedStatus("sent")).toBe(true);
    expect(isUnconfirmedStatus("delivered")).toBe(false);
    expect(isReachedStatus("failed")).toBe(false);
    expect(isReachedStatus("undelivered")).toBe(false);
    expect(isSentStatus("scheduled")).toBe(false);
    expect(isReachedStatus("queued")).toBe(false);
  });
});

describe("isOptOutReply", () => {
  it.each(["STOP", "Stop.", "stop please", "Unsubscribe", "STOP ALL", "remove me from your list", "Don’t text me again", "please take me off this list", "opt out"])(
    "treats %j as an opt-out", (s) => expect(isOptOutReply(s)).toBe(true));
  it.each(["Not interested", "Who is this?", "How much?", "I can't stop thinking about it, what's the offer for my minerals in Reeves county", "", null])(
    "treats %j as a reply", (s) => expect(isOptOutReply(s)).toBe(false));
});

describe("summarizeContact", () => {
  it("credits the first reply to the text it followed and counts the person once", () => {
    const s = summarizeContact([out(0), out(3), inn(4), inn(5), inn(9)]);
    expect(s).toMatchObject({ outcome: "RESPONDED", touches: 2, firstOutboundAt: at(0), outboundTotal: 2, inboundTotal: 3 });
    expect(s.responseSeconds).toBe(4 * 86_400);
  });

  it("skips failed and scheduled texts when numbering touches", () => {
    const s = summarizeContact([out(0, "failed"), out(1, "scheduled"), out(2, "sent"), out(3), inn(3.5)]);
    expect(s).toMatchObject({ outcome: "RESPONDED", touches: 2, unconfirmedTouches: 1, firstOutboundAt: at(2) });
  });

  it("an opt-out ends the sequence and is never a response", () => {
    const s = summarizeContact([out(0), out(2), inn(2.1, true), inn(3)]);
    expect(s).toMatchObject({ outcome: "OPTED_OUT", touches: 2, responseSeconds: null });
  });

  it("a reply after the window is a late reply, measured from the most recent text", () => {
    expect(summarizeContact([out(0), out(20), inn(45)], 30).outcome).toBe("RESPONDED");
    expect(summarizeContact([out(0), inn(45)], 30).outcome).toBe("LATE_REPLY");
    expect(summarizeContact([out(0), inn(45)], 60).outcome).toBe("RESPONDED");
  });

  it("leaves contacts who texted first out of outreach", () => {
    const s = summarizeContact([inn(0), out(1), inn(2)]);
    expect(s).toMatchObject({ outcome: "INBOUND_FIRST", firstOutboundAt: null, touches: 0 });
  });

  it("no reply, never reached, and replies despite a failed receipt", () => {
    expect(summarizeContact([out(0), out(4)])).toMatchObject({ outcome: "NO_REPLY", touches: 2 });
    expect(summarizeContact([out(0, "failed"), out(4, "undelivered")])).toMatchObject({ outcome: "NOT_REACHED", touches: 0, firstOutboundAt: null });
    expect(summarizeContact([out(0, "failed", "u7"), inn(1)])).toMatchObject({ outcome: "RESPONDED", touches: 1, unconfirmedTouches: 1, creditedHlUserId: "u7" });
    expect(summarizeContact([]).outcome).toBeNull();
  });

  it("credits the sender of the first reached text, null when automated", () => {
    expect(summarizeContact([out(0, "delivered", null), out(1, "delivered", "u2")]).creditedHlUserId).toBeNull();
    expect(summarizeContact([out(0, "failed", "u9"), out(1, "delivered", "u2")]).creditedHlUserId).toBe("u2");
  });

  it("orders messages itself and puts a same-second text before the reply", () => {
    expect(summarizeContact([inn(0), out(0)])).toMatchObject({ outcome: "RESPONDED", touches: 1, responseSeconds: 0 });
  });
});

describe("touchRates", () => {
  // The spec's example: 100 reached; 25 respond after text 1, 10 after text 2,
  // 5 after text 3; everyone else got 5 texts and never replied.
  const rows: TouchOutcomeCount[] = [
    { touches: 1, outcome: "RESPONDED", count: 25 },
    { touches: 2, outcome: "RESPONDED", count: 10 },
    { touches: 3, outcome: "RESPONDED", count: 5 },
    { touches: 5, outcome: "NO_REPLY", count: 60 },
  ];

  it("gives a 40% cumulative response rate counting unique contacts", () => {
    const r = touchRates(rows);
    expect(r[2].cumulativeRate).toBeCloseTo(0.4);
    expect(r[4].cumulativeRate).toBeCloseTo(0.4);
  });

  it("divides first responses after text n by contacts still waiting at text n", () => {
    const r = touchRates(rows);
    expect(r[0]).toMatchObject({ touch: 1, received: 100, responded: 25 });
    expect(r[0].rate).toBeCloseTo(0.25);
    expect(r[1]).toMatchObject({ received: 75, responded: 10 });
    expect(r[2]).toMatchObject({ received: 65, responded: 5 });
    expect(r[3]).toMatchObject({ received: 60, responded: 0, rate: 0 });
  });

  it("keeps opt-outs in the denominators they reached and rolls later texts into one bucket", () => {
    const r = touchRates([
      { touches: 2, outcome: "OPTED_OUT", count: 4 },
      { touches: 7, outcome: "RESPONDED", count: 1 },
      { touches: 9, outcome: "NO_REPLY", count: 3 },
    ]);
    expect(r[1].received).toBe(8);
    expect(r[5]).toMatchObject({ touch: 6, orLater: true, received: 4, responded: 1 });
    expect(r[5].cumulativeRate).toBeCloseTo(1 / 8);
  });

  it("reports N/A (null) when nobody was reached", () => {
    expect(touchRates([])[0]).toMatchObject({ received: 0, rate: null, cumulativeRate: null });
  });
});

describe("isWrongNumberReply", () => {
  it.each(["Wrong number", "wrong #", "You have the wrong person", "No one by that name here", "No, this isn't Robert", "This is not his number", "you got the wrong guy"])(
    "treats %j as a wrong number", (s) => expect(isWrongNumberReply(s)).toBe(true));
  it.each(["Not interested", "Who is this?", "This is not a good time, call me Monday", "What's the offer?", "", null])(
    "treats %j as a normal reply", (s) => expect(isWrongNumberReply(s)).toBe(false));
});

describe("smsSegments", () => {
  it("counts plain text in 160 / 153 character segments", () => {
    expect(smsSegments("")).toBe(1);
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("a".repeat(306))).toBe(2);
    expect(smsSegments("a".repeat(307))).toBe(3);
  });
  it("counts extension characters twice and switches to Unicode for emoji", () => {
    expect(smsSegments("€".repeat(80))).toBe(1);
    expect(smsSegments("€".repeat(81))).toBe(2);
    expect(smsSegments("Hi 👋")).toBe(1);
    expect(smsSegments("a".repeat(69) + "😀")).toBe(2); // 71 UTF-16 units
  });
});

describe("wrong numbers and speed to lead", () => {
  const wrong = (days: number): SmsMessageInput => ({ ...inn(days), wrongNumber: true });
  const person = (days: number, user = "u5"): SmsMessageInput => ({ ...out(days, "delivered", user), source: "app" });
  const auto = (days: number): SmsMessageInput => ({ ...out(days, "delivered", null), source: "workflow" });

  it("a wrong-number reply is not a response and the outreach carries on", () => {
    const s = summarizeContact([out(0), wrong(1), out(5), out(9), inn(10)]);
    expect(s).toMatchObject({ outcome: "RESPONDED", touches: 3, wrongNumberAt: at(1), wrongNumberTouch: 1 });
  });

  it("only wrong numbers → WRONG_NUMBER, never a response", () => {
    expect(summarizeContact([out(0), wrong(1), out(3)])).toMatchObject({ outcome: "WRONG_NUMBER", touches: 2, responseSeconds: null });
  });

  it("an opt-out worded as a wrong number is still an opt-out", () => {
    expect(summarizeContact([out(0), { ...wrong(1), optOut: true }]).outcome).toBe("OPTED_OUT");
  });

  it("measures the reply → first text a team member typed, skipping automations", () => {
    const s = summarizeContact([out(0), inn(1), auto(1.001), person(1.5, "u9")]);
    expect(s.replyAnsweredSeconds).toBe(Math.round(0.5 * 86_400));
    expect(s.answeredByHlUserId).toBe("u9");
    expect(summarizeContact([out(0), inn(1), auto(2)]).replyAnsweredSeconds).toBeNull();
  });
});

describe("carrierHealth and textingCost", () => {
  it("warns only on a real sample that is well above normal", () => {
    expect(carrierHealth({ sent: 500, failed: 100, reachedContacts: 400, optOuts: 30 }).warnings).toEqual(["optOut", "failure"]);
    expect(carrierHealth({ sent: 500, failed: 20, reachedContacts: 400, optOuts: 8 }).warnings).toEqual([]);
    expect(carrierHealth({ sent: 40, failed: 30, reachedContacts: 10, optOuts: 9 }).warnings).toEqual([]);
  });
  it("prices segments and stays N/A without a price", () => {
    expect(textingCost(34_556, 0.0091)).toBeCloseTo(314.4596);
    expect(textingCost(10, null)).toBeNull();
  });
});
