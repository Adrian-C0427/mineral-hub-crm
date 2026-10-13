/**
 * HighLevel card wording (client/src/lib/highlevel.ts): what the owner reads
 * on Settings → Integrations before, during and after the first import.
 */
import { describe, it, expect } from "vitest";
import {
  previewText, sizeText, importProgress, importingText, totalsText, lastRunText, RESPONSE_WINDOW_CHOICES, HL_SCOPES,
  tagLine, setTagLine, togglePipeline, filterTags, previewCountsText, parsePrice, missingScopesText, type SmsScope,
} from "../src/lib/highlevel";

describe("HighLevel card text", () => {
  it("previews the count and size before anything is imported", () => {
    expect(previewText(5957, 3.9)).toBe("Found 5,957 texts in HighLevel (about 3.9 MB). Nothing has been imported yet.");
    expect(previewText(1, 0.05)).toBe("Found 1 text in HighLevel (less than 0.1 MB). Nothing has been imported yet.");
    expect(previewText(0, null)).toBe("Found 0 texts in HighLevel. Nothing has been imported yet.");
    expect(sizeText(65)).toBe("about 65 MB");
  });

  it("shows import progress without claiming 100% early", () => {
    expect(importProgress(2000, 5957)).toBeCloseTo(0.3357, 3);
    expect(importProgress(6100, 5957)).toBe(0.99); // more arrived since the preview
    expect(importProgress(10, 0)).toBe(0);
    expect(importProgress(10, null)).toBe(0);
    expect(importingText({ imported: 2000, contacts: 528, preview: { texts: 5957, at: "" } })).toBe("Importing… 2,000 of about 5,957 texts · 528 contacts");
    expect(importingText({ imported: 6100, contacts: 1, preview: { texts: 5957, at: "" } })).toBe("Importing… 6,100 texts · 1 contact");
  });

  it("summarizes totals and the last run", () => {
    expect(totalsText({ imported: 5957, contacts: 1500 })).toBe("5,957 texts from 1,500 contacts");
    const run = { at: "", ok: true, newMessages: 3, updatedMessages: 1, contactsFetched: 0, summaries: 3, ms: 900, message: "Up to date — 3 new texts, 1 delivery update." };
    expect(lastRunText(run, "live")).toBe("Last check: 3 new texts, 1 delivery update.");
    expect(lastRunText({ ...run, newMessages: 0, updatedMessages: 0 }, "live")).toBeNull(); // quiet check: nothing to add
    expect(lastRunText(run, "importing")).toBeNull(); // the progress line says it
    expect(lastRunText({ ...run, ok: false, message: "Couldn't reach HighLevel." }, "importing")).toBe("Last check didn't finish: Couldn't reach HighLevel.");
    expect(lastRunText(null, "live")).toBeNull();
  });

  it("offers the server's response windows and only read-only scopes", () => {
    expect([...RESPONSE_WINDOW_CHOICES]).toEqual([7, 14, 30, 60, 90]);
    expect(HL_SCOPES.every((s) => s.endsWith(".readonly"))).toBe(true);
    expect(HL_SCOPES).toHaveLength(8);
  });
});

describe("HighLevel Configure — Minerals filter and price", () => {
  const scope: SmsScope = { mineralTags: ["leon county"], realEstateTags: ["dispo"], mineralPipelineIds: ["pMin"] };

  it("reads and moves a tag between Minerals / Real estate / Neither (capitals and spaces ignored)", () => {
    expect(tagLine(scope, "Leon  County")).toBe("minerals");
    expect(tagLine(scope, "DISPO")).toBe("realEstate");
    expect(tagLine(scope, "tiny")).toBe("neither");
    const moved = setTagLine(scope, "Dispo", "minerals");
    expect(moved).toEqual({ mineralTags: ["leon county", "dispo"], realEstateTags: [], mineralPipelineIds: ["pMin"] });
    expect(setTagLine(moved, "LEON COUNTY", "neither").mineralTags).toEqual(["dispo"]);
    expect(setTagLine(scope, "Sub2", "realEstate").realEstateTags).toEqual(["dispo", "sub2"]);
    expect(togglePipeline(scope, "pMin", false).mineralPipelineIds).toEqual([]);
    expect(togglePipeline(scope, "pTiny", true).mineralPipelineIds).toEqual(["pMin", "pTiny"]);
  });

  it("filters the tag list by search and by line", () => {
    const tags = [{ name: "Leon County" }, { name: "dispo" }, { name: "leon bullrun" }, { name: "tiny" }];
    expect(filterTags(tags, scope, " leon ", "all").map((t) => t.name)).toEqual(["Leon County", "leon bullrun"]);
    expect(filterTags(tags, scope, "", "minerals").map((t) => t.name)).toEqual(["Leon County"]);
    expect(filterTags(tags, scope, "", "neither").map((t) => t.name)).toEqual(["leon bullrun", "tiny"]);
    expect(filterTags(tags, scope, "zzz", "all")).toEqual([]);
  });

  it("words the live preview", () => {
    expect(previewCountsText({ texted: 382, minerals: 312, realEstate: 54, unclassified: 16 })).toBe("Minerals 312 · Real estate 54 · Not classified 16 texted people");
    expect(previewCountsText({ texted: 1, minerals: 1, realEstate: 0, unclassified: 0 })).toBe("Minerals 1 · Real estate 0 · Not classified 0 texted person");
  });

  it("parses the price per segment in dollars", () => {
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("  ")).toBeNull();
    expect(parsePrice("0.0091")).toBe(0.0091);
    expect(parsePrice("$0.0091")).toBe(0.0091);
    expect(parsePrice(".01")).toBe(0.01);
    expect(parsePrice("0,0091")).toBe(0.0091);
    expect(parsePrice("0.00912345")).toBe(0.009123);
    expect(parsePrice("1")).toBe(1);
    expect(parsePrice("9.1")).toBe("invalid");
    expect(parsePrice("-0.01")).toBe("invalid");
    expect(parsePrice("abc")).toBe("invalid");
    expect(parsePrice("1e-3")).toBe("invalid");
  });

  it("explains a key that can't read opportunities or tags", () => {
    expect(missingScopesText([])).toBeNull();
    expect(missingScopesText(undefined)).toBeNull();
    expect(missingScopesText(["opportunities.readonly"])).toBe("This key can't read opportunities (offers and the funnel stay empty). Use Replace key with a key that has opportunities.readonly ticked.");
    expect(missingScopesText(["opportunities.readonly", "locations/tags.readonly"])).toMatch(/opportunities .* or the tag list .* opportunities\.readonly and locations\/tags\.readonly ticked\.$/);
  });

  it("mentions observed pipeline stage changes in the last-run line", () => {
    const run = { at: "", ok: true, newMessages: 0, updatedMessages: 0, contactsFetched: 0, summaries: 0, ms: 1, message: "", stageMoves: 2 };
    expect(lastRunText(run, "live")).toBe("Last check: 2 pipeline stage changes.");
  });
});

describe("tagRefreshText", () => {
  it("shows progress while running and the outcome after", async () => {
    const { tagRefreshText } = await import("../src/lib/highlevel");
    const base = { startedAt: "2026-10-13T16:00:00Z", auto: false, total: 12_410, etaMinutes: 0 };
    expect(tagRefreshText(null, () => "")).toBeNull();
    expect(tagRefreshText({ ...base, running: true, finishedAt: null, done: 3_200, changed: 0, etaMinutes: 31 }, () => ""))
      .toBe("Re-reading tags from HighLevel: 3,200 of 12,410 contacts · about 31 minutes left. Reports re-sort as it goes.");
    expect(tagRefreshText({ ...base, running: false, finishedAt: "2026-10-13T16:41:00Z", done: 12_410, changed: 2_310 }, () => "Oct 13, 11:41 AM"))
      .toBe("Tags re-read Oct 13, 11:41 AM — 2,310 contacts' tags changed.");
    expect(tagRefreshText({ ...base, running: false, finishedAt: "2026-10-13T16:41:00Z", done: 12_410, changed: 0 }, () => "today"))
      .toBe("Tags re-read today — no contact's tags had changed.");
  });
});

describe("crmTagsText", () => {
  it("explains a missing permission, shows progress, then the steady state; nothing while off", async () => {
    const { crmTagsText } = await import("../src/lib/highlevel");
    const t = { enabled: true, removing: false, working: false, pending: 0, tagged: 9_812, error: null, lastWriteAt: null, written: 9_812 };
    expect(crmTagsText({ ...t, enabled: false })).toBeNull();
    expect(crmTagsText({ ...t, error: "permission" })?.warn).toBe(true);
    expect(crmTagsText({ ...t, error: "permission" })?.text).toMatch(/contacts\.write/);
    expect(crmTagsText({ ...t, working: true, pending: 3_100 })?.text).toBe("Tagging contacts in HighLevel: 3,100 contacts left to check.");
    expect(crmTagsText({ ...t, enabled: false, removing: true, working: true, pending: 40 })?.text).toBe("Removing Mineral Hub's tags from HighLevel: 40 contacts left.");
    expect(crmTagsText(t)?.text).toBe("SMS & Acquisition tags on 9,812 contacts in HighLevel · kept in step with Reports every 15 minutes.");
  });
});
