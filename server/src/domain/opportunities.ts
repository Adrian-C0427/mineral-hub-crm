/**
 * Opportunities — lightweight prospects tracked through an OPPORTUNITIES
 * pipeline (see domain/stages.ts). The pure parts live here: the field mapping
 * used when an opportunity is converted into a Deal, the abstract-id format
 * check that decides where the abstract lands, and the API serializers. The
 * router (routes/opportunities.ts) does the database work.
 */
import { normalizePhone } from "./phone.js";

export const OPPORTUNITY_ACTIVITY_KINDS = ["NOTE", "CALL", "EMAIL", "TEXT", "MEETING"] as const;
export const CONVERT_MODES = ["MANUAL", "AUTO"] as const;

// Deal.abstractIds holds GIS keys — "TX-289653" (gis.abstracts.id) or the
// older "TX-145-455" shape. Anything else ("A-15", "15", "Smith Survey") is a
// human label and goes into the deal notes instead, where it stays readable.
const ABSTRACT_ID_RE = /^[A-Za-z]{2}-\d+(?:-\d+)*$/;

/** True when `raw` is an app abstract id ("TX-289653") rather than a label. */
export function isAbstractId(raw: string | null | undefined): boolean {
  return ABSTRACT_ID_RE.test((raw ?? "").trim());
}

/** Canonical form of an abstract id: trimmed, upper-cased ("tx-289653" → "TX-289653"). */
export function normalizeAbstractId(raw: string): string {
  return raw.trim().toUpperCase();
}

const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

/** The opportunity fields conversion reads. */
export interface ConvertibleOpportunity {
  name: string;
  ownerId: string | null;
  sellerName: string | null;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  state: string | null;
  county: string | null;
  abstract: string | null;
  survey: string | null;
  estAcres: number | null;
  estNma: number | null;
  estNra: number | null;
  source: string | null;
  notes: string | null;
}

/** The linked Contact fields conversion reads (the seller record is built from these). */
export interface ConvertibleContact {
  firstName: string;
  lastName: string;
  entityName: string | null;
  phone: string | null;
  email: string | null;
  preferredContact: string | null;
  mailingStreet: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
}

/**
 * The deal notes a conversion writes: "Source: …" first, then the
 * opportunity's own notes, then the abstract/survey line when the abstract is
 * not an app abstract id (the survey alone when it is — Deal has no survey
 * field for acquisitions). Null when nothing applies.
 */
export function convertedDealNotes(o: Pick<ConvertibleOpportunity, "source" | "notes" | "abstract" | "survey">): string | null {
  const parts: string[] = [];
  const source = clean(o.source);
  if (source) parts.push(`Source: ${source}`);
  const notes = clean(o.notes);
  if (notes) parts.push(notes);
  const abstract = clean(o.abstract);
  const survey = clean(o.survey);
  const location: string[] = [];
  if (abstract && !isAbstractId(abstract)) location.push(`Abstract: ${abstract}`);
  if (survey) location.push(`Survey: ${survey}`);
  if (location.length) parts.push(location.join(", "));
  return parts.length ? parts.join("\n\n") : null;
}

/**
 * Deal columns derived from an opportunity. Everything else (stage, pipeline,
 * timestamps) is the router's job; the shape mirrors what POST /deals writes
 * for a hand-created acquisition so the converted deal is indistinguishable.
 *   name → name; owner → relationshipOwner (the converting user when unset);
 *   state → state/states; county → counties; abstract → abstractIds when it is
 *   an app abstract id, else into the notes; estNma (else estAcres) →
 *   acreageNma; estNra → nra; source/notes/survey → notes.
 */
export function convertedDealFields(o: ConvertibleOpportunity, actorUserId: string) {
  const state = clean(o.state);
  const county = clean(o.county);
  const abstract = clean(o.abstract);
  return {
    name: o.name,
    recordType: "OPPORTUNITY" as const,
    assetMode: null,
    sellerNames: [] as string[],
    states: state ? [state] : [],
    state: state,
    counties: county ? [county] : [],
    abstractIds: abstract && isAbstractId(abstract) ? [normalizeAbstractId(abstract)] : [],
    acreageNma: o.estNma ?? o.estAcres ?? null,
    nra: o.estNra ?? null,
    notes: convertedDealNotes(o),
    relationshipOwnerId: o.ownerId ?? actorUserId,
  };
}

/** "Mary Ann Smith" → first "Mary Ann", last "Smith"; a single token is a first name. */
export function splitPersonName(full: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const s = (full ?? "").trim().replace(/\s+/g, " ");
  if (!s) return { firstName: null, lastName: null };
  // "Smith, Mary" (recorded-name order) → Mary Smith.
  const comma = s.match(/^([^,]+),\s*(.+)$/);
  if (comma) return { firstName: comma[2].trim(), lastName: comma[1].trim() };
  const i = s.lastIndexOf(" ");
  if (i < 0) return { firstName: s, lastName: null };
  return { firstName: s.slice(0, i), lastName: s.slice(i + 1) };
}

// Contact.preferredContact codes → DealSeller.preferredContactMethod labels.
const PREFERRED_METHOD: Record<string, string> = { CALL: "Phone", PHONE: "Phone", TEXT: "Text", EMAIL: "Email", MAIL: "Mail" };
export function sellerPreferredMethod(code: string | null | undefined): string | null {
  const c = (code ?? "").trim();
  if (!c) return null;
  return PREFERRED_METHOD[c.toUpperCase()] ?? c;
}

/**
 * The primary DealSeller a conversion creates: from the linked Contact when
 * there is one (name, company, phone, email, mailing address, preferred
 * method), else from the opportunity's plain seller fields. Null when there is
 * nothing to record — a hand-created deal without seller details has no row.
 */
export function convertedSeller(o: ConvertibleOpportunity, contact: ConvertibleContact | null) {
  if (contact) {
    const phone = clean(contact.phone);
    return {
      isPrimary: true,
      firstName: clean(contact.firstName),
      lastName: clean(contact.lastName),
      companyName: clean(contact.entityName),
      primaryPhone: phone ? normalizePhone(phone) : null,
      email: clean(contact.email),
      preferredContactMethod: sellerPreferredMethod(contact.preferredContact),
      mailingAddress: clean(contact.mailingStreet),
      mailingCity: clean(contact.mailingCity),
      mailingState: clean(contact.mailingState),
      mailingZip: clean(contact.mailingZip),
    };
  }
  const name = splitPersonName(o.sellerName);
  const companyName = clean(o.companyName);
  const phone = clean(o.phone);
  const email = clean(o.email);
  if (!name.firstName && !companyName && !phone && !email) return null;
  return {
    isPrimary: true,
    firstName: name.firstName,
    lastName: name.lastName,
    companyName,
    primaryPhone: phone ? normalizePhone(phone) : null,
    email,
    preferredContactMethod: null,
    mailingAddress: null,
    mailingCity: null,
    mailingState: null,
    mailingZip: null,
  };
}

// ---------------------------------------------------------------------------
// Serializers (the API shapes the client consumes)
// ---------------------------------------------------------------------------

type UserRef = { id: string; name: string } | null;

export interface OpportunityRow {
  id: string;
  name: string;
  pipelineId: string;
  stage: string;
  currentStageEnteredAt: Date;
  owner: UserRef;
  contactId: string | null;
  sellerName: string | null;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  state: string | null;
  county: string | null;
  abstract: string | null;
  survey: string | null;
  estAcres: number | null;
  estNma: number | null;
  estNra: number | null;
  source: string | null;
  notes: string | null;
  lastActivityAt: Date | null;
  nextFollowUpDate: Date | null;
  convertedDealId: string | null;
  convertedAt: Date | null;
  closeReason: string | null;
  createdAt: Date;
}

export interface OpportunityDetailRow extends OpportunityRow {
  contact: { id: string; firstName: string; lastName: string; entityName: string | null; phone: string | null; email: string | null } | null;
  convertedDeal: { id: string; name: string; stage: string } | null;
  stageHistory: { id: string; fromStage: string; toStage: string; reason: string | null; changedBy: UserRef; createdAt: Date }[];
  activities: { id: string; kind: string; body: string; createdBy: UserRef; createdAt: Date }[];
}

const userRef = (u: { id: string; name: string } | null | undefined): UserRef => (u ? { id: u.id, name: u.name } : null);

/** Board/list card: `OppSummary`. */
export function serializeOpportunitySummary(o: OpportunityRow) {
  return {
    id: o.id,
    name: o.name,
    pipelineId: o.pipelineId,
    stage: o.stage,
    currentStageEnteredAt: o.currentStageEnteredAt,
    owner: userRef(o.owner),
    contactId: o.contactId,
    sellerName: o.sellerName,
    companyName: o.companyName,
    state: o.state,
    county: o.county,
    abstract: o.abstract,
    survey: o.survey,
    estAcres: o.estAcres,
    estNma: o.estNma,
    estNra: o.estNra,
    source: o.source,
    lastActivityAt: o.lastActivityAt,
    nextFollowUpDate: o.nextFollowUpDate,
    convertedDealId: o.convertedDealId,
    convertedAt: o.convertedAt,
    closeReason: o.closeReason,
    createdAt: o.createdAt,
  };
}

/** Full record: `Opp` = summary + contact fields, linked records and trails. */
export function serializeOpportunity(o: OpportunityDetailRow) {
  return {
    ...serializeOpportunitySummary(o),
    phone: o.phone,
    email: o.email,
    notes: o.notes,
    contact: o.contact
      ? { id: o.contact.id, firstName: o.contact.firstName, lastName: o.contact.lastName, entityName: o.contact.entityName, phone: o.contact.phone, email: o.contact.email }
      : null,
    convertedDeal: o.convertedDeal ? { id: o.convertedDeal.id, name: o.convertedDeal.name, stage: o.convertedDeal.stage } : null,
    stageHistory: o.stageHistory.map((h) => ({ id: h.id, fromStage: h.fromStage, toStage: h.toStage, reason: h.reason, changedBy: userRef(h.changedBy), createdAt: h.createdAt })),
    activities: o.activities.map((a) => ({ id: a.id, kind: a.kind, body: a.body, createdBy: userRef(a.createdBy), createdAt: a.createdAt })),
  };
}
