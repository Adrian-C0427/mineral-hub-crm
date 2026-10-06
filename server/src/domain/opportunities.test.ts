import { describe, it, expect } from "vitest";
import {
  convertedDealFields,
  convertedDealNotes,
  convertedSeller,
  isAbstractId,
  normalizeAbstractId,
  sellerPreferredMethod,
  serializeOpportunity,
  serializeOpportunitySummary,
  splitPersonName,
  type ConvertibleContact,
  type ConvertibleOpportunity,
} from "./opportunities.js";
import {
  DEFAULT_STAGES,
  OPPORTUNITY_DEFAULT_STAGES,
  OPPORTUNITY_TERMINAL_STAGE_KEYS,
  TERMINAL_STAGE_KEYS,
  TERMINAL_STAGES,
  isOpportunityPipeline,
  isTerminalKeyForKind,
  terminalKeysForKind,
} from "./stages.js";

const opp = (over: Partial<ConvertibleOpportunity> = {}): ConvertibleOpportunity => ({
  name: "Smith minerals",
  ownerId: null,
  sellerName: null,
  companyName: null,
  phone: null,
  email: null,
  state: null,
  county: null,
  abstract: null,
  survey: null,
  estAcres: null,
  estNma: null,
  estNra: null,
  source: null,
  notes: null,
  ...over,
});

describe("abstract id format", () => {
  it("recognises the app's GIS keys and nothing else", () => {
    for (const id of ["TX-289653", "tx-289653", "TX-145-455", " TX-1 "]) expect(isAbstractId(id)).toBe(true);
    for (const label of ["A-15", "15", "ABST 015", "Smith Survey", "", null, undefined, "TX-", "TX289653"]) expect(isAbstractId(label)).toBe(false);
  });
  it("normalises to the stored upper-case form", () => {
    expect(normalizeAbstractId(" tx-289653 ")).toBe("TX-289653");
  });
});

describe("convertedDealFields", () => {
  it("maps name, geography, acreage and owner; a GIS abstract id lands in abstractIds", () => {
    const d = convertedDealFields(opp({ ownerId: "u2", state: "TX", county: "Leon", abstract: "tx-289653", estNma: 40, estAcres: 120, estNra: 5 }), "actor");
    expect(d).toMatchObject({
      name: "Smith minerals",
      recordType: "OPPORTUNITY",
      assetMode: null,
      sellerNames: [],
      state: "TX",
      states: ["TX"],
      counties: ["Leon"],
      abstractIds: ["TX-289653"],
      acreageNma: 40,
      nra: 5,
      notes: null,
      relationshipOwnerId: "u2",
    });
  });
  it("falls back to estAcres for NMA and to the converting user as owner", () => {
    const d = convertedDealFields(opp({ estAcres: 120 }), "actor");
    expect(d.acreageNma).toBe(120);
    expect(d.nra).toBeNull();
    expect(d.relationshipOwnerId).toBe("actor");
    expect(d.states).toEqual([]);
    expect(d.counties).toEqual([]);
    expect(d.state).toBeNull();
  });
  it("prefers estNma over estAcres and keeps a zero", () => {
    expect(convertedDealFields(opp({ estNma: 0, estAcres: 120 }), "a").acreageNma).toBe(0);
  });
  it("sends a non-id abstract (and the survey) to the notes instead of abstractIds", () => {
    const d = convertedDealFields(opp({ abstract: "A-15", survey: "SMITH, J", notes: "Called twice.", source: "Mailer" }), "a");
    expect(d.abstractIds).toEqual([]);
    expect(d.notes).toBe("Source: Mailer\n\nCalled twice.\n\nAbstract: A-15, Survey: SMITH, J");
  });
});

describe("convertedDealNotes", () => {
  it("is null when there is nothing to say", () => {
    expect(convertedDealNotes(opp())).toBeNull();
    expect(convertedDealNotes(opp({ source: "  ", notes: "" }))).toBeNull();
  });
  it("keeps only the survey line when the abstract is a GIS id", () => {
    expect(convertedDealNotes(opp({ abstract: "TX-289653", survey: "Dunn" }))).toBe("Survey: Dunn");
    expect(convertedDealNotes(opp({ abstract: "TX-289653" }))).toBeNull();
  });
  it("prefixes the source and appends the location line", () => {
    expect(convertedDealNotes(opp({ source: "Referral", abstract: "15" }))).toBe("Source: Referral\n\nAbstract: 15");
    expect(convertedDealNotes(opp({ notes: "n", survey: "S" }))).toBe("n\n\nSurvey: S");
  });
});

describe("convertedSeller", () => {
  const contact: ConvertibleContact = {
    firstName: "Mary", lastName: "Smith", entityName: "Smith Family Trust",
    phone: "(903) 555-0101", email: "mary@example.com", preferredContact: "CALL",
    mailingStreet: "1 Main St", mailingCity: "Centerville", mailingState: "TX", mailingZip: "75833",
  };
  it("builds the primary seller from the linked contact", () => {
    expect(convertedSeller(opp({ sellerName: "ignored" }), contact)).toEqual({
      isPrimary: true,
      firstName: "Mary", lastName: "Smith", companyName: "Smith Family Trust",
      primaryPhone: "9035550101", email: "mary@example.com", preferredContactMethod: "Phone",
      mailingAddress: "1 Main St", mailingCity: "Centerville", mailingState: "TX", mailingZip: "75833",
    });
  });
  it("falls back to the plain seller fields when there is no contact", () => {
    expect(convertedSeller(opp({ sellerName: "John Q Public", companyName: "JQP LLC", phone: "903-555-0102", email: "j@x.com" }), null)).toEqual({
      isPrimary: true,
      firstName: "John Q", lastName: "Public", companyName: "JQP LLC",
      primaryPhone: "9035550102", email: "j@x.com", preferredContactMethod: null,
      mailingAddress: null, mailingCity: null, mailingState: null, mailingZip: null,
    });
  });
  it("creates no seller when there is nothing to record", () => {
    expect(convertedSeller(opp(), null)).toBeNull();
    expect(convertedSeller(opp({ sellerName: "  " }), null)).toBeNull();
  });
});

describe("name and preferred-method helpers", () => {
  it("splits names the way people write them", () => {
    expect(splitPersonName("Mary Ann Smith")).toEqual({ firstName: "Mary Ann", lastName: "Smith" });
    expect(splitPersonName("Smith, Mary")).toEqual({ firstName: "Mary", lastName: "Smith" });
    expect(splitPersonName("Cher")).toEqual({ firstName: "Cher", lastName: null });
    expect(splitPersonName("")).toEqual({ firstName: null, lastName: null });
  });
  it("maps contact codes to seller labels and passes unknown values through", () => {
    expect(sellerPreferredMethod("CALL")).toBe("Phone");
    expect(sellerPreferredMethod("text")).toBe("Text");
    expect(sellerPreferredMethod("EMAIL")).toBe("Email");
    expect(sellerPreferredMethod("MAIL")).toBe("Mail");
    expect(sellerPreferredMethod("Carrier pigeon")).toBe("Carrier pigeon");
    expect(sellerPreferredMethod(null)).toBeNull();
  });
});

describe("serializers", () => {
  const t = new Date("2026-10-06T12:00:00Z");
  const row = {
    id: "o1", name: "N", pipelineId: "p1", stage: "NEW_OPPORTUNITY", currentStageEnteredAt: t,
    owner: { id: "u1", name: "Ann" }, contactId: "c1", sellerName: "S", companyName: null, phone: "1", email: "e",
    state: "TX", county: "Leon", abstract: "A-1", survey: "Sv", estAcres: 1, estNma: 2, estNra: 3, source: "src", notes: "n",
    lastActivityAt: t, nextFollowUpDate: null, convertedDealId: null, convertedAt: null, closeReason: null, createdAt: t,
  };
  it("summary carries the board fields and no notes/phone/email", () => {
    const s = serializeOpportunitySummary(row);
    expect(s).toMatchObject({ id: "o1", owner: { id: "u1", name: "Ann" }, estNma: 2, source: "src" });
    expect("notes" in s).toBe(false);
    expect("phone" in s).toBe(false);
  });
  it("detail adds contact, converted deal and both trails", () => {
    const d = serializeOpportunity({
      ...row,
      contact: { id: "c1", firstName: "F", lastName: "L", entityName: null, phone: null, email: null },
      convertedDeal: { id: "d1", name: "Deal", stage: "UNDER_CONTRACT" },
      stageHistory: [{ id: "h1", fromStage: "", toStage: "NEW_OPPORTUNITY", reason: null, changedBy: null, createdAt: t }],
      activities: [{ id: "a1", kind: "NOTE", body: "hi", createdBy: { id: "u1", name: "Ann" }, createdAt: t }],
    });
    expect(d.phone).toBe("1");
    expect(d.notes).toBe("n");
    expect(d.contact).toEqual({ id: "c1", firstName: "F", lastName: "L", entityName: null, phone: null, email: null });
    expect(d.convertedDeal).toEqual({ id: "d1", name: "Deal", stage: "UNDER_CONTRACT" });
    expect(d.stageHistory).toEqual([{ id: "h1", fromStage: "", toStage: "NEW_OPPORTUNITY", reason: null, changedBy: null, createdAt: t }]);
    expect(d.activities[0].createdBy).toEqual({ id: "u1", name: "Ann" });
  });
});

describe("pipeline kinds (domain/stages)", () => {
  it("seeds opportunity pipelines with the starter set ending in Passed / Lost", () => {
    expect(OPPORTUNITY_DEFAULT_STAGES.map((s) => s.label)).toEqual(["New Opportunity", "Researching", "Contacted", "Interested", "Negotiating", "Passed", "Lost"]);
    expect(OPPORTUNITY_DEFAULT_STAGES.filter((s) => s.isTerminal).map((s) => s.key)).toEqual([...OPPORTUNITY_TERMINAL_STAGE_KEYS]);
    expect(OPPORTUNITY_TERMINAL_STAGE_KEYS).toEqual(["PASSED", "LOST"]);
  });
  it("leaves the deals defaults untouched", () => {
    expect(TERMINAL_STAGE_KEYS).toEqual(["CLOSED", "DEAD"]);
    expect(DEFAULT_STAGES.map((s) => s.key)).toEqual(["UNDER_CONTRACT", "PREPARING_PACKAGE", "SENT_TO_BUYERS", "NEGOTIATING", "CLOSING", "CLOSED", "DEAD"]);
    expect(TERMINAL_STAGES.map((s) => s.key)).toEqual(["CLOSED", "DEAD"]);
  });
  it("answers terminal keys per kind", () => {
    expect(terminalKeysForKind("DEALS")).toEqual(["CLOSED", "DEAD"]);
    expect(terminalKeysForKind("OPPORTUNITIES")).toEqual(["PASSED", "LOST"]);
    expect(isTerminalKeyForKind("OPPORTUNITIES", "PASSED")).toBe(true);
    expect(isTerminalKeyForKind("OPPORTUNITIES", "CLOSED")).toBe(false);
    expect(isTerminalKeyForKind("DEALS", "DEAD")).toBe(true);
    expect(isTerminalKeyForKind("DEALS", "LOST")).toBe(false);
    expect(isOpportunityPipeline({ kind: "OPPORTUNITIES" })).toBe(true);
    expect(isOpportunityPipeline({ kind: "DEALS" })).toBe(false);
  });
});
