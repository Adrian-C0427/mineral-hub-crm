/**
 * The Minerals filter's counts (services/highlevel/scope.ts): the live
 * preview must split texted people exactly as the sync stores their line.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../db.js", () => ({ prisma: {} }));

import { countLines, scopeOptionsFrom } from "./scope.js";
import { classifyContact } from "../../domain/smsScope.js";

const people = [
  { tags: ["Leon County"], pipelineIds: [] },
  { tags: ["dispo"], pipelineIds: [] },
  { tags: ["dispo"], pipelineIds: ["pMin"] }, // a minerals pipeline wins over a real-estate tag
  { tags: [], pipelineIds: ["pRE"] },
  { tags: ["switch phone (2)"], pipelineIds: [] },
];
const scope = { mineralTags: ["leon county"], realEstateTags: ["dispo"], mineralPipelineIds: ["pMin"] };

describe("countLines", () => {
  it("splits texted people the same way classifyContact stores each line", () => {
    const counts = countLines(people, scope);
    expect(counts).toEqual({ texted: 5, minerals: 2, realEstate: 1, unclassified: 2 });
    const stored = people.map((p) => classifyContact(p.tags, p.pipelineIds, scope));
    expect(stored.filter((l) => l === "minerals")).toHaveLength(counts.minerals);
    expect(stored.filter((l) => l === "real_estate")).toHaveLength(counts.realEstate);
    expect(stored.filter((l) => l === "unclassified")).toHaveLength(counts.unclassified);
    expect(countLines([], scope)).toEqual({ texted: 0, minerals: 0, realEstate: 0, unclassified: 0 });
  });
});

describe("scopeOptionsFrom", () => {
  it("lists HighLevel's tags plus tags only seen on contacts, most-used first, and pipelines with their texted people", () => {
    const r = scopeOptionsFrom(
      [...people, { tags: ["DISPO", "dispo"], pipelineIds: ["pMin", "pMin"] }],
      ["dispo", "Leon County", "sms land"],
      [{ id: "pMin", name: "Minerals", stages: [] }, { id: "pRE", name: "On-Market", stages: [] }, { id: "pJV", name: "JV's", stages: [] }],
    );
    expect(r.tags).toEqual([
      { name: "dispo", texted: 3 }, { name: "Leon County", texted: 1 }, { name: "switch phone (2)", texted: 1 }, { name: "sms land", texted: 0 },
    ]);
    expect(r.pipelines).toEqual([{ id: "pMin", name: "Minerals", texted: 2 }, { id: "pRE", name: "On-Market", texted: 1 }, { id: "pJV", name: "JV's", texted: 0 }]);
  });
});
