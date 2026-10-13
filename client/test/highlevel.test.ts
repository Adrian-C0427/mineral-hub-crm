/**
 * HighLevel card wording (client/src/lib/highlevel.ts): what the owner reads
 * on Settings → Integrations before, during and after the first import.
 */
import { describe, it, expect } from "vitest";
import {
  previewText, sizeText, importProgress, importingText, totalsText, lastRunText, RESPONSE_WINDOW_CHOICES, HL_SCOPES,
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
