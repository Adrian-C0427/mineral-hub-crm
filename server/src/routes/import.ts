import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { parse } from "csv-parse/sync";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { MAX_CSV_CHARS } from "../config.js";
import { normalizeCompany } from "../serializers.js";
import { normalizePhoneNullable } from "../domain/phone.js";

export const importRouter = Router();
// The whole flow exists to create buyer records, so every step (including the
// read-only analyze/preview) is gated on createBuyers — a read-only viewer has
// no business feeding CSVs through the importer.
importRouter.use(requireAuth, requireOrg, requirePermission("createBuyers"));

// Even a well-batched import is the heaviest thing a MEMBER can trigger — a
// full-file parse plus bulk lookups. Cap replays so /analyze and /preview (both
// write-free, and therefore repeatable at no cost to the caller) can't be looped
// into a self-inflicted denial of service.
importRouter.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many import requests. Wait a few minutes and try again." },
}));

// Target buyer fields the importer understands. companyName is required to proceed.
export const IMPORT_FIELDS = [
  { key: "companyName", label: "Company Name", required: true },
  { key: "name", label: "Buyer Name" },
  { key: "contactFirstName", label: "Contact First Name" },
  { key: "contactLastName", label: "Contact Last Name" },
  // Legacy combined column — still mappable; split automatically on import.
  { key: "contactName", label: "Contact Name (combined)" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "website", label: "Website" },
  { key: "mailingAddress", label: "Mailing Address" },
  { key: "relationshipStatus", label: "Relationship (Hot/Warm/Cold)" },
  { key: "states", label: "States (buy box)" },
  { key: "counties", label: "Counties (buy box)" },
  { key: "basins", label: "Basins (buy box)" },
  { key: "formations", label: "Formations (buy box)" },
  { key: "assetTypes", label: "Asset Types (buy box)" },
  { key: "minAcreage", label: "Min Acreage" },
  { key: "maxAcreage", label: "Max Acreage" },
  { key: "minPrice", label: "Min Price" },
  { key: "maxPrice", label: "Max Price" },
  { key: "notes", label: "Notes" },
] as const;

const ARRAY_FIELDS = new Set(["states", "counties", "basins", "formations", "assetTypes"]);
const NUMBER_FIELDS = new Set(["minAcreage", "maxAcreage", "minPrice", "maxPrice"]);

function guessMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const field of IMPORT_FIELDS) {
    const target = field.key.toLowerCase();
    const hit = headers.find((h) => {
      const n = h.toLowerCase().replace(/[^a-z]/g, "");
      return (
        n === target ||
        n.includes(target) ||
        (target === "companyname" && (n === "company" || n === "firm")) ||
        (target === "contactfirstname" && (n === "firstname" || n === "first")) ||
        (target === "contactlastname" && (n === "lastname" || n === "last" || n === "surname")) ||
        (target === "name" && n === "buyer") ||
        (target === "relationshipstatus" && (n === "relationship" || n === "status"))
      );
    });
    if (hit) mapping[field.key] = hit;
  }
  return mapping;
}

// Upper bound on rows per import. Dedup is now a fixed number of batched
// queries (see classifyRows), so this bounds parse memory and the commit
// transaction's duration rather than the query count.
export const MAX_IMPORT_ROWS = 20_000;

function parseCsv(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
  if (records.length > MAX_IMPORT_ROWS) {
    throw new HttpError(400, `This file has too many rows (${records.length}). Split it into files of ${MAX_IMPORT_ROWS.toLocaleString()} rows or fewer.`);
  }
  const headers = records.length ? Object.keys(records[0]) : [];
  return { headers, rows: records };
}

function toArray(v: string): string[] {
  return v.split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
}

function buildBuyer(row: Record<string, string>, mapping: Record<string, string>) {
  const get = (field: string): string => {
    const header = mapping[field];
    return header ? (row[header] ?? "").trim() : "";
  };
  const buyBox: Record<string, unknown> = {
    states: [], counties: [], basins: [], formations: [], assetTypes: [],
    minAcreage: null, maxAcreage: null, minPrice: null, maxPrice: null,
  };
  for (const f of ARRAY_FIELDS) if (mapping[f]) buyBox[f] = toArray(get(f));
  for (const f of NUMBER_FIELDS) {
    if (mapping[f]) {
      const n = parseFloat(get(f).replace(/[^0-9.\-]/g, ""));
      buyBox[f] = Number.isFinite(n) ? n : null;
    }
  }
  const rel = get("relationshipStatus").toUpperCase();
  const relationshipStatus = ["HOT", "WARM", "COLD"].includes(rel) ? rel : "WARM";

  // First/Last are preferred; a mapped legacy combined column is split
  // (first token → first name, remainder → last name).
  const legacy = get("contactName");
  const first = get("contactFirstName") || (legacy ? legacy.split(/\s+/)[0] : "");
  const last = get("contactLastName") || (legacy ? legacy.split(/\s+/).slice(1).join(" ") : "");
  return {
    companyName: get("companyName"),
    name: get("name") || get("companyName"),
    contactFirstName: first || null,
    contactLastName: last || null,
    contactName: [first, last].filter(Boolean).join(" ") || null,
    email: get("email") ? get("email").toLowerCase() : null,
    phone: normalizePhoneNullable(get("phone")),
    website: get("website") || null,
    mailingAddress: get("mailingAddress") || null,
    relationshipStatus,
    notes: get("notes") || null,
    buyBox,
  };
}

// Step 1: analyze — headers + sample + auto-guessed mapping
importRouter.post(
  "/analyze",
  asyncHandler(async (req, res) => {
    const { csv } = z.object({ csv: z.string().min(1).max(MAX_CSV_CHARS, "CSV file is too large") }).parse(req.body);
    const { headers, rows } = parseCsv(csv);
    res.json({
      headers,
      fields: IMPORT_FIELDS,
      suggestedMapping: guessMapping(headers),
      rowCount: rows.length,
      sample: rows.slice(0, 5),
    });
  }),
);

const commitSchema = z.object({
  csv: z.string().min(1).max(MAX_CSV_CHARS, "CSV file is too large"),
  mapping: z.record(z.string(), z.string()),
});

/** Split an array into fixed-size chunks (keeps `IN` lists off the parameter limit). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Dedup check shared by preview and commit. Dedup is scoped to the caller's org.
 *
 * The whole file is resolved in a FIXED number of queries — two `IN` lookups per
 * chunk — rather than one query per row. The previous shape fired every row's
 * `findFirst` concurrently inside a single `Promise.all`, so a 20,000-row CSV
 * queued 20,000 simultaneous queries against a pool sized for a handful; the
 * importer starved every other request in the process for as long as it ran, and
 * `POST /preview` (no writes, no rate limit) could be replayed to hold it there.
 *
 * Classification itself is now a plain synchronous pass, which also repairs
 * within-file dedup: the `seen*` sets were mutated AFTER an await, so every
 * row's membership check ran before any row had been recorded and in-file
 * duplicates were never detected at all.
 */
async function classifyRows(csv: string, mapping: Record<string, string>, organizationId: string) {
  const { rows } = parseCsv(csv);
  const parsed = rows.map((row, index) => ({ index, buyer: buildBuyer(row, mapping) }));

  const companies = [...new Set(parsed.filter((p) => p.buyer.companyName).map((p) => normalizeCompany(p.buyer.companyName)))];
  const emails = [...new Set(parsed.map((p) => p.buyer.email).filter((e): e is string => Boolean(e)))];

  // Two batched lookups per chunk, regardless of row count.
  const existingCompanies = new Set<string>();
  const existingEmails = new Set<string>();
  for (const c of chunk(companies, 1000)) {
    const hits = await prisma.buyer.findMany({
      where: { organizationId, normalizedCompany: { in: c } },
      select: { normalizedCompany: true },
    });
    for (const h of hits) if (h.normalizedCompany) existingCompanies.add(h.normalizedCompany);
  }
  for (const e of chunk(emails, 1000)) {
    const hits = await prisma.buyer.findMany({
      where: { organizationId, email: { in: e } },
      select: { email: true },
    });
    for (const h of hits) if (h.email) existingEmails.add(h.email);
  }

  return classifyParsed(parsed, existingCompanies, existingEmails);
}

export const REASON_MISSING_COMPANY = "Missing Company Name";
export const REASON_IN_FILE = "Duplicate within file";
export const REASON_EXISTING = "Matches existing buyer (skipped)";

/**
 * The classification pass itself — pure, so the dedup rules are testable without
 * a database. Order matters: a row is checked against earlier rows in the SAME
 * file before it is checked against the org, and it joins the `seen` sets only
 * once it has passed the in-file check.
 */
export function classifyParsed<T extends { companyName: string; email?: string | null }>(
  parsed: { index: number; buyer: T }[],
  existingCompanies: Set<string>,
  existingEmails: Set<string>,
) {
  const seenCompany = new Set<string>();
  const seenEmail = new Set<string>();
  return parsed.map(({ index, buyer }) => {
    if (!buyer.companyName) {
      return { index, status: "Error" as const, reason: REASON_MISSING_COMPANY, buyer };
    }
    const normCompany = normalizeCompany(buyer.companyName);
    // Within-file duplicate
    if (seenCompany.has(normCompany) || (buyer.email && seenEmail.has(buyer.email))) {
      return { index, status: "Duplicate" as const, reason: REASON_IN_FILE, buyer };
    }
    seenCompany.add(normCompany);
    if (buyer.email) seenEmail.add(buyer.email);
    // Existing record — company (normalized) OR exact email is sufficient
    if (existingCompanies.has(normCompany) || (buyer.email && existingEmails.has(buyer.email))) {
      return { index, status: "Duplicate" as const, reason: REASON_EXISTING, buyer };
    }
    return { index, status: "New" as const, reason: "", buyer };
  });
}

// Step 2: preview — per-row New/Duplicate/Error (no writes)
importRouter.post(
  "/preview",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { csv, mapping } = commitSchema.parse(req.body);
    const results = await classifyRows(csv, mapping, orgId(req));
    res.json({
      rows: results.map((r) => ({
        index: r.index,
        status: r.status,
        reason: r.reason,
        companyName: r.buyer.companyName,
        name: r.buyer.name,
        email: r.buyer.email,
      })),
      counts: {
        new: results.filter((r) => r.status === "New").length,
        duplicate: results.filter((r) => r.status === "Duplicate").length,
        error: results.filter((r) => r.status === "Error").length,
      },
    });
  }),
);

// Step 3: commit — batch insert New rows in a single transaction
importRouter.post(
  "/commit",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { csv, mapping } = commitSchema.parse(req.body);
    const results = await classifyRows(csv, mapping, orgId(req));
    const toInsert = results.filter((r) => r.status === "New");

    // The import is all-or-nothing, so a large file legitimately needs longer
    // than Prisma's 5s interactive default — which a few thousand rows blew
    // through, aborting the whole commit with P2028.
    await prisma.$transaction(async (tx) => {
      for (const r of toInsert) {
        await tx.buyer.create({
          data: {
            organizationId: orgId(req),
            name: r.buyer.name,
            companyName: r.buyer.companyName,
            normalizedCompany: normalizeCompany(r.buyer.companyName),
            contactName: r.buyer.contactName,
            contactFirstName: r.buyer.contactFirstName,
            contactLastName: r.buyer.contactLastName,
            email: r.buyer.email,
            phone: r.buyer.phone,
            website: r.buyer.website,
            mailingAddress: r.buyer.mailingAddress,
            relationshipStatus: r.buyer.relationshipStatus as "HOT" | "WARM" | "COLD",
            notes: r.buyer.notes,
            buyBox: { create: r.buyer.buyBox },
          },
        });
      }
    }, { maxWait: 10_000, timeout: 5 * 60_000 });

    res.json({
      inserted: toInsert.length,
      skipped: results.filter((r) => r.status === "Duplicate").length,
      errors: results.filter((r) => r.status === "Error").length,
      rows: results.map((r) => ({ index: r.index, status: r.status, reason: r.reason, companyName: r.buyer.companyName })),
    });
  }),
);
