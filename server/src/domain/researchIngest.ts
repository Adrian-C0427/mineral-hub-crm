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
import {
  classifyDocType, classifyPermitStatus, classifyTrajectory,
  documentDedupeKey, normalizeEntity, splitParties, normField,
} from "./research.js";

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
export function normState(s: string): string {
  return s.trim().toUpperCase();
}
export function titleCounty(s: string): string {
  // Store county consistently ("Leon"), stripping a trailing "County" suffix.
  const t = s.trim().replace(/\s+county$/i, "").trim();
  return t.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

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
  /**
   * Scheduled/headless sync (county scan routines, CLI). The records import
   * exactly like any other, but the run stays out of the user-facing Import
   * history — that list is reserved for uploads users made themselves.
   */
  automated?: boolean;
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
    filename, assignedState, assignedCounty, dryRun = false, automated = false,
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
    const existingKeys = new Set(
      (await prisma.researchDocument.findMany({
        where: { organizationId: org },
        select: {
          instrumentNumber: true, county: true, state: true, recordingDate: true, docType: true,
          grantorNorm: true, granteeNorm: true, volume: true, page: true, abstractId: true,
        },
      })).map((r) => documentDedupeKey({
        state: r.state, county: r.county, instrumentNumber: r.instrumentNumber,
        recordingDate: r.recordingDate, docType: r.docType, grantorNorm: r.grantorNorm, granteeNorm: r.granteeNorm,
        volume: r.volume, page: r.page, abstractId: r.abstractId,
      })),
    );
    const seenInFile = new Set<string>();
    const REASON_EXISTING = "Duplicate of an already-imported record";
    const REASON_IN_FILE = "Duplicate row within this file";

    const batch: Prisma.ResearchDocumentCreateManyInput[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const docTypeRaw = get(row, "docType");
      // The mapped values, exactly as the reviewer should see them.
      const data: Record<string, string> = {
        docType: docTypeRaw, recordingDate: get(row, "recordingDate"),
        grantor: get(row, "grantor"), grantee: get(row, "grantee"),
        instrumentNumber: get(row, "instrumentNumber"), volume: get(row, "volume"), page: get(row, "page"),
        state: get(row, "state") || fallbackState || "", county: get(row, "county") || fallbackCounty || "",
        abstractId: get(row, "abstractId"),
      };
      const cls = classifyDocType(docTypeRaw);
      if (!cls) { record(i, "REJECTED", docTypeRaw ? `Not mineral-related: "${docTypeRaw}"` : "Missing document type", data); continue; }
      // Scope to the selected Data Type: Deeds keep transfers, Leases keep leases.
      if (wantClass && cls.docClass !== wantClass) {
        record(i, "REJECTED", cls.docClass === "LEASE" ? "Lease document — import under Leases" : "Deed document — import under Deeds", data);
        continue;
      }
      const recordingDate = parseRecordDate(get(row, "recordingDate"));
      if (!recordingDate) { record(i, "REJECTED", "Missing or unreadable recording date", data); continue; }
      // Geography from mapped columns, else the file-level assigned fallback.
      const rowState = get(row, "state") ? normState(get(row, "state")) : fallbackState;
      const rowCounty = get(row, "county") ? titleCounty(get(row, "county")) : fallbackCounty;
      if (!rowState || !rowCounty) { record(i, "REJECTED", "Missing county/state (assign one for this file)", data); continue; }
      const instrumentNumber = get(row, "instrumentNumber") || null;
      const grantor = get(row, "grantor") || null;
      const grantee = get(row, "grantee") || null;
      const grantorNorm = normalizeEntity(grantor);
      const granteeNorm = normalizeEntity(grantee);
      // Individual participants (strict split on , ; /) — the record itself
      // stays ONE transaction; these link each participant to it.
      const grantorParties = splitParties(grantor);
      const granteeParties = splitParties(grantee);
      const volume = get(row, "volume") || null;
      const page = get(row, "page") || null;
      const abstractId = get(row, "abstractId") || null;
      const key = documentDedupeKey({
        state: rowState, county: rowCounty, instrumentNumber, recordingDate, docType: cls.docType,
        grantorNorm, granteeNorm, volume, page, abstractId,
      });
      if (existingKeys.has(key)) { record(i, "DUPLICATE", REASON_EXISTING, data); continue; }
      if (seenInFile.has(key)) { record(i, "DUPLICATE", REASON_IN_FILE, data); continue; }
      seenInFile.add(key);
      record(i, "IMPORTED", null, data);
      batch.push({
        organizationId: org, state: rowState, county: rowCounty,
        docTypeRaw, docType: cls.docType, docClass: cls.docClass,
        instrumentNumber, volume, page,
        recordingDate,
        grantor, grantee, grantorNorm, granteeNorm,
        grantorParties, granteeParties,
        grantorNorms: grantorParties.map((p) => normalizeEntity(p)!).filter(Boolean),
        granteeNorms: granteeParties.map((p) => normalizeEntity(p)!).filter(Boolean),
        abstractId,
        source, ingestRunId: runId,
      });
    }
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
      formation: string | null; field: string | null; totalDepth: number | null; abstractId: string | null;
      latitude: number | null; longitude: number | null;
    };
    const existingPermits = await prisma.researchPermit.findMany({
      where: { organizationId: org },
      select: {
        id: true, state: true, county: true, apiNumber: true, permitNumber: true,
        operatorNorm: true, leaseName: true, wellName: true, status: true, trajectory: true,
        filedDate: true, approvedDate: true, spudDate: true, completionDate: true,
        formation: true, field: true, totalDepth: true, abstractId: true, latitude: true, longitude: true,
      },
    });
    const identityKey = (s: string, c: string, api: string | null, permit: string | null) =>
      `${s}|${c}|${normField(api)}|${normField(permit)}`;
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
    const fullSig = (p: Omit<PermitCmp, "id">, s: string, c: string, api: string | null, permit: string | null) => [
      s, c, normField(api), normField(permit), p.operatorNorm, normField(p.leaseName), normField(p.wellName),
      p.status, p.trajectory ?? "", day(p.filedDate), day(p.approvedDate), day(p.spudDate), day(p.completionDate),
      normField(p.formation), normField(p.field), p.totalDepth ?? "", normField(p.abstractId), p.latitude ?? "", p.longitude ?? "",
    ].join("|");
    const sameFields = (a: Omit<PermitCmp, "id">, b: Omit<PermitCmp, "id">) =>
      a.operatorNorm === b.operatorNorm && normField(a.leaseName) === normField(b.leaseName) &&
      normField(a.wellName) === normField(b.wellName) && a.status === b.status && a.trajectory === b.trajectory &&
      day(a.filedDate) === day(b.filedDate) && day(a.approvedDate) === day(b.approvedDate) &&
      day(a.spudDate) === day(b.spudDate) && day(a.completionDate) === day(b.completionDate) &&
      normField(a.formation) === normField(b.formation) && normField(a.field) === normField(b.field) &&
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
      const data: Record<string, string> = {
        operator, apiNumber: get(row, "apiNumber"), permitNumber: get(row, "permitNumber"),
        leaseName: get(row, "leaseName"), wellName: get(row, "wellName"), status: get(row, "status"),
        filedDate: get(row, "filedDate"), approvedDate: get(row, "approvedDate"),
        state: get(row, "state") || fallbackState || "", county: get(row, "county") || fallbackCounty || "",
        formation: get(row, "formation"),
      };
      if (!operator) { record(i, "REJECTED", "Missing operator", data); continue; }
      const rowState = get(row, "state") ? normState(get(row, "state")) : fallbackState;
      const rowCounty = get(row, "county") ? titleCounty(get(row, "county")) : fallbackCounty;
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
        formation: get(row, "formation") || null, field: get(row, "field") || null,
        totalDepth: numOf(get(row, "totalDepth")), abstractId: get(row, "abstractId") || null,
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
              formation: incoming.formation, field: incoming.field, totalDepth: incoming.totalDepth,
              abstractId: incoming.abstractId, latitude: incoming.latitude, longitude: incoming.longitude,
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
      batch.push({
        organizationId: org, state: rowState, county: rowCounty,
        apiNumber, permitNumber, operator, operatorNorm: incoming.operatorNorm,
        leaseName: incoming.leaseName, wellName: incoming.wellName,
        status: incoming.status, trajectory: incoming.trajectory,
        activityDate, filedDate, approvedDate, spudDate, completionDate,
        formation: incoming.formation, field: incoming.field,
        totalDepth: incoming.totalDepth,
        abstractId: incoming.abstractId,
        latitude: incoming.latitude, longitude: incoming.longitude,
        source, ingestRunId: runId,
      });
    }
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
  };
}
