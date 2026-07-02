/**
 * Research ingest source registry.
 *
 * Nationwide-expansion seam: every data provider (a county clerk export, a
 * state regulator's permit query, a commercial feed) is a "source" whose only
 * job is mapping its CSV headers onto the canonical field set below. Adding a
 * state or provider = one registry entry (extra header aliases + defaults),
 * no schema or route changes.
 */

export interface ResearchField {
  key: string;
  label: string;
  required?: boolean;
}

/** Canonical fields for recorded-instrument (documents) imports. */
export const DOCUMENT_FIELDS: ResearchField[] = [
  { key: "docType", label: "Instrument Type", required: true },
  { key: "recordingDate", label: "Recording Date", required: true },
  { key: "grantor", label: "Grantor (Seller)" },
  { key: "grantee", label: "Grantee (Buyer)" },
  { key: "instrumentNumber", label: "Instrument / Document #" },
  { key: "volume", label: "Volume" },
  { key: "page", label: "Page" },
  { key: "effectiveDate", label: "Effective Date" },
  { key: "county", label: "County (per-row override)" },
  { key: "abstractId", label: "Abstract" },
  { key: "survey", label: "Survey" },
  { key: "trs", label: "Section-Township-Range" },
  { key: "legalDescription", label: "Legal Description" },
  { key: "acreage", label: "Acreage" },
  { key: "consideration", label: "Consideration ($)" },
];

/** Canonical fields for drilling-permit imports. */
export const PERMIT_FIELDS: ResearchField[] = [
  { key: "operator", label: "Operator", required: true },
  { key: "county", label: "County (per-row override)" },
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
  { key: "trs", label: "Section-Township-Range" },
  { key: "latitude", label: "Latitude" },
  { key: "longitude", label: "Longitude" },
];

export interface ResearchSource {
  key: string;
  label: string;
  kind: "DOCUMENTS" | "PERMITS";
  description: string;
  /** field key → header aliases (lowercased, alphanumeric-only compare). */
  aliases: Record<string, string[]>;
}

export const RESEARCH_SOURCES: ResearchSource[] = [
  {
    key: "generic-documents",
    label: "Generic County Records CSV",
    kind: "DOCUMENTS",
    description: "Any recording/index export with instrument type, dates and parties.",
    aliases: {
      docType: ["instrumenttype", "documenttype", "doctype", "type", "instrument", "kindofinstrument"],
      recordingDate: ["recordingdate", "recorddate", "filedate", "filingdate", "daterecorded", "datefiled"],
      grantor: ["grantor", "grantors", "seller", "party1", "firstparty", "direct"],
      grantee: ["grantee", "grantees", "buyer", "party2", "secondparty", "indirect", "reverse"],
      instrumentNumber: ["instrumentnumber", "instrumentno", "documentnumber", "docnumber", "docno", "filenumber", "clerkfileno"],
      volume: ["volume", "vol", "book"],
      page: ["page", "pg"],
      effectiveDate: ["effectivedate", "dateeffective"],
      county: ["county", "countyname"],
      abstractId: ["abstract", "abstractno", "abstractnumber", "abst"],
      survey: ["survey", "surveyname", "originalsurvey"],
      trs: ["sectiontownshiprange", "str", "trs", "legaltrs"],
      legalDescription: ["legaldescription", "legal", "description", "briefiegal", "brieflegal"],
      acreage: ["acreage", "acres", "grossacres", "netacres"],
      consideration: ["consideration", "amount", "price", "salesprice"],
    },
  },
  {
    key: "tx-leon-publicsearch",
    label: "Leon County, TX — publicsearch.us export",
    kind: "DOCUMENTS",
    description:
      "CSV exported from leon.tx.publicsearch.us (Real Property). On the site, filter by " +
      "mineral/leasing document types and a recorded-date range, then Export. County defaults to Leon.",
    aliases: {
      // Column headers as they appear in the publicsearch.us Real Property export.
      docType: ["doctype", "documenttype", "instrumenttype", "type"],
      recordingDate: ["recordeddate", "recordingdate", "daterecorded", "recorded"],
      grantor: ["grantor", "grantors", "grantorname"],
      grantee: ["grantee", "grantees", "granteename"],
      instrumentNumber: ["docnumber", "documentnumber", "instrumentnumber", "instrumentno", "documentno"],
      // publicsearch emits a combined "Book/Volume/Page"; also accept split columns.
      volume: ["bookvolumepage", "volume", "book", "vol"],
      page: ["page", "pg"],
      legalDescription: ["legaldescription", "legal", "description", "propertydescription"],
    },
  },
  {
    key: "tx-county-clerk",
    label: "Texas County Clerk (OPR index)",
    kind: "DOCUMENTS",
    description: "Official Public Records index exports from Texas county clerks.",
    aliases: {
      docType: ["instrumenttype", "doctype", "documenttype", "instrtype", "kindofinstrument", "type"],
      recordingDate: ["filedate", "datefiled", "recordingdate", "recorded", "filedrecorded"],
      grantor: ["grantor", "grantors", "direct", "partiesgrantor"],
      grantee: ["grantee", "grantees", "reverse", "indirect", "partiesgrantee"],
      instrumentNumber: ["instrumentnumber", "instrumentno", "clerkfilenumber", "docnumber", "documentnumber"],
      volume: ["volume", "vol", "book"],
      page: ["page", "pg"],
      county: ["county"],
      abstractId: ["abstract", "abst", "abstractno"],
      survey: ["survey", "surveyname"],
      legalDescription: ["legaldescription", "legal", "propertydescription"],
      acreage: ["acreage", "acres"],
      consideration: ["consideration"],
    },
  },
  {
    key: "generic-permits",
    label: "Generic Drilling Permits CSV",
    kind: "PERMITS",
    description: "Any permit export with operator, county and a filed/approved date.",
    aliases: {
      operator: ["operator", "operatorname", "company", "companyname"],
      county: ["county", "countyname"],
      apiNumber: ["apinumber", "apino", "api", "api10", "api14"],
      permitNumber: ["permitnumber", "permitno", "permit"],
      leaseName: ["leasename", "lease"],
      wellName: ["wellname", "wellno", "wellnumber", "well"],
      status: ["status", "permitstatus", "wellstatus", "currentstatus"],
      trajectory: ["wellboreprofile", "wellbore", "trajectory", "welltype", "drilltype", "profile"],
      filedDate: ["fileddate", "submitteddate", "datesubmitted", "applicationdate", "datefiled"],
      approvedDate: ["approveddate", "dateapproved", "permitdate", "issueddate"],
      spudDate: ["spuddate", "datespud", "spud"],
      completionDate: ["completiondate", "datecompleted", "compldate"],
      formation: ["formation", "targetformation", "producingformation"],
      field: ["field", "fieldname"],
      totalDepth: ["totaldepth", "td", "depthtotal", "permitteddepth"],
      abstractId: ["abstract", "abst", "abstractno"],
      survey: ["survey", "surveyname"],
      trs: ["sectiontownshiprange", "str", "trs", "section"],
      latitude: ["latitude", "lat", "surfacelatitude", "lat83"],
      longitude: ["longitude", "long", "lon", "surfacelongitude", "long83"],
    },
  },
  {
    key: "tx-rrc-w1",
    label: "Texas RRC W-1 Drilling Permits",
    kind: "PERMITS",
    description: "RRC drilling-permit (W-1) query exports — operator, lease, wellbore profile, dates.",
    aliases: {
      operator: ["operatorname", "operatornamenumber", "operator"],
      county: ["county", "countyname"],
      apiNumber: ["apino", "apinumber", "api", "apiuniqueno"],
      permitNumber: ["permitno", "permitnumber", "statuspermitno", "permit"],
      leaseName: ["leasename", "lease"],
      wellName: ["wellno", "wellnumber", "well"],
      status: ["status", "permitstatus", "statusofpermit"],
      trajectory: ["wellboreprofile", "wellbore", "profile", "horizontal"],
      filedDate: ["submitteddate", "datesubmitted", "receiveddate"],
      approvedDate: ["approveddate", "dateapproved", "issueddate", "permitissued"],
      spudDate: ["spuddate", "spudinfo"],
      completionDate: ["completiondate"],
      formation: ["formation", "targetformation"],
      field: ["fieldname", "field"],
      totalDepth: ["totaldepth", "td"],
      abstractId: ["abstract", "abstractno"],
      survey: ["survey", "surveyname"],
      latitude: ["latitude", "lat", "surfacelat"],
      longitude: ["longitude", "long", "surfacelong"],
    },
  },
];

export function fieldsFor(kind: "DOCUMENTS" | "PERMITS"): ResearchField[] {
  return kind === "DOCUMENTS" ? DOCUMENT_FIELDS : PERMIT_FIELDS;
}

/**
 * Guess a header mapping for a source: exact/contains match against the
 * source's aliases first, then against the canonical field key itself.
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
