import { toInputDate } from "./format";
import type { Opp } from "../types";

/**
 * The Opportunity form's pure parts (no React, no API) — shared by creating
 * and editing (components/NewOpportunityModal.tsx): the form values, the
 * required / invalid checks (the same rules the server applies in
 * routes/opportunities.ts), the request bodies, and how the pipeline + stage
 * choice survives a refreshed pipeline list. Tests: client/test/opportunityForm.test.ts.
 */

export interface OppForm {
  name: string;
  ownerId: string;
  contactId: string;
  sellerName: string;
  companyName: string;
  /** Canonical digits (PhoneInput). */
  phone: string;
  email: string;
  /** State code ("TX"). */
  state: string;
  county: string;
  /** A GIS abstract id ("TX-289653") or an abstract as written ("A-123"). */
  abstract: string;
  survey: string;
  estAcres: string;
  estNma: string;
  estNra: string;
  /** Basin / formation tags (suggested from the abstract or county, always editable). */
  basins: string[];
  formations: string[];
  source: string;
  /** "YYYY-MM-DD", or "" for none. */
  nextFollowUpDate: string;
  notes: string;
}

export const OPP_FIELD_LABELS: Record<keyof OppForm, string> = {
  name: "Name", ownerId: "Owner", contactId: "Linked contact", sellerName: "Seller name", companyName: "Company",
  phone: "Phone", email: "Email", state: "State", county: "County", abstract: "Abstract", survey: "Survey",
  estAcres: "Est. gross acres", estNma: "Est. NMA", estNra: "Est. NRA", basins: "Basin", formations: "Formation", source: "Source",
  nextFollowUpDate: "Next follow-up", notes: "Notes",
};

/** Text limits — the server's (routes/opportunities.ts `editableFields`). */
export const OPP_TEXT_LIMITS: Partial<Record<keyof OppForm, number>> = {
  name: 200, sellerName: 200, companyName: 200, phone: 40, email: 200, state: 40, county: 120,
  abstract: 120, survey: 200, source: 200, notes: 10_000,
};
const NUMBER_FIELDS = ["estAcres", "estNma", "estNra"] as const;

export function emptyOppForm(ownerId = ""): OppForm {
  return {
    name: "", ownerId, contactId: "", sellerName: "", companyName: "", phone: "", email: "",
    state: "", county: "", abstract: "", survey: "", estAcres: "", estNma: "", estNra: "",
    basins: [], formations: [],
    source: "", nextFollowUpDate: "", notes: "",
  };
}

const s = (v: string | null | undefined) => v ?? "";
const n = (v: number | null | undefined) => (v == null ? "" : String(v));

/** A saved opportunity as form values (edit mode). */
export function oppFormFromRecord(o: Pick<Opp,
  "name" | "owner" | "contactId" | "sellerName" | "companyName" | "phone" | "email" | "state" | "county" | "abstract" | "survey"
  | "estAcres" | "estNma" | "estNra" | "basins" | "formations" | "source" | "nextFollowUpDate" | "notes">): OppForm {
  return {
    name: o.name, ownerId: o.owner?.id ?? "", contactId: s(o.contactId),
    sellerName: s(o.sellerName), companyName: s(o.companyName), phone: s(o.phone), email: s(o.email),
    state: s(o.state), county: s(o.county), abstract: s(o.abstract), survey: s(o.survey),
    estAcres: n(o.estAcres), estNma: n(o.estNma), estNra: n(o.estNra),
    basins: [...(o.basins ?? [])], formations: [...(o.formations ?? [])],
    source: s(o.source), nextFollowUpDate: toInputDate(o.nextFollowUpDate), notes: s(o.notes),
  };
}

export interface OppFormCheck {
  /** Required fields still empty (labels), in form order. */
  missing: string[];
  /** Values the server would refuse, as messages. */
  invalid: string[];
}

/**
 * What stands between the form and a save. Creating needs a name, a pipeline
 * and a stage; editing needs the name (the pipeline and stage stay as they are
 * — Move stage changes the stage, with its history). Estimates are numbers of
 * 0 or more and text keeps to the server's limits.
 */
export function checkOppForm(f: OppForm, opts: { editing?: boolean; pipelineId?: string; stage?: string } = {}): OppFormCheck {
  const missing: string[] = [];
  if (!f.name.trim()) missing.push("Name");
  if (!opts.editing) {
    if (!opts.pipelineId) missing.push("Pipeline");
    if (!opts.stage) missing.push("Stage");
  }
  const invalid: string[] = [];
  for (const k of NUMBER_FIELDS) {
    const v = f[k].trim();
    if (v !== "" && !(Number.isFinite(Number(v)) && Number(v) >= 0)) invalid.push(`${OPP_FIELD_LABELS[k]} must be a number of 0 or more`);
  }
  for (const [k, max] of Object.entries(OPP_TEXT_LIMITS) as [keyof OppForm, number][]) {
    const v = f[k];
    if (typeof v === "string" && v.trim().length > max) invalid.push(`${OPP_FIELD_LABELS[k]} is too long (${max.toLocaleString("en-US")} characters max)`);
  }
  if (f.nextFollowUpDate && !/^\d{4}-\d{2}-\d{2}$/.test(f.nextFollowUpDate)) invalid.push("Next follow-up is not a valid date");
  return { missing, invalid };
}

const text = (v: string) => (v.trim() === "" ? null : v.trim());
const num = (v: string) => (v.trim() === "" ? null : Number(v));

export type OppBodyValue = string | number | string[] | null;
/** The editable fields as the API takes them (blank → null; tag lists trimmed and de-duplicated). */
export function oppBody(f: OppForm): Record<keyof OppForm, OppBodyValue> {
  return {
    name: f.name.trim(),
    ownerId: f.ownerId || null,
    contactId: f.contactId || null,
    sellerName: text(f.sellerName),
    companyName: text(f.companyName),
    phone: text(f.phone),
    email: text(f.email),
    state: text(f.state),
    county: text(f.county),
    abstract: text(f.abstract),
    survey: text(f.survey),
    estAcres: num(f.estAcres),
    estNma: num(f.estNma),
    estNra: num(f.estNra),
    basins: tags(f.basins),
    formations: tags(f.formations),
    source: text(f.source),
    nextFollowUpDate: f.nextFollowUpDate || null,
    notes: text(f.notes),
  };
}
const tags = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** PATCH body: only the fields whose saved value changed (empty = nothing to save). */
export function oppPatchBody(saved: OppForm, f: OppForm): Partial<Record<keyof OppForm, OppBodyValue>> {
  const before = oppBody(saved);
  const after = oppBody(f);
  const out: Partial<Record<keyof OppForm, OppBodyValue>> = {};
  for (const k of Object.keys(after) as (keyof OppForm)[]) {
    const a = after[k], b = before[k];
    const same = Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;
    if (!same) out[k] = a;
  }
  return out;
}

/** A pipeline as the form needs it. */
export interface PipelineChoice { id: string; stages: { key: string; isTerminal: boolean }[] }

/**
 * The pipeline + stage to show once the pipeline list (re)loads: the current
 * pick while it still exists, else `preferred` (the board's pipeline), else the
 * first; the stage stays when it is still an active stage of that pipeline,
 * else the pipeline's first active stage. Empty strings when there is nothing
 * to pick — the form then says so instead of sending a stale id.
 */
export function choosePipelineStage(list: PipelineChoice[], cur: { pipelineId: string; stage: string }, preferred?: string): { pipelineId: string; stage: string } {
  const p = list.find((x) => x.id === cur.pipelineId) ?? list.find((x) => x.id === preferred) ?? list[0];
  if (!p) return { pipelineId: "", stage: "" };
  const active = p.stages.filter((x) => !x.isTerminal);
  const keep = p.id === cur.pipelineId && active.some((x) => x.key === cur.stage);
  return { pipelineId: p.id, stage: keep ? cur.stage : active[0]?.key ?? "" };
}

// Same format the server routes into a converted deal's abstractIds
// (domain/opportunities.ts isAbstractId); anything else is a label as written.
const ABSTRACT_ID_RE = /^[A-Za-z]{2}-\d+(?:-\d+)*$/;
/** True when `raw` is a GIS abstract id ("TX-289653") rather than a label ("A-123"). */
export function isAbstractId(raw: string | null | undefined): boolean {
  return ABSTRACT_ID_RE.test((raw ?? "").trim());
}
