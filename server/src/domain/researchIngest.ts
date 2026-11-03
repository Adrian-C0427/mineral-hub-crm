/**
 * Shared research-ingest core.
 *
 * The recorded-document (Deeds / Leases) and drilling-permit (Permits) CSV
 * import lives here so BOTH callers run identical logic:
 *   - the UI import route  (POST /api/research/ingest/commit, routes/research.ts)
 *   - the headless CLI      (scripts/importRecords.ts) used by scheduled automation
 *
 * Nothing here is UI- or request-specific: it takes an organization + an
 * optional acting user id and a parsed request payload, and returns a summary.
 * Dedup, classification, geography normalization, party splitting and the
 * per-import audit trail (ResearchIngestRun + ResearchIngestRow) are exactly the
 * behavior the route had inline before it was extracted — do not fork it.
 */
import type { Prisma, PrismaClient, ResearchDocClass, ResearchPermitStatus, WellTrajectory } from "@prisma/client";
import { parse } from "csv-parse/sync";
import { HttpError } from "../middleware/errors.js";
import { locationFields, normState, titleCounty } from "./researchGeo.js";
import { gisSurveyLookup, surveysFor } from "../services/researchGeoFill.js";
import {
  classifyDocType, classifyPermitStatus, classifyReviewedDocType, classifyTrajectory,
  documentDedupeKey, documentPartyFields, interestSignature, normalizeEntity, normField, PARTY_RULES_VERSION } from "./research.js";

// Cap rows per ingest so a single file can't drive an unbounded parse/insert
// pass (the char-level MAX_CSV_CHARS bound still applies to the raw body).
export const MAX_INGEST_ROWS = 50_000;
const CHUNK = 500;

export function parseCsv(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as Record<string, string>[];
  if (records.length > MAX_INGEST_ROWS) {
    throw new HttpError(400, `This file has too many rows (${records.length}). Split it into files of ${MAX_INGEST_ROWS.toLocaleString()} rows or fewer.`);
  }
  const headers = records.length ? Object.keys(records[0]) : [];
  return { headers, rows: records };
}

/** Tolerant date parser for public-records exports (MM/DD/YYYY, YYYY-MM-DD, ISO). */
export function parseRecordDate(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  const us = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (us) {
    const yr = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    const d = new Date(Date.UTC(yr, Number(us[1]) - 1, Number(us[2])));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Import geography is never hardcoded. Each row's State and County come from the
 * mapped columns when present; when a file lacks them, the caller collects an
 * assigned State/County for the whole file and passes them as a fallback. A row
 * that resolves to neither is skipped. This lets the module scale beyond any one
 * county without manual correction.
 */
// State/county normalization lives with the other Research geography rules
// (domain/researchGeo.ts); re-exported here for existing importers.
export { STATE_CODES, normState, titleCounty } from "./researchGeo.js";

export type ImportCategory = "deeds" | "leases" | "permits";

/**
 * Map a Data Type to the underlying ingest kind, a provenance tag, and (for
 * recorded documents) the document class the category is scoped to — Deeds keep
 * ownership-transfer instruments, Leases keep leasing instruments.
 */
export function resolveCategory(category: ImportCategory): {
  kind: "DOCUMENTS" | "PERMITS"; source: string; docClass?: ResearchDocClass;
} {
  if (category === "permits") return { kind: "PERMITS", source: "csv-permits" };
  return { kind: "DOCUMENTS", source: `csv-${category}`, docClass: category === "deeds" ? "TRANSACTION" : "LEASE" };
}

export interface IngestArgs {
  prisma: PrismaClient;
  organizationId: string;
  createdByUserId: string | null;
  category: ImportCategory;
  csv: string;
  mapping: Record<string, string>;
  filename?: string | null;
  /** Fallback State/County when the file has no such columns. */
  assignedState?: string | null;
  assignedCounty?: string | null;
  /** Parse + classify + dedup with NO database writes (no run, no rows). */
  dryRun?: boolean;
  /** With dryRun: return the first N rows' outcomes and processed values (the import preview). */
  previewRows?: number;
  /**
   * Scheduled/headless sync (county scan routines, CLI). The records import
   * exactly like any other, but the run stays out of the user-facing Import
   * history — that list is reserved for uploads users made themselves.
   */
  automated?: boolean;
  /**
   * Deeds only: every row of the file was reviewed by a person as a mineral
   * transfer, so general instrument types ("WARRANTY DEED", "ASSIGNMENT",
   * "CONVEYANCE", …) import too (classifyReviewedDocType) instead of being
   * rejected as possibly surface deals.
   */
  reviewedTransfers?: boolean;
}

export interface IngestSummary {
  runId: string | null;
  rowsTotal: number;
  imported: number;
  updated: number;
  duplicates: number;
  rejected: number;
  /** Back-compat aliases for the previous summary shape. */
  skipped: number;
  failed: number;
  skippedReasons: { reason: string; count: number }[];
  dryRun: boolean;
  /** The first rows as they would import (IngestArgs.previewRows). */
  preview?: { rowIndex: number; outcome: string; reason: string | null; data: Record<string, string> }[];
}

/**
 * Import a recorded-documents or permits CSV for one organization.
 *
 * DOCUMENTS: a row is a DUPLICATE only when its full recording signature
 * (documentDedupeKey) matches an existing record or an earlier row in the same
 * file — never the instrument number alone, which county exports repeat across
 * each grantor/grantee and legal tract. There is no in-place update for
 * documents; a changed field is a new distinct record.
 *
 * PERMITS: the API/permit number is the record's identity. A matching identity
 * with identical fields is a DUPLICATE; with changed fields it UPDATES the
 * existing record in place. Rows without an identity dedupe on the full field
 * signature.
 */
export async function ingestResearchCsv(args: IngestArgs): Promise<IngestSummary> {
  const {
    prisma, organizationId: org, createdByUserId, category, csv, mapping,
    filename, assignedState, assignedCounty, dryRun = false, automated = false, previewRows = 0,
    reviewedTransfers = false,
  } = args;
  const { kind, source, docClass: wantClass } = resolveCategory(category);
  const fallbackState = assignedState ? normState(assignedState) : null;
  const fallbackCounty = assignedCounty ? titleCounty(assignedCounty) : null;
  const { rows } = parseCsv(csv);
  const get = (row: Record<string, string>, field: string): string => {
    const header = mapping[field];
    return header ? (row[header] ?? "").trim() : "";
  };
  const numOf = (s: string): number | null => {
    const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  // Location: Abstract, Survey Name and County are separate fields
  // (domain/researchGeo.ts locationFields), each from the column mapped to it
  // — a combined location column mapped to several gives each only its own
  // part. State and county then fall back to the file's assigned values.
  // Nothing missing is invented: a blank survey is only filled from the GIS
  // abstract layer below, where county + abstract number name it.
  const geoOf = (row: Record<string, string>) => {
    const loc = locationFields({ abstract: get(row, "abstractId"), survey: get(row, "survey"), county: get(row, "county") });
    return {
      state: get(row, "state") ? normState(get(row, "state")) : loc.state ?? fallbackState,
      county: loc.county ?? fallbackCounty,
      abstractId: loc.abstractCell,
      abstractIds: loc.abstracts,
      survey: loc.survey,
      // A combined location cell, kept as recorded on the record.
      legalDescription: loc.combined,
    };
  };
  type Geo = ReturnType<typeof geoOf>;
  // The location as it will be stored, beside the raw cells in the review trail.
  const geoView = (g: Geo) => ({
    abstract: g.abstractIds.join(", "), surveyName: g.survey ?? "",
    countyLabel: g.county ? [g.county, g.state].filter(Boolean).join(", ") : "",
  });
  // Rows still without a survey in a Texas county: each abstract's survey from
  // the GIS layer, when every one is unique (services/researchGeoFill surveysFor).
  const surveyFills: { set: (s: string) => void; county: string; abstractNos: string[] }[] = [];
  const wantSurvey = (g: Geo, set: (s: string) => void) => {
    if (!g.survey && g.state === "TX" && g.county && g.abstractIds.length) surveyFills.push({ set, county: g.county, abstractNos: g.abstractIds });
  };
  const fillSurveys = async () => {
    if (!surveyFills.length) return;
    const lookup = await gisSurveyLookup(prisma, surveyFills.map((f) => f.county));
    for (const f of surveyFills) { const s = surveysFor(lookup, f.county, f.abstractNos); if (s) f.set(s); }
  };

  // Geography once per row, and from it the file's footprint: the states and
  // counties its rows fall in and, for documents, their recording-date span.
  // Existing records are read for that footprint only — both dedupe keys
  // carry state + county (a document's its recording day too), so nothing
  // outside it can match, and neither an import nor its preview reads the
  // org's whole table. Case-insensitive, as the keys compare upper-cased.
  const geos = rows.map(geoOf);
  const docDates = kind === "DOCUMENTS" ? rows.map((r) => parseRecordDate(get(r, "recordingDate"))) : [];
  const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const DAY = 86_400_000;
  const footprint = () => {
    const states = new Set<string>(), counties = new Set<string>();
    let from: Date | null = null, to: Date | null = null;
    for (let i = 0; i < geos.length; i++) {
      const g = geos[i];
      const date = kind === "DOCUMENTS" ? docDates[i] : undefined;
      if (!g.state || !g.county || date === null) continue; // rejected before any dedupe
      states.add(g.state); counties.add(g.county);
      if (date) { if (!from || date < from) from = date; if (!to || date > to) to = date; }
    }
    if (!states.size) return null;
    return {
      state: { in: [...states], mode: "insensitive" as const }, county: { in: [...counties], mode: "insensitive" as const },
      // Keys compare the UTC day; stored dates may carry a time, so whole days.
      ...(from && to ? { recordingDate: { gte: utcDay(from), lt: new Date(utcDay(to).getTime() + DAY) } } : {}),
    };
  };

  let imported = 0, updated = 0, duplicates = 0, rejected = 0;
  const skippedReasons = new Map<string, number>();
  const countReason = (reason: string) => skippedReasons.set(reason, (skippedReasons.get(reason) ?? 0) + 1);

  // Create the import batch first so every row it produces can be stamped with
  // its ingestRunId — that FK is what lets a single import be deleted later
  // without disturbing other data. Skipped entirely on a dry run.
  const run = dryRun
    ? null
    : await prisma.researchIngestRun.create({
        data: {
          organizationId: org, kind, source, state: fallbackState, county: fallbackCounty, filename: filename ?? null,
          rowsTotal: rows.length, status: "COMPLETED", createdByUserId, automated,
        },
      });
  const runId = run?.id ?? "";

  // Per-row outcome trail (IMPORTED / DUPLICATE / UPDATED / REJECTED) — powers
  // the post-import review views and the exportable summary. Cascades with the
  // run, so deleting an import also removes its review trail.
  type RowOutcome = "IMPORTED" | "DUPLICATE" | "UPDATED" | "REJECTED";
  const review: Prisma.ResearchIngestRowCreateManyInput[] = [];
  const record = (rowIndex: number, outcome: RowOutcome, reason: string | null, data: Record<string, string>) => {
    if (outcome === "DUPLICATE") { duplicates++; if (reason) countReason(reason); }
    if (outcome === "UPDATED") updated++;
    if (outcome === "REJECTED") { rejected++; if (reason) countReason(reason); }
    review.push({ organizationId: org, ingestRunId: runId, rowIndex, outcome, reason, data });
  };

  if (kind === "DOCUMENTS") {
    // Automatic duplicate detection: a row is a duplicate ONLY when every
    // mapped field matches an existing record (see documentDedupeKey — never
    // the instrument number alone, which county exports repeat across each
    // grantor/grantee and legal tract). Existing-in-DB vs seen-in-this-file
    // are reported as distinct reasons.
    // Party keys + conveyed interests are re-derived from each stored cell AS
    // RECORDED, exactly as an incoming row is — so the comparison never depends
    // on whether an older record has been through the interest backfill yet.
    const scope = footprint();
    const existingKeys = new Set(
      (scope ? await prisma.researchDocument.findMany({
        where: { organizationId: org, ...scope },
        select: {
          instrumentNumber: true, county: true, state: true, recordingDate: true, docType: true,
          grantor: true, grantee: true, grantorAsRecorded: true, granteeAsRecorded: true,
          volume: true, page: true, abstractId: true,
        },
      }) : []).map((r) => {
        const pf = documentPartyFields(r.grantorAsRecorded ?? r.grantor, r.granteeAsRecorded ?? r.grantee);
        return documentDedupeKey({
          state: r.state, county: r.county, instrumentNumber: r.instrumentNumber,
          recordingDate: r.recordingDate, docType: r.docType, grantorNorm: pf.grantorNorm, granteeNorm: pf.granteeNorm,
          volume: r.volume, page: r.page, abstractId: r.abstractId, interests: interestSignature(pf.partyInterests),
        });
      }),
    );
    const seenInFile = new Set<string>();
    const REASON_EXISTING = "Duplicate of an already-imported record";
    const REASON_IN_FILE = "Duplicate row within this file";

    const batch: Prisma.ResearchDocumentCreateManyInput[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const docTypeRaw = get(row, "docType");
      const g = geos[i];
      // The mapped values, exactly as the reviewer should see them, plus the
      // location as it will be stored (abstract / surveyName / countyLabel).
      const data: Record<string, string> = {
        docType: docTypeRaw, recordingDate: get(row, "recordingDate"),
        grantor: get(row, "grantor"), grantee: get(row, "grantee"),
        instrumentNumber: get(row, "instrumentNumber"), volume: get(row, "volume"), page: get(row, "page"),
        state: get(row, "state") || fallbackState || "", county: get(row, "county") || fallbackCounty || "",
        abstractId: get(row, "abstractId"), survey: get(row, "survey"),
        ...geoView(g),
      };
      const cls = reviewedTransfers && wantClass === "TRANSACTION" ? classifyReviewedDocType(docTypeRaw) : classifyDocType(docTypeRaw);
      if (!cls) { record(i, "REJECTED", docTypeRaw ? `Not mineral-related: "${docTypeRaw}"` : "Missing document type", data); continue; }
      // Scope to the selected Data Type: Deeds keep transfers, Leases keep leases.
      if (wantClass && cls.docClass !== wantClass) {
        record(i, "REJECTED", cls.docClass === "LEASE" ? "Lease document — import under Leases" : "Deed document — import under Deeds", data);
        continue;
      }
      const recordingDate = docDates[i];
      if (!recordingDate) { record(i, "REJECTED", "Missing or unreadable recording date", data); continue; }
      // Geography from mapped columns / legal description, else the file-level assigned fallback.
      const rowState = g.state;
      const rowCounty = g.county;
      if (!rowState || !rowCounty) { record(i, "REJECTED", "Missing county/state (assign one for this file)", data); continue; }
      const instrumentNumber = get(row, "instrumentNumber") || null;
      // Clean names, grouping keys, individual participants (strict split on
      // , ; /) and the conveyed interest ("ABC MINERALS LLC – 50%" → ABC
      // MINERALS LLC at 50%) — the record itself stays ONE transaction.
      const pf = documentPartyFields(get(row, "grantor") || null, get(row, "grantee") || null);
      const { grantorNorm, granteeNorm } = pf;
      const volume = get(row, "volume") || null;
      const page = get(row, "page") || null;
      const abstractId = g.abstractId;
      const key = documentDedupeKey({
        state: rowState, county: rowCounty, instrumentNumber, recordingDate, docType: cls.docType,
        grantorNorm, granteeNorm, volume, page, abstractId, interests: interestSignature(pf.partyInterests),
      });
      if (existingKeys.has(key)) { record(i, "DUPLICATE", REASON_EXISTING, data); continue; }
      if (seenInFile.has(key)) { record(i, "DUPLICATE", REASON_IN_FILE, data); continue; }
      seenInFile.add(key);
      record(i, "IMPORTED", null, data);
      const doc: Prisma.ResearchDocumentCreateManyInput = {
        organizationId: org, state: rowState, county: rowCounty,
        docTypeRaw, docType: cls.docType, docClass: cls.docClass,
        instrumentNumber, volume, page,
        recordingDate,
        grantor: pf.grantor, grantee: pf.grantee,
        grantorAsRecorded: pf.grantorAsRecorded, granteeAsRecorded: pf.granteeAsRecorded,
        grantorNorm, granteeNorm,
        grantorParties: pf.grantorParties, granteeParties: pf.granteeParties,
        grantorNorms: pf.grantorNorms, granteeNorms: pf.granteeNorms,
        interestPct: pf.interestPct,
        partyRulesVersion: PARTY_RULES_VERSION,
        ...(pf.partyInterests.length ? { partyInterests: pf.partyInterests as unknown as Prisma.InputJsonValue } : {}),
        abstractId,
        abstractIds: g.abstractIds, // each abstract number independently filterable
        survey: g.survey,
        legalDescription: g.legalDescription,
        source, ingestRunId: runId,
      };
      batch.push(doc);
      wantSurvey(g, (survey) => { doc.survey = survey; data.surveyName = survey; });
    }
    await fillSurveys();
    if (dryRun) {
      imported = batch.length;
    } else {
      for (let i = 0; i < batch.length; i += CHUNK) {
        const r = await prisma.researchDocument.createMany({ data: batch.slice(i, i + CHUNK) });
        imported += r.count;
      }
    }
    // Diagnostics: make a surprising duplicate count explainable in the server
    // log. Counts ONLY — never sample rows, which would put real party names
    // (frequently individuals) into deploy logs that platform access can read
    // outside the app's RBAC.
    if (duplicates > 0 && !dryRun) {
      console.info(`[research-import] run ${runId} (${source}): ${imported} imported · ${duplicates} duplicates`);
    }
  } else {
    // Permits: the API/permit number is the record's identity. An incoming row
    // whose identity matches an existing record is a DUPLICATE when every
    // mapped field is identical, or an UPDATE (the existing record is
    // refreshed in place) when fields changed — e.g. a status or spud date
    // amendment. Rows without an identity dedupe on the full field signature.
    type PermitCmp = {
      id: string; operatorNorm: string; leaseName: string | null; wellName: string | null;
      status: ResearchPermitStatus; trajectory: WellTrajectory;
      filedDate: Date | null; approvedDate: Date | null; spudDate: Date | null; completionDate: Date | null;
      field: string | null; totalDepth: number | null; abstractId: string | null;
      latitude: number | null; longitude: number | null;
    };
    const scope = footprint();
    const existingPermits = scope ? await prisma.researchPermit.findMany({
      where: { organizationId: org, state: scope.state, county: scope.county },
      select: {
        id: true, state: true, county: true, apiNumber: true, permitNumber: true,
        operatorNorm: true, leaseName: true, wellName: true, status: true, trajectory: true,
        filedDate: true, approvedDate: true, spudDate: true, completionDate: true,
        field: true, totalDepth: true, abstractId: true, latitude: true, longitude: true,
      },
    }) : [];
    const identityKey = (s: string, c: string, api: string | null, permit: string | null) =>
      `${s}|${c}|${normField(api)}|${normField(permit)}`;
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
    const fullSig = (p: Omit<PermitCmp, "id">, s: string, c: string, api: string | null, permit: string | null) => [
      s, c, normField(api), normField(permit), p.operatorNorm, normField(p.leaseName), normField(p.wellName),
      p.status, p.trajectory ?? "", day(p.filedDate), day(p.approvedDate), day(p.spudDate), day(p.completionDate),
      normField(p.field), p.totalDepth ?? "", normField(p.abstractId), p.latitude ?? "", p.longitude ?? "",
    ].join("|");
    const sameFields = (a: Omit<PermitCmp, "id">, b: Omit<PermitCmp, "id">) =>
      a.operatorNorm === b.operatorNorm && normField(a.leaseName) === normField(b.leaseName) &&
      normField(a.wellName) === normField(b.wellName) && a.status === b.status && a.trajectory === b.trajectory &&
      day(a.filedDate) === day(b.filedDate) && day(a.approvedDate) === day(b.approvedDate) &&
      day(a.spudDate) === day(b.spudDate) && day(a.completionDate) === day(b.completionDate) &&
      normField(a.field) === normField(b.field) &&
      (a.totalDepth ?? null) === (b.totalDepth ?? null) && normField(a.abstractId) === normField(b.abstractId) &&
      (a.latitude ?? null) === (b.latitude ?? null) && (a.longitude ?? null) === (b.longitude ?? null);

    const byIdentity = new Map<string, PermitCmp>();
    const fullSigs = new Set<string>();
    for (const p of existingPermits) {
      if (p.apiNumber || p.permitNumber) byIdentity.set(identityKey(p.state, p.county, p.apiNumber, p.permitNumber), p);
      fullSigs.add(fullSig(p, p.state, p.county, p.apiNumber, p.permitNumber));
    }

    const batch: Prisma.ResearchPermitCreateManyInput[] = [];
    const updates: { id: string; data: Prisma.ResearchPermitUpdateInput }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const operator = get(row, "operator");
      const g = geos[i];
      const data: Record<string, string> = {
        operator, apiNumber: get(row, "apiNumber"), permitNumber: get(row, "permitNumber"),
        leaseName: get(row, "leaseName"), wellName: get(row, "wellName"), status: get(row, "status"),
        filedDate: get(row, "filedDate"), approvedDate: get(row, "approvedDate"),
        state: get(row, "state") || fallbackState || "", county: get(row, "county") || fallbackCounty || "",
        abstractId: get(row, "abstractId"), survey: get(row, "survey"),
        ...geoView(g),
      };
      if (!operator) { record(i, "REJECTED", "Missing operator", data); continue; }
      const rowState = g.state;
      const rowCounty = g.county;
      if (!rowState || !rowCounty) { record(i, "REJECTED", "Missing county/state (assign one for this file)", data); continue; }
      const filedDate = parseRecordDate(get(row, "filedDate"));
      const approvedDate = parseRecordDate(get(row, "approvedDate"));
      const spudDate = parseRecordDate(get(row, "spudDate"));
      const completionDate = parseRecordDate(get(row, "completionDate"));
      const activityDate = filedDate ?? approvedDate ?? spudDate ?? completionDate;
      if (!activityDate) { record(i, "REJECTED", "No readable filed/approved/spud/completion date", data); continue; }
      const apiNumber = get(row, "apiNumber") || null;
      const permitNumber = get(row, "permitNumber") || null;
      const incoming: Omit<PermitCmp, "id"> = {
        operatorNorm: normalizeEntity(operator) ?? operator.toUpperCase(),
        leaseName: get(row, "leaseName") || null, wellName: get(row, "wellName") || null,
        status: classifyPermitStatus(get(row, "status")), trajectory: classifyTrajectory(get(row, "trajectory")),
        filedDate, approvedDate, spudDate, completionDate,
        field: get(row, "field") || null,
        totalDepth: numOf(get(row, "totalDepth")), abstractId: g.abstractId,
        latitude: numOf(get(row, "latitude")), longitude: numOf(get(row, "longitude")),
      };
      if (apiNumber || permitNumber) {
        const idk = identityKey(rowState, rowCounty, apiNumber, permitNumber);
        const found = byIdentity.get(idk);
        if (found) {
          if (sameFields(found, incoming)) { record(i, "DUPLICATE", "Identical to an existing permit record", data); continue; }
          // Same permit, changed fields → refresh the existing record in place.
          updates.push({
            id: found.id,
            data: {
              operator, operatorNorm: incoming.operatorNorm, leaseName: incoming.leaseName, wellName: incoming.wellName,
              status: incoming.status, trajectory: incoming.trajectory,
              activityDate, filedDate, approvedDate, spudDate, completionDate,
              field: incoming.field, totalDepth: incoming.totalDepth,
              abstractId: incoming.abstractId, latitude: incoming.latitude, longitude: incoming.longitude,
              // A survey the file names replaces the stored one; none keeps it.
              ...(g.survey ? { survey: g.survey } : {}),
            },
          });
          byIdentity.set(idk, { ...incoming, id: found.id });
          record(i, "UPDATED", "Existing permit refreshed with changed fields", data);
          continue;
        }
        byIdentity.set(idk, { ...incoming, id: "" });
      } else {
        const sig = fullSig(incoming, rowState, rowCounty, apiNumber, permitNumber);
        if (fullSigs.has(sig)) { record(i, "DUPLICATE", "Identical to an existing permit record", data); continue; }
        fullSigs.add(sig);
      }
      record(i, "IMPORTED", null, data);
      const permit: Prisma.ResearchPermitCreateManyInput = {
        organizationId: org, state: rowState, county: rowCounty,
        apiNumber, permitNumber, operator, operatorNorm: incoming.operatorNorm,
        leaseName: incoming.leaseName, wellName: incoming.wellName,
        status: incoming.status, trajectory: incoming.trajectory,
        activityDate, filedDate, approvedDate, spudDate, completionDate,
        field: incoming.field,
        totalDepth: incoming.totalDepth,
        abstractId: incoming.abstractId,
        survey: g.survey,
        latitude: incoming.latitude, longitude: incoming.longitude,
        source, ingestRunId: runId,
      };
      batch.push(permit);
      wantSurvey(g, (survey) => { permit.survey = survey; data.surveyName = survey; });
    }
    await fillSurveys();
    if (dryRun) {
      imported = batch.length;
      // `updated` is already counted via record(); nothing is written on a dry run.
    } else {
      for (let i = 0; i < batch.length; i += CHUNK) {
        const r = await prisma.researchPermit.createMany({ data: batch.slice(i, i + CHUNK) });
        imported += r.count;
      }
      // Apply updates in small parallel groups (amendments are typically few).
      for (let i = 0; i < updates.length; i += 25) {
        await Promise.all(updates.slice(i, i + 25).map((u) => prisma.researchPermit.update({ where: { id: u.id }, data: u.data })));
      }
    }
  }

  if (!dryRun && run) {
    // Persist the per-row review trail.
    for (let i = 0; i < review.length; i += CHUNK) {
      await prisma.researchIngestRow.createMany({ data: review.slice(i, i + CHUNK) });
    }
    await prisma.researchIngestRun.update({
      where: { id: run.id },
      data: { rowsImported: imported, rowsSkipped: duplicates, rowsFailed: rejected, rowsUpdated: updated },
    });
  }

  return {
    runId: run?.id ?? null,
    rowsTotal: rows.length,
    imported, updated, duplicates, rejected,
    // Back-compat aliases for the previous summary shape.
    skipped: duplicates, failed: rejected,
    skippedReasons: [...skippedReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    dryRun,
    ...(previewRows > 0 ? { preview: review.slice(0, previewRows).map((r) => ({ rowIndex: r.rowIndex, outcome: r.outcome, reason: r.reason ?? null, data: r.data as Record<string, string> })) } : {}),
  };
}
