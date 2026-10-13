import { describe, it, expect } from "vitest";
import { desiredCrmTags, acquisitionTag, tagDiff, isCrmTag, CRM_TAGS, ACQUISITION_TAGS as A, type TagInputs } from "./smsTags.js";

const base: TagInputs = { touches: 0, outcome: null, smsOptedOut: false, opportunities: [] };

describe("desiredCrmTags", () => {
  it("tags each text reached before the first reply, cumulatively, capped at 4+", () => {
    expect(desiredCrmTags({ ...base, touches: 2, outcome: "NO_REPLY" })).toEqual(["SMS - Text 1 Sent", "SMS - Text 2 Sent"]);
    expect(desiredCrmTags({ ...base, touches: 7, outcome: "NO_REPLY" })).toEqual(["SMS - Text 1 Sent", "SMS - Text 2 Sent", "SMS - Text 3 Sent", "SMS - Text 4+ Sent"]);
    expect(desiredCrmTags({ ...base, touches: 0, outcome: "NOT_REACHED" })).toEqual([]);
  });

  it("marks the text the first counted reply came after — not the latest text sent", () => {
    expect(desiredCrmTags({ ...base, touches: 3, outcome: "RESPONDED" })).toEqual(["SMS - Text 1 Sent", "SMS - Text 2 Sent", "SMS - Text 3 Sent", "SMS - Responded - Text 3"]);
    expect(desiredCrmTags({ ...base, touches: 6, outcome: "RESPONDED" })).toContain("SMS - Responded - Text 4+");
  });

  it("wrong numbers, opt-outs and late replies never earn a Responded tag", () => {
    for (const outcome of ["WRONG_NUMBER", "OPTED_OUT", "LATE_REPLY", "NO_REPLY", "INBOUND_FIRST"]) {
      expect(desiredCrmTags({ ...base, touches: 2, outcome }).some((t) => t.startsWith("SMS - Responded"))).toBe(false);
    }
  });
});

describe("acquisitionTag", () => {
  const opp = (step: string) => ({ step });
  it("follows the furthest live opportunity; Under Contract = Deal Created", () => {
    expect(acquisitionTag({ ...base, opportunities: [opp("opportunity")] })).toBe(A.interested);
    expect(acquisitionTag({ ...base, opportunities: [opp("opportunity"), opp("negotiating")] })).toBe(A.offer);
    expect(acquisitionTag({ ...base, opportunities: [opp("not_accepted")] })).toBe(A.offer);
    expect(acquisitionTag({ ...base, opportunities: [opp("accepted")] })).toBe(A.accepted);
    expect(acquisitionTag({ ...base, opportunities: [opp("contract"), opp("dead")] })).toBe(A.contract);
    expect(acquisitionTag({ ...base, opportunities: [opp("closed")] })).toBe(A.closed);
    expect(acquisitionTag({ ...base, opportunities: [opp("dead"), opp("dead")] })).toBe(A.notInterested);
    expect(acquisitionTag(base)).toBeNull();
  });
  it("an opt-out or SMS do-not-disturb is Do Not Contact unless an offer is in play", () => {
    expect(acquisitionTag({ ...base, outcome: "OPTED_OUT" })).toBe(A.doNotContact);
    expect(acquisitionTag({ ...base, smsOptedOut: true, opportunities: [opp("opportunity")] })).toBe(A.doNotContact);
    expect(acquisitionTag({ ...base, smsOptedOut: true, opportunities: [opp("dead")] })).toBe(A.doNotContact);
    expect(acquisitionTag({ ...base, smsOptedOut: true, opportunities: [opp("offer")] })).toBe(A.offer);
  });
});

describe("tagDiff", () => {
  it("adds what's missing and removes only CRM tags that no longer apply", () => {
    const current = ["leon county", "SMS - Text 1 Sent", "sms - responded - text 1", "Acquisition - Interested", "interested"];
    const desired = ["SMS - Text 1 Sent", "SMS - Text 2 Sent", "Acquisition - Offer Made"];
    expect(tagDiff(current, desired)).toEqual({
      add: ["SMS - Text 2 Sent", "Acquisition - Offer Made"],
      remove: ["sms - responded - text 1", "Acquisition - Interested"],
    });
  });
  it("is empty when nothing changed (no duplicate writes), and removing everything leaves other tags", () => {
    expect(tagDiff(["sms - text 1 sent", "x"], ["SMS - Text 1 Sent"])).toEqual({ add: [], remove: [] });
    expect(tagDiff(["SMS - Text 1 Sent", "minerals"], [])).toEqual({ add: [], remove: ["SMS - Text 1 Sent"] });
  });
  it("knows its own tags", () => {
    expect(CRM_TAGS).toHaveLength(15);
    expect(isCrmTag(" acquisition -  deal closed ")).toBe(true);
    expect(isCrmTag("offer made")).toBe(false);
  });
});
