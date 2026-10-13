import { describe, it, expect } from "vitest";
import { classifyContact, suggestScope, phoneTagKinds, PHONE_TAG_SQL, type SmsScope } from "./smsScope.js";

const scope: SmsScope = {
  mineralTags: ["reeves county", "new lease", "Outside Buy Box"],
  realEstateTags: ["driving for dollars", "sub2"],
  mineralPipelineIds: ["pMinerals"],
};

describe("classifyContact", () => {
  it("minerals by tag or pipeline, real estate by tag, otherwise unclassified", () => {
    expect(classifyContact(["Reeves County "], [], scope)).toBe("minerals");
    expect(classifyContact(["outside buy box"], [], scope)).toBe("minerals");
    expect(classifyContact(["probate"], ["pMinerals"], scope)).toBe("minerals");
    expect(classifyContact(["sub2", "probate"], [], scope)).toBe("real_estate");
    expect(classifyContact(["probate"], ["pOther"], scope)).toBe("unclassified");
    expect(classifyContact([], [], scope)).toBe("unclassified");
  });
  it("a minerals signal wins over a real-estate tag", () => {
    expect(classifyContact(["new lease", "driving for dollars"], [], scope)).toBe("minerals");
  });
});

describe("suggestScope", () => {
  it("starts from county / mineral tags and mineral pipelines", () => {
    const s = suggestScope(["reeves county", "mineral sms blast", "sub2", "probate"], [{ id: "a", name: "Minerals v2" }, { id: "b", name: "On-Market" }]);
    expect(s).toEqual({ mineralTags: ["reeves county", "mineral sms blast"], realEstateTags: [], mineralPipelineIds: ["a"] });
  });
});

describe("phoneTagKinds", () => {
  it("reads XLeads' phone-rotation tags", () => {
    const k = phoneTagKinds(["wrong number-2", "Disconnected Number-1", "landline", "switch phone (2)", "switch phone (1)", "all numbers exhausted", "sms incapable"]);
    expect([...k].sort()).toEqual(["disconnected", "exhausted", "landline", "rotated", "smsIncapable", "wrongNumber"]);
    expect(phoneTagKinds(["switch phone (1)", "wrong numbers list"]).size).toBe(0);
  });
  it("exposes the same rules for SQL", () => {
    expect(new RegExp(PHONE_TAG_SQL.wrongNumber).test("wrong number-3")).toBe(true);
  });
});
