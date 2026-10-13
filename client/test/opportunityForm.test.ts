/**
 * The Opportunity create/edit form's pure rules (client/src/lib/opportunityForm.ts):
 * required fields, server-equivalent validation, request bodies, edit diffs,
 * and the pipeline/stage choice surviving a refreshed (or stale) pipeline list.
 *
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import {
  checkOppForm, choosePipelineStage, emptyOppForm, isAbstractId, oppBody, oppFormFromRecord, oppPatchBody,
  type OppForm, type PipelineChoice,
} from "../src/lib/opportunityForm";

const form = (over: Partial<OppForm> = {}): OppForm => ({ ...emptyOppForm("u1"), name: "Hernandez minerals", ...over });

describe("checkOppForm", () => {
  it("creating needs a name, a pipeline and a stage", () => {
    expect(checkOppForm(emptyOppForm(), {}).missing).toEqual(["Name", "Pipeline", "Stage"]);
    expect(checkOppForm(form(), { pipelineId: "p1", stage: "NEW" })).toEqual({ missing: [], invalid: [] });
    expect(checkOppForm(form({ name: "   " }), { pipelineId: "p1", stage: "NEW" }).missing).toEqual(["Name"]);
  });

  it("editing needs only the name (pipeline and stage stay as they are)", () => {
    expect(checkOppForm(form(), { editing: true })).toEqual({ missing: [], invalid: [] });
    expect(checkOppForm(form({ name: "" }), { editing: true }).missing).toEqual(["Name"]);
  });

  it("refuses negative or non-numeric estimates, as the server does", () => {
    const { invalid } = checkOppForm(form({ estNma: "-2", estNra: "abc", estAcres: "0" }), { editing: true });
    expect(invalid).toEqual(["Est. NMA must be a number of 0 or more", "Est. NRA must be a number of 0 or more"]);
  });

  it("keeps text to the server's limits and the follow-up to a calendar day", () => {
    const { invalid } = checkOppForm(form({ notes: "x".repeat(10_001), name: "y".repeat(201), nextFollowUpDate: "11/03/2026" }), { editing: true });
    expect(invalid).toEqual([
      "Name is too long (200 characters max)",
      "Notes is too long (10,000 characters max)",
      "Next follow-up is not a valid date",
    ]);
  });
});

describe("oppBody / oppPatchBody", () => {
  it("sends blanks as null and numbers as numbers", () => {
    const b = oppBody(form({ sellerName: "  ", county: " Leon ", estNma: "12.5", estAcres: "0", ownerId: "", nextFollowUpDate: "" }));
    expect(b).toMatchObject({ name: "Hernandez minerals", sellerName: null, county: "Leon", estNma: 12.5, estAcres: 0, ownerId: null, nextFollowUpDate: null });
  });

  it("an edit sends only what changed — and nothing when only whitespace moved", () => {
    const saved = form({ sellerName: "Ann", estNma: "40", notes: "Old" });
    expect(oppPatchBody(saved, { ...saved })).toEqual({});
    expect(oppPatchBody(saved, { ...saved, sellerName: " Ann " })).toEqual({});
    expect(oppPatchBody(saved, { ...saved, estNma: "45", notes: "" })).toEqual({ estNma: 45, notes: null });
  });

  it("round-trips a saved record without inventing changes", () => {
    const saved = oppFormFromRecord({
      name: "Smith", owner: { id: "u9", name: "Ann" }, contactId: "c1", sellerName: "Ann Smith", companyName: null, phone: "9035551234",
      email: null, state: "TX", county: "Leon", abstract: "TX-289653", survey: "W. Dwight", estAcres: null, estNma: 40, estNra: 5,
      source: "Mailer", nextFollowUpDate: "2026-11-03T00:00:00.000Z", notes: null,
    });
    expect(saved).toMatchObject({ ownerId: "u9", contactId: "c1", estNma: "40", estAcres: "", nextFollowUpDate: "2026-11-03", companyName: "" });
    expect(oppPatchBody(saved, { ...saved })).toEqual({});
    expect(oppPatchBody(saved, { ...saved, ownerId: "" })).toEqual({ ownerId: null });
  });
});

describe("choosePipelineStage", () => {
  const stages = (...keys: string[]) => [...keys.map((key) => ({ key, isTerminal: false })), { key: "LOST", isTerminal: true }];
  const list: PipelineChoice[] = [
    { id: "acq", stages: stages("NEW", "CONTACTED") },
    { id: "pros", stages: stages("LEAD", "QUALIFIED") },
  ];

  it("opens on the board's pipeline and its first active stage", () => {
    expect(choosePipelineStage(list, { pipelineId: "", stage: "" }, "pros")).toEqual({ pipelineId: "pros", stage: "LEAD" });
    expect(choosePipelineStage(list, { pipelineId: "", stage: "" })).toEqual({ pipelineId: "acq", stage: "NEW" });
  });

  it("keeps the user's pick while it still exists", () => {
    expect(choosePipelineStage(list, { pipelineId: "pros", stage: "QUALIFIED" }, "acq")).toEqual({ pipelineId: "pros", stage: "QUALIFIED" });
  });

  it("falls back when the picked pipeline was deleted (or belongs to another account)", () => {
    expect(choosePipelineStage(list, { pipelineId: "gone", stage: "X" }, "pros")).toEqual({ pipelineId: "pros", stage: "LEAD" });
    expect(choosePipelineStage(list, { pipelineId: "gone", stage: "X" }, "also-gone")).toEqual({ pipelineId: "acq", stage: "NEW" });
  });

  it("resets a stage that no longer exists, and never starts in a terminal stage", () => {
    expect(choosePipelineStage(list, { pipelineId: "acq", stage: "REMOVED" })).toEqual({ pipelineId: "acq", stage: "NEW" });
    expect(choosePipelineStage(list, { pipelineId: "acq", stage: "LOST" })).toEqual({ pipelineId: "acq", stage: "NEW" });
  });

  it("says there is nothing to pick instead of keeping a stale id", () => {
    expect(choosePipelineStage([], { pipelineId: "acq", stage: "NEW" }, "acq")).toEqual({ pipelineId: "", stage: "" });
    expect(choosePipelineStage([{ id: "empty", stages: [{ key: "LOST", isTerminal: true }] }], { pipelineId: "", stage: "" })).toEqual({ pipelineId: "empty", stage: "" });
  });
});

describe("isAbstractId", () => {
  it("matches the server's GIS id format only", () => {
    expect(isAbstractId("TX-289653")).toBe(true);
    expect(isAbstractId("tx-145-455")).toBe(true);
    expect(isAbstractId("A-123")).toBe(false);
    expect(isAbstractId("Smith Survey")).toBe(false);
    expect(isAbstractId("")).toBe(false);
  });
});
