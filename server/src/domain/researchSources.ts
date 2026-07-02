/**
 * Research ingest mapping config.
 *
 * Imports are CSV-only. The UI presents a single "Data Type" (Deeds / Leases /
 * Drilling Permits) and auto-maps the file's columns onto the canonical field
 * set below. Deeds and Leases share the recorded-documents field set (they're
 * separated after classification by document class); Permits use their own set.
 *
 * Header matching is alias-driven so exports from different county-clerk and
 * regulator systems map without per-provider UI — adding support for a new
 * export layout is just more aliases here, no schema or route changes.
 */

export interface ResearchField {
  key: string;
  label: string;
  required?: boolean;
}

/** Canonical fields for recorded-document (Deeds / Leases) imports. */
export const DOCUMENT_FIELDS: ResearchField[] = [
  { key: "docType", label: "Document Type", required: true },
  { key: "recordingDate", label: "Recording Date", required: true },
  { key: "grantor", label: "Grantor (Seller)" },
  { key: "grantee", label: "Grantee (Buyer)" },
  { key: "instrumentNumber", label: "Instrument / Document #" },
  { key: "volume", label: "Volume" },
  { key: "page", label: "Page" },
  { key: "county", label: "County" },
  { key: "abstractId", label: "Abstract" },
  { key: "survey", label: "Survey" },
  { key: "legalDescription", label: "Legal Description" },
];

/** Canonical fields for drilling-permit imports. */
export const PERMIT_FIELDS: ResearchField[] = [
  { key: "operator", label: "Operator", required: true },
  { key: "county", label: "County" },
  { key: "apiNumber", label: "API Number" },
  { key: "permitNumber", label: "Permit Number" },
  { key: "leaseName", label: "Lease Name" },
  { key: "wellName", label: "Well Name / #" },
  { key: "status", label: "Permit / Well Status" },
  { key: "trajectory", label: "Wellbore Profile (H/D/V)" },
  { key: "filedDate", label: "Filed / Submitted Date" },
  { key: "approvedDate", label: "Approved Date" },
  { key: "spudDate", label: "Spud Date" },
  { key: "completionDate", label: "Completion Date" },
  { key: "formation", label: "Formation" },
  { key: "field", label: "Field" },
  { key: "totalDepth", label: "Total Depth" },
  { key: "abstractId", label: "Abstract" },
  { key: "survey", label: "Survey" },
  { key: "latitude", label: "Latitude" },
  { key: "longitude", label: "Longitude" },
];

export interface ResearchSource {
  kind: "DOCUMENTS" | "PERMITS";
  /** field key → header aliases (lowercased, alphanumeric-only compare). */
  aliases: Record<string, string[]>;
}

/**
 * One documents adapter and one permits adapter. Aliases are the union of the
 * layouts we've seen (generic county index, Texas county-clerk OPR exports, the
 * Leon County publicsearch.us Real Property export, generic permits, TX RRC
 * W-1) so column-guessing works across them without the user choosing a format.
 */
export const CSV_DOCUMENTS: ResearchSource = {
  kind: "DOCUMENTS",
  aliases: {
    docType: ["doctype", "documenttype", "instrumenttype", "instrtype", "type", "instrument", "kindofinstrument"],
    recordingDate: ["recordeddate", "recordingdate", "recorddate", "daterecorded", "recorded", "filedate", "datefiled", "filingdate", "filedrecorded"],
    grantor: ["grantor", "grantors", "grantorname", "seller", "party1", "firstparty", "direct", "partiesgrantor"],
    grantee: ["grantee", "grantees", "granteename", "buyer", "party2", "secondparty", "indirect", "reverse", "partiesgrantee"],
    instrumentNumber: ["docnumber", "documentnumber", "documentno", "instrumentnumber", "instrumentno", "clerkfilenumber", "clerkfileno", "filenumber", "docno"],
    volume: ["bookvolumepage", "volume", "vol", "book"],
    page: ["page", "pg"],
    county: ["county", "countyname"],
    abstractId: ["abstract", "abstractno", "abstractnumber", "abst"],
    survey: ["survey", "surveyname", "originalsurvey"],
    legalDescription: ["legaldescription", "legal", "description", "propertydescription", "brieflegal", "briefiegal"],
  },
};

export const CSV_PERMITS: ResearchSource = {
  kind: "PERMITS",
  aliases: {
    operator: ["operator", "operatorname", "operatornamenumber", "company", "companyname"],
    county: ["county", "countyname"],
    apiNumber: ["apinumber", "apino", "api", "apiuniqueno", "api10", "api14"],
    permitNumber: ["permitnumber", "permitno", "statuspermitno", "permit"],
    leaseName: ["leasename", "lease"],
    wellName: ["wellname", "wellno", "wellnumber", "well"],
    status: ["status", "permitstatus", "wellstatus", "statusofpermit", "currentstatus"],
    trajectory: ["wellboreprofile", "wellbore", "trajectory", "welltype", "drilltype", "profile", "horizontal"],
    filedDate: ["fileddate", "submitteddate", "datesubmitted", "receiveddate", "applicationdate", "datefiled"],
    approvedDate: ["approveddate", "dateapproved", "permitdate", "issueddate", "permitissued"],
    spudDate: ["spuddate", "datespud", "spud", "spudinfo"],
    completionDate: ["completiondate", "datecompleted", "compldate"],
    formation: ["formation", "targetformation", "producingformation"],
    field: ["field", "fieldname"],
    totalDepth: ["totaldepth", "td", "depthtotal", "permitteddepth"],
    abstractId: ["abstract", "abst", "abstractno"],
    survey: ["survey", "surveyname"],
    latitude: ["latitude", "lat", "surfacelatitude", "surfacelat", "lat83"],
    longitude: ["longitude", "long", "lon", "surfacelongitude", "surfacelong", "long83"],
  },
};

export function sourceFor(kind: "DOCUMENTS" | "PERMITS"): ResearchSource {
  return kind === "DOCUMENTS" ? CSV_DOCUMENTS : CSV_PERMITS;
}

export function fieldsFor(kind: "DOCUMENTS" | "PERMITS"): ResearchField[] {
  return kind === "DOCUMENTS" ? DOCUMENT_FIELDS : PERMIT_FIELDS;
}

/**
 * Guess a header mapping for a kind: exact match against the adapter's aliases
 * first, then a contains-match, then the canonical field key itself.
 */
export function guessMapping(source: ResearchSource, headers: string[]): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalized = headers.map((h) => ({ raw: h, n: norm(h) }));
  const mapping: Record<string, string> = {};
  for (const field of fieldsFor(source.kind)) {
    const aliases = [...(source.aliases[field.key] ?? []), norm(field.key)];
    const exact = normalized.find((h) => aliases.includes(h.n));
    const partial = exact ?? normalized.find((h) => aliases.some((a) => h.n.includes(a) || a.includes(h.n)));
    if (partial) mapping[field.key] = partial.raw;
  }
  return mapping;
}
