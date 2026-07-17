import { Router } from "express";
import { z } from "zod";
import { parse } from "csv-parse/sync";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { MAX_CSV_CHARS } from "../config.js";
import { normalizeCompany } from "../serializers.js";
import { normalizePhoneNullable } from "../domain/phone.js";

export const importRouter = Router();
// The whole flow exists to create buyer records, so every step (including the
// read-only analyze/preview) is gated on createBuyers — a read-only viewer has
// no business feeding CSVs through the importer.
importRouter.use(requireAuth, requireOrg, requirePermission("createBuyers"));

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

function parseCsv(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
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

// Dedup check shared by preview and commit. Dedup is scoped to the caller's org.
async function classifyRows(csv: string, mapping: Record<string, string>, organizationId: string) {
  const { rows } = parseCsv(csv);
  const seenCompany = new Set<string>();
  const seenEmail = new Set<string>();

  const results = await Promise.all(
    rows.map(async (row, index) => {
      const buyer = buildBuyer(row, mapping);
      if (!buyer.companyName) {
        return { index, status: "Error" as const, reason: "Missing Company Name", buyer };
      }
      const normCompany = normalizeCompany(buyer.companyName);

      // Within-file duplicate
      if (seenCompany.has(normCompany) || (buyer.email && seenEmail.has(buyer.email))) {
        return { index, status: "Duplicate" as const, reason: "Duplicate within file", buyer };
      }
      // Existing record — company (normalized) OR exact email is sufficient
      const existing = await prisma.buyer.findFirst({
        where: {
          organizationId,
          OR: [{ normalizedCompany: normCompany }, ...(buyer.email ? [{ email: buyer.email }] : [])],
        },
        select: { id: true },
      });
      seenCompany.add(normCompany);
      if (buyer.email) seenEmail.add(buyer.email);
      if (existing) {
        return { index, status: "Duplicate" as const, reason: "Matches existing buyer (skipped)", buyer };
      }
      return { index, status: "New" as const, reason: "", buyer };
    }),
  );
  return results;
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
    });

    res.json({
      inserted: toInsert.length,
      skipped: results.filter((r) => r.status === "Duplicate").length,
      errors: results.filter((r) => r.status === "Error").length,
      rows: results.map((r) => ({ index: r.index, status: r.status, reason: r.reason, companyName: r.buyer.companyName })),
    });
  }),
);
