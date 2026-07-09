import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { normalizeCompany } from "../serializers.js";
import { getDownloadUrl, s3Configured } from "../services/s3.js";
import { portalRateLimited } from "../services/portalRateLimit.js";

/**
 * Buyer Offering Portal — the PUBLIC (unauthenticated) API.
 *
 * Everything served here is buyer-safe by construction: the serializer below
 * whitelists fields, so internal data (pricing, notes, sellers, offers,
 * margins) can never leak by accident. Deals appear only while
 * `publishedToPortal` is true; PUBLIC deals list in the marketplace,
 * LINK_ONLY deals resolve solely through their unguessable share slug.
 * Documents require an explicit `visibleToBuyers` approval per file.
 */

export const portalRouter = Router();

export const newPortalSlug = (): string => randomBytes(12).toString("base64url");

// Per-deal publishable sections. Defaults match the CRM's DEFAULT_SECTIONS.
const PORTAL_SECTION_KEYS = [
  "contact", "company", "description", "documents", "map", "wells",
  "tracts", "production", "attachments", "notes", "askPrice",
] as const;
type PortalSectionKey = (typeof PORTAL_SECTION_KEYS)[number];
const DEFAULT_SECTIONS: Record<PortalSectionKey, boolean> = {
  contact: true, company: true, description: true, documents: true, map: true,
  wells: true, tracts: true, production: true, attachments: true, notes: false, askPrice: true,
};
function dealSections(raw: unknown): Record<PortalSectionKey, boolean> {
  const obj = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const out = { ...DEFAULT_SECTIONS };
  for (const k of PORTAL_SECTION_KEYS) if (typeof obj[k] === "boolean") out[k] = obj[k] as boolean;
  return out;
}

/**
 * Buyer-safe projection of a deal. The ONLY shape the portal ever returns.
 * Per-deal section toggles decide which content appears; anything toggled off
 * is omitted here (never sent to the browser), so a hidden section can't leak.
 * `askPrice` uses the deal's buyer-facing override, else the deal askPrice.
 */
function publicDeal(d: {
  name: string; portalSlug: string | null; portalSummary: string | null; portalFeatured: boolean;
  counties: string[]; states: string[]; state: string | null; abstractIds: string[];
  basins: string[]; formations: string[]; assetTypes: string[]; surveys: string[];
  nra: number | null; acreageNma: number | null; operator: string | null; rrc?: string | null;
  wells: string[]; producingStatus: string | null; updatedAt: Date;
  portalSections?: unknown; portalAskPrice?: number | null; askPrice?: number | null; notes?: string | null;
  _count?: { assets?: number };
}) {
  const s = dealSections(d.portalSections);
  return {
    slug: d.portalSlug,
    name: d.name,
    summary: s.description ? d.portalSummary : null,
    featured: d.portalFeatured,
    sections: s,
    counties: d.counties,
    states: d.states.length ? d.states : d.state ? [d.state] : [],
    abstractIds: d.abstractIds,
    basins: d.basins,
    formations: d.formations,
    assetTypes: d.assetTypes,
    surveys: d.surveys,
    nra: d.nra,
    acreageNma: d.acreageNma,
    operator: d.operator,
    rrc: d.rrc ?? null,
    // Number of child assets — a package published as a single bundle listing.
    assetCount: d._count?.assets ?? 0,
    wells: s.wells ? d.wells : [],
    producingStatus: s.production ? d.producingStatus : null,
    askPrice: s.askPrice ? (d.portalAskPrice ?? d.askPrice ?? null) : null,
    notes: s.notes ? (d.notes ?? null) : null,
    listedAt: d.updatedAt,
  };
}

interface OrgLike {
  id: string; name: string; fullLogo: string | null; compactLogo: string | null; portalSlug: string | null;
  portalContactName: string | null; portalContactEmail: string | null;
  portalContactPhone: string | null; portalOfficeLocation: string | null;
}

export interface PublicContact {
  id: string; name: string; title: string | null; email: string | null;
  phone: string | null; department: string | null; photo: string | null; isPrimary: boolean;
}

/**
 * The org's published portal contacts, ordered primary-first. Falls back to a
 * single synthesized contact from the legacy org fields for orgs that haven't
 * been migrated into the PortalContact table yet, so no portal loses its
 * contact section mid-rollout.
 */
async function publicContacts(o: OrgLike): Promise<PublicContact[]> {
  const rows = await prisma.portalContact.findMany({
    where: { organizationId: o.id, published: true },
    orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, title: true, email: true, phone: true, department: true, photo: true, isPrimary: true },
  });
  if (rows.length) return rows;
  if (o.portalContactName || o.portalContactEmail || o.portalContactPhone) {
    return [{
      id: "legacy", name: o.portalContactName || o.name, title: null,
      email: o.portalContactEmail, phone: o.portalContactPhone,
      department: o.portalOfficeLocation, photo: null, isPrimary: true,
    }];
  }
  return [];
}

/**
 * A deal's own published contacts (all of them, in order). Source of truth is
 * the `portalContacts` JSON array; falls back to the legacy single-contact
 * scalar columns so listings created before multi-contact keep their rep.
 */
function dealPublicContacts(
  d: { portalContacts?: unknown; portalContactName?: string | null; portalContactTitle?: string | null; portalContactEmail?: string | null; portalContactPhone?: string | null },
  orgName: string,
): PublicContact[] {
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  if (Array.isArray(d.portalContacts)) {
    return d.portalContacts
      .map((c, i) => {
        const o = (c && typeof c === "object") ? c as Record<string, unknown> : {};
        return { id: s(o.id) ?? `deal-${i}`, name: s(o.name) ?? orgName, title: s(o.title), email: s(o.email), phone: s(o.phone), department: null, photo: null, isPrimary: i === 0 };
      })
      .filter((c) => c.name || c.email || c.phone);
  }
  if (d.portalContactName || d.portalContactEmail || d.portalContactPhone) {
    return [{ id: "deal", name: d.portalContactName || orgName, title: d.portalContactTitle ?? null, email: d.portalContactEmail ?? null, phone: d.portalContactPhone ?? null, department: null, photo: null, isPrimary: true }];
  }
  return [];
}

/** Org branding + contacts payload. `contact*` legacy fields kept for back-compat. */
async function orgPayload(o: OrgLike) {
  const contacts = await publicContacts(o);
  const primary = contacts.find((c) => c.isPrimary) ?? contacts[0] ?? null;
  return {
    name: o.name,
    slug: o.portalSlug,
    fullLogo: o.fullLogo,
    compactLogo: o.compactLogo,
    contacts,
    // Legacy single-contact fields mirror the primary contact.
    contactName: primary?.name ?? null,
    contactEmail: primary?.email ?? null,
    contactPhone: primary?.phone ?? null,
    officeLocation: primary?.department ?? o.portalOfficeLocation,
  };
}

async function orgBySlug(slug: string) {
  const org = await prisma.organization.findUnique({ where: { portalSlug: slug } });
  if (!org || !org.portalEnabled) throw new HttpError(404, "Portal not found");
  return org;
}

/** Marketplace: the org's published PUBLIC offerings + branding/contact. */
portalRouter.get(
  "/:orgSlug",
  asyncHandler(async (req, res) => {
    const org = await orgBySlug(String(req.params.orgSlug));
    const deals = await prisma.deal.findMany({
      where: { organizationId: org.id, publishedToPortal: true, portalVisibility: "PUBLIC" },
      orderBy: [{ portalFeatured: "desc" }, { updatedAt: "desc" }],
      include: { _count: { select: { assets: true } } },
    });
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ org: await orgPayload(org), deals: deals.map(publicDeal) });
  }),
);

/** Marketplace map: every published PUBLIC offering's abstract footprints. */
portalRouter.get(
  "/:orgSlug/features",
  asyncHandler(async (req, res) => {
    const org = await orgBySlug(String(req.params.orgSlug));
    const deals = await prisma.deal.findMany({
      where: { organizationId: org.id, publishedToPortal: true, portalVisibility: "PUBLIC" },
      select: { portalSlug: true, name: true, abstractIds: true },
    });
    const byAbstract = new Map<string, { slug: string | null; name: string }>();
    for (const d of deals) for (const id of d.abstractIds) byAbstract.set(id, { slug: d.portalSlug, name: d.name });
    const ids = [...byAbstract.keys()].slice(0, 2000);
    if (!ids.length) return res.json({ type: "FeatureCollection", features: [] });
    const rows = await prisma.$queryRawUnsafe<{ id: string; abstract: string | null; survey: string | null; county: string; geom: string }[]>(
      `SELECT id, abstract, survey, county, ST_AsGeoJSON(geom, 6) AS geom FROM gis.abstracts WHERE id = ANY($1::text[])`,
      ids,
    );
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      type: "FeatureCollection",
      features: rows.map((r) => ({
        type: "Feature",
        properties: { id: r.id, abstract: r.abstract, survey: r.survey, county: r.county, ...byAbstract.get(r.id) },
        geometry: JSON.parse(r.geom) as unknown,
      })),
    });
  }),
);

const isImage = (mime: string) => mime.startsWith("image/");

/**
 * Buyer-safe production summary for an offering: match the deal's well
 * names/API numbers to the org's imported wells and aggregate reported
 * volumes. Returns VOLUMES ONLY (no prices/economics) — the portal never
 * exposes internal analysis. Null when the section is off or nothing matches.
 */
async function productionSummary(organizationId: string, wells: string[]) {
  if (!wells.length) return null;
  const or: import("@prisma/client").Prisma.ResearchWellWhereInput[] = [];
  for (const w of wells.slice(0, 60)) {
    const digits = w.replace(/\D/g, "");
    if (digits.length >= 8) or.push({ apiNumber: { contains: digits.slice(0, 10) } });
    if (w.trim()) or.push({ name: { equals: w.trim(), mode: "insensitive" } });
  }
  if (!or.length) return null;
  const matched = await prisma.researchWell.findMany({ where: { organizationId, OR: or }, select: { id: true } });
  const wellIds = matched.map((m) => m.id);
  if (!wellIds.length) return null;

  const agg = await prisma.wellProductionMonth.aggregate({
    where: { wellId: { in: wellIds } },
    _sum: { oilBbl: true, gasMcf: true, nglBbl: true },
    _min: { month: true }, _max: { month: true }, _count: true,
  });
  if (!agg._count || !agg._max.month) return null;

  // Trailing 12 months from the latest reported month.
  const cutoff = new Date(agg._max.month); cutoff.setUTCMonth(cutoff.getUTCMonth() - 11);
  const last12 = await prisma.wellProductionMonth.aggregate({
    where: { wellId: { in: wellIds }, month: { gte: cutoff } },
    _sum: { oilBbl: true, gasMcf: true },
  });

  const oil = agg._sum.oilBbl ?? 0, gas = agg._sum.gasMcf ?? 0, ngl = agg._sum.nglBbl ?? 0;
  return {
    wellsMatched: wellIds.length,
    months: agg._count,
    firstMonth: agg._min.month ? agg._min.month.toISOString().slice(0, 7) : null,
    lastMonth: agg._max.month.toISOString().slice(0, 7),
    cumOilBbl: Math.round(oil),
    cumGasMcf: Math.round(gas),
    cumBoe: Math.round(oil + ngl + gas / 6),
    last12OilBbl: Math.round(last12._sum.oilBbl ?? 0),
    last12GasMcf: Math.round(last12._sum.gasMcf ?? 0),
  };
}

/** One offering by its share slug (works for PUBLIC and LINK_ONLY). */
portalRouter.get(
  "/offering/:slug",
  asyncHandler(async (req, res) => {
    const deal = await prisma.deal.findUnique({
      where: { portalSlug: String(req.params.slug) },
      include: {
        organization: true,
        files: { where: { visibleToBuyers: true, supersededById: null }, select: { id: true, filename: true, mimeType: true, sizeBytes: true, folder: true, s3Key: true } },
        _count: { select: { assets: true } },
        // Bundle contents: buyer-safe summaries of the package's child assets
        // (no pricing — the portal never leaks per-asset economics).
        assets: { select: { id: true, name: true, counties: true, states: true, state: true, nra: true, assetTypes: true, operator: true }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!deal || !deal.publishedToPortal || !deal.organization?.portalEnabled) {
      throw new HttpError(404, "Offering not found");
    }
    const sections = dealSections(deal.portalSections);
    // Abstract/survey labels for the info grid (numbers alone mean little).
    const abstracts = deal.abstractIds.length
      ? await prisma.$queryRawUnsafe<{ id: string; abstract: string | null; survey: string | null; county: string }[]>(
          `SELECT id, abstract, survey, county FROM gis.abstracts WHERE id = ANY($1::text[])`,
          deal.abstractIds.slice(0, 500),
        )
      : [];
    // Contacts are only exposed when this deal publishes its contact section.
    // Contact info is configured PER DEAL: this deal's own contacts (all of them)
    // are shown; otherwise fall back to the org's portal contacts so existing
    // listings never lose a point of contact.
    const orgBase = await orgPayload(deal.organization);
    const dealContacts = dealPublicContacts(deal, deal.organization.name);
    const org = dealContacts.length
      ? {
          ...orgBase,
          contacts: dealContacts,
          contactName: dealContacts[0].name,
          contactEmail: dealContacts[0].email,
          contactPhone: dealContacts[0].phone,
        }
      : orgBase;

    // Split buyer-visible files: images become a presigned gallery, the rest are documents.
    const filesVisible = (sections.documents || sections.attachments) ? deal.files : [];
    const imageFiles = filesVisible.filter((f) => isImage(f.mimeType));
    const documents = filesVisible.filter((f) => !isImage(f.mimeType))
      .map(({ id, filename, mimeType, sizeBytes, folder }) => ({ id, filename, mimeType, sizeBytes, folder }));
    const images = s3Configured()
      ? await Promise.all(imageFiles.map(async (f) => ({ id: f.id, filename: f.filename, url: await getDownloadUrl(f.s3Key, f.filename, true).catch(() => null) })))
      : [];

    const production = sections.production && deal.organizationId ? await productionSummary(deal.organizationId, deal.wells) : null;

    // Bundle: a package's constituent assets (buyer-safe, no pricing).
    const assets = deal.assets.map((a) => ({
      id: a.id,
      name: a.name,
      counties: a.counties,
      states: a.states.length ? a.states : a.state ? [a.state] : [],
      nra: a.nra,
      assetTypes: a.assetTypes,
      operator: a.operator,
    }));

    res.json({
      org: sections.contact ? org : { ...org, contacts: [], contactName: null, contactEmail: null, contactPhone: null, officeLocation: null },
      deal: publicDeal(deal),
      abstracts,
      documents,
      images: images.filter((i) => i.url),
      production,
      assets,
    });
  }),
);

/** Offering footprint geometry (auto-fit + highlight on the deal map). */
portalRouter.get(
  "/offering/:slug/features",
  asyncHandler(async (req, res) => {
    const deal = await prisma.deal.findUnique({
      where: { portalSlug: String(req.params.slug) },
      select: { publishedToPortal: true, abstractIds: true, organization: { select: { portalEnabled: true } } },
    });
    if (!deal || !deal.publishedToPortal || !deal.organization?.portalEnabled) throw new HttpError(404, "Offering not found");
    if (!deal.abstractIds.length) return res.json({ type: "FeatureCollection", features: [] });
    const rows = await prisma.$queryRawUnsafe<{ id: string; abstract: string | null; survey: string | null; county: string; geom: string }[]>(
      `SELECT id, abstract, survey, county, ST_AsGeoJSON(geom, 6) AS geom FROM gis.abstracts WHERE id = ANY($1::text[])`,
      deal.abstractIds.slice(0, 500),
    );
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      type: "FeatureCollection",
      features: rows.map((r) => ({
        type: "Feature",
        properties: { id: r.id, abstract: r.abstract, survey: r.survey, county: r.county },
        geometry: JSON.parse(r.geom) as unknown,
      })),
    });
  }),
);

/** Buyer-approved document download (presigned URL, same as the CRM flow). */
portalRouter.get(
  "/offering/:slug/files/:fileId/download",
  asyncHandler(async (req, res) => {
    if (!s3Configured()) throw new HttpError(503, "Document downloads are temporarily unavailable");
    const file = await prisma.fileAttachment.findUnique({
      where: { id: String(req.params.fileId) },
      include: { deal: { select: { portalSlug: true, publishedToPortal: true } } },
    });
    if (!file || !file.visibleToBuyers || !file.deal || file.deal.portalSlug !== req.params.slug || !file.deal.publishedToPortal) {
      throw new HttpError(404, "Document not found");
    }
    const url = await getDownloadUrl(file.s3Key, file.filename, req.query.inline === "1");
    res.json({ url });
  }),
);

// ---------------------------------------------------------------------------
// Lead capture — "Don't see what you're looking for?"
// ---------------------------------------------------------------------------

const leadSchema = z.object({
  companyName: z.string().trim().min(1).max(160),
  contactName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).optional().default(""),
  preferredContact: z.enum(["email", "phone", "either"]).optional().default("either"),
  buyBox: z.object({
    states: z.array(z.string().trim().max(40)).max(50).default([]),
    counties: z.array(z.string().trim().max(60)).max(200).default([]),
    basins: z.array(z.string().trim().max(80)).max(50).default([]),
    formations: z.array(z.string().trim().max(80)).max(50).default([]),
    assetTypes: z.array(z.string().trim().max(60)).max(20).default([]),
    minAcreage: z.number().nonnegative().optional().nullable(),
    maxAcreage: z.number().nonnegative().optional().nullable(),
    minPrice: z.number().nonnegative().optional().nullable(),
    maxPrice: z.number().nonnegative().optional().nullable(),
  }).default({}),
  // Free-text preferences that don't map to structured buy-box fields
  // (NRA range, abstracts, surveys, operator/well-status preferences, notes).
  additionalCriteria: z.string().trim().max(4000).optional().default(""),
});

portalRouter.post(
  "/:orgSlug/leads",
  asyncHandler(async (req, res) => {
    const org = await orgBySlug(String(req.params.orgSlug));
    const ip = req.ip ?? "unknown";
    if (await portalRateLimited("portal-submit", ip)) throw new HttpError(429, "Too many submissions — please try again later");
    const lead = leadSchema.parse(req.body);
    const email = lead.email.toLowerCase();
    const normCompany = normalizeCompany(lead.companyName);
    const now = new Date();

    const criteriaNote = [
      `— Portal submission ${now.toISOString().slice(0, 10)} —`,
      `Preferred contact: ${lead.preferredContact}`,
      lead.additionalCriteria ? `Additional criteria: ${lead.additionalCriteria}` : null,
    ].filter(Boolean).join("\n");

    // Dedupe: exact email match merges; company-only match flags for review.
    const existing = await prisma.buyer.findFirst({
      where: { organizationId: org.id, email: { equals: email, mode: "insensitive" } },
    });
    const companyMatch = existing
      ? null
      : await prisma.buyer.findFirst({ where: { organizationId: org.id, normalizedCompany: normCompany } });

    let buyerId: string;
    let outcome: "created" | "merged" | "flagged";
    if (existing) {
      // Merge: fill blanks only — never overwrite user-entered data.
      await prisma.buyer.update({
        where: { id: existing.id },
        data: {
          contactName: existing.contactName || lead.contactName,
          phone: existing.phone || lead.phone || null,
          portalSubmittedAt: now,
          notes: [existing.notes, criteriaNote].filter(Boolean).join("\n\n"),
        },
      });
      // Buy box: fill only empty criteria lists/limits.
      const bb = await prisma.buyBoxCriteria.findUnique({ where: { buyerId: existing.id } });
      if (!bb) {
        await prisma.buyBoxCriteria.create({ data: { buyerId: existing.id, ...lead.buyBox } });
      } else {
        await prisma.buyBoxCriteria.update({
          where: { buyerId: existing.id },
          data: {
            states: bb.states.length ? bb.states : lead.buyBox.states,
            counties: bb.counties.length ? bb.counties : lead.buyBox.counties,
            basins: bb.basins.length ? bb.basins : lead.buyBox.basins,
            formations: bb.formations.length ? bb.formations : lead.buyBox.formations,
            assetTypes: bb.assetTypes.length ? bb.assetTypes : lead.buyBox.assetTypes,
            minAcreage: bb.minAcreage ?? lead.buyBox.minAcreage,
            maxAcreage: bb.maxAcreage ?? lead.buyBox.maxAcreage,
            minPrice: bb.minPrice ?? lead.buyBox.minPrice,
            maxPrice: bb.maxPrice ?? lead.buyBox.maxPrice,
          },
        });
      }
      buyerId = existing.id;
      outcome = "merged";
    } else {
      const created = await prisma.buyer.create({
        data: {
          organizationId: org.id,
          name: lead.companyName,
          companyName: lead.companyName,
          contactName: lead.contactName,
          email,
          phone: lead.phone || null,
          normalizedCompany: normCompany,
          source: "portal",
          portalSubmittedAt: now,
          // Same company name but a different email → can't confirm identity;
          // flag the new profile for a human duplicate check.
          duplicateReview: Boolean(companyMatch),
          notes: criteriaNote,
          buyBox: { create: lead.buyBox },
        },
      });
      buyerId = created.id;
      outcome = companyMatch ? "flagged" : "created";
    }

    // Internal notification → assigned owners, else org admins see it (userId null).
    const owners = await prisma.buyerOwner.findMany({ where: { buyerId }, select: { userId: true } });
    const interest = [...lead.buyBox.states, ...lead.buyBox.counties, ...lead.buyBox.basins].slice(0, 6).join(", ") || "—";
    const title = `Portal lead: ${lead.contactName} (${lead.companyName})`;
    const body = `Submitted ${now.toLocaleDateString("en-US")} · Areas of interest: ${interest}${outcome === "flagged" ? " · POSSIBLE DUPLICATE — review" : outcome === "merged" ? " · merged into existing profile" : ""}`;
    const targets: (string | null)[] = owners.length ? owners.map((o) => o.userId) : [null];
    await prisma.notification.createMany({
      data: targets.map((userId) => ({
        organizationId: org.id, userId, type: "portal_lead", title, body, link: `/buyers/${buyerId}`,
      })),
    });

    res.status(201).json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Submit an offer — a buyer offers on a specific published offering
// ---------------------------------------------------------------------------

const offerSchema = z.object({
  companyName: z.string().trim().min(1).max(160),
  contactName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).optional().default(""),
  amount: z.number().positive().max(1e12),
  conditions: z.string().trim().max(2000).optional().default(""),
  // Optional buyer-set expiration for the offer (ISO date).
  expiresOn: z.string().trim().optional().nullable(),
  message: z.string().trim().max(4000).optional().default(""),
});

portalRouter.post(
  "/offering/:slug/offers",
  asyncHandler(async (req, res) => {
    const ip = req.ip ?? "unknown";
    if (await portalRateLimited("portal-submit", ip)) throw new HttpError(429, "Too many submissions — please try again later");

    const deal = await prisma.deal.findUnique({
      where: { portalSlug: String(req.params.slug) },
      select: { id: true, name: true, organizationId: true, publishedToPortal: true, relationshipOwnerId: true, organization: { select: { portalEnabled: true } } },
    });
    if (!deal || !deal.publishedToPortal || !deal.organization?.portalEnabled || !deal.organizationId) {
      throw new HttpError(404, "Offering not found");
    }

    const body = offerSchema.parse(req.body);
    const email = body.email.toLowerCase();
    const now = new Date();
    const expirationDate = body.expiresOn ? new Date(body.expiresOn) : null;
    if (expirationDate && isNaN(expirationDate.getTime())) throw new HttpError(400, "Invalid expiration date");

    // Resolve the buyer the same way leads do: exact-email match merges (filling
    // blanks only), otherwise create a new portal-sourced profile.
    const existing = await prisma.buyer.findFirst({
      where: { organizationId: deal.organizationId, email: { equals: email, mode: "insensitive" } },
    });
    let buyerId: string;
    if (existing) {
      await prisma.buyer.update({
        where: { id: existing.id },
        data: { contactName: existing.contactName || body.contactName, phone: existing.phone || body.phone || null, portalSubmittedAt: now },
      });
      buyerId = existing.id;
    } else {
      const created = await prisma.buyer.create({
        data: {
          organizationId: deal.organizationId,
          name: body.companyName, companyName: body.companyName, contactName: body.contactName,
          email, phone: body.phone || null, normalizedCompany: normalizeCompany(body.companyName),
          source: "portal", portalSubmittedAt: now,
        },
      });
      buyerId = created.id;
    }

    await prisma.offer.create({
      data: {
        dealId: deal.id, buyerId, amount: body.amount, status: "ACTIVE",
        conditions: body.conditions || null, expirationDate,
        // Mark provenance in the note so the CRM shows where it came from.
        notes: `Submitted via buyer portal on ${now.toLocaleDateString("en-US")}.${body.message ? `\n\n${body.message}` : ""}`,
      },
    });

    // Notify the deal's owner (else the org broadly) so an offer never sits unseen.
    const title = `Portal offer: ${body.companyName} on "${deal.name}"`;
    const bodyText = `$${Math.round(body.amount).toLocaleString("en-US")} offer from ${body.contactName}${body.conditions ? ` · terms: ${body.conditions.slice(0, 80)}` : ""}`;
    await prisma.notification.create({
      data: {
        organizationId: deal.organizationId, userId: deal.relationshipOwnerId ?? null,
        type: "portal_offer", title, body: bodyText, link: `/deals/${deal.id}`,
      },
    });

    res.status(201).json({ ok: true });
  }),
);
