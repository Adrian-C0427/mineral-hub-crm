import { describe, it, expect } from "vitest";
import { stageStep, stepRank, offerMade } from "./smsFunnel.js";

describe("stageStep", () => {
  it.each([
    ["Needs Offer", "opportunity"], ["Follow Up", "opportunity"], ["Offer Made", "offer"], ["In Negotiation", "negotiating"],
    ["Accepted Offer", "accepted"], ["Offer Not Accepted", "not_accepted"], ["Under Contract", "contract"],
    ["Closed", "closed"], ["Won", "closed"], ["Dead", "dead"], ["Lost/abandoned", "dead"],
  ])("%s → %s", (stage, step) => expect(stageStep(stage, "Minerals")).toBe(step));

  it("uses the pipeline for a declined-offers pipeline and the status over the stage", () => {
    expect(stageStep("Follow up in 30 days", "Offer Not Accepted")).toBe("not_accepted");
    expect(stageStep("Needs Offer", "Minerals", "won")).toBe("closed");
    expect(stageStep("Offer Made", "Minerals", "lost")).toBe("dead");
  });
});

describe("offerMade", () => {
  it("counts an offer once reached, even if the deal later died", () => {
    expect(offerMade(stepRank("offer"))).toBe(true);
    expect(offerMade(stepRank("opportunity"))).toBe(false);
    expect(offerMade(0, "not_accepted")).toBe(true);
    expect(stepRank("closed")).toBeGreaterThan(stepRank("contract"));
  });
});
