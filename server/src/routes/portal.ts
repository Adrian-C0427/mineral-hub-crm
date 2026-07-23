import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { normalizeCompany } from "../serializers.js";
import { normalizePhone } from "../domain/phone.js";
import { getDownloadUrl, s3Configured } from "../services/s3.js";
import { portalRateLimited, PORTAL_READ_MAX_PER_WINDOW } from "../services/portalRateLimit.js";
import { pushTeams } from "../services/notifyPush.js";

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

/**
 * Buyer-safe projection of a deal. The ONLY shape the portal ever returns.
 *
 * There is no per-deal section configuration: the offering auto-displays any
 * field that has a value and omits anything empty. `askPrice` uses the deal's
 * buyer-facing override, else the deal askPrice. Internal notes are NEVER
 * exposed (they're internal by nature — the panel promises they never appear).
 */
function publicDeal(d: {
  name: string; portalSlug: string | null; portalSummary: string | null; portalFeatured: boolean;
  counties: string[]; states: string[]; state: string | null; abstractIds: string[];
  basins: string[]; formations: string[]; assetTypes: string[]; surveys: string[];
  nra: number | null; acreageNma: number | null; operator: string | null; rrc?: string | null;
  wells: string[]; producingStatus: string | null; updatedAt: Date;
  portalAskPrice?: number | null; askPrice?: number | null;
  _count?: { assets?: number };
}) {
  return {
    slug: d.portalSlug,
    name: d.name,
    summary: d.portalSummary?.trim() ? d.portalSummary : null,
    featured: d.portalFeatured,
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
    wells: d.wells,
    producingStatus: d.producingStatus,
    askPrice: d.portalAskPrice ?? d.askPrice ?? null,
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

/**
 * Per-IP ceiling for the unauthenticated READ routes. Every public route runs
 * this: the marketplace pair used to be uncapped, which left a scripted loop
 * free to grind the abstracts geometry query (up to 2,000 polygons a call) with
 * no auth and no cost. `Cache-Control` on those responses is only a hint to the
 * client — nothing caches them server-side, so it was never a throttle.
 */
async function guardPortalRead(req: import("express").Request): Promise<void> {
  const ip = req.ip ?? "unknown";
  if (await portalRateLimited("portal-read", ip, Date.now(), PORTAL_READ_MAX_PER_WINDOW)) {
    throw new HttpError(429, "Too many requests — please try again later");
  }
}

/** Marketplace: the org's published PUBLIC offerings + branding/contact. */
portalRouter.get(
  "/:orgSlug",
  asyncHandler(async (req, res) => {
    await guardPortalRead(req);
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
    await guardPortalRead(req);
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
    // Heaviest public route: deal + org + files + assets, a raw abstracts query,
    // a production aggregation, and one S3 presign per image. Cap it per IP so a
    // scripted loop can't turn it into a cheap DB/S3 amplifier.
    await guardPortalRead(req);
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
    // Abstract/survey labels for the info grid (numbers alone mean little).
    const abstracts = deal.abstractIds.length
      ? await prisma.$queryRawUnsafe<{ id: string; abstract: string | null; survey: string | null; county: string }[]>(
          `SELECT id, abstract, survey, county FROM gis.abstracts WHERE id = ANY($1::text[])`,
          deal.abstractIds.slice(0, 500),
        )
      : [];
    // Contact info is configured PER DEAL: this deal's own contacts (all of them)
    // are shown; otherwise fall back to the org's portal contacts so existing
    // listings never lose a point of contact. The offering hides the whole
    // Contact block if neither yields anyone.
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

    // Buyer-visible files: images become a presigned gallery, the rest are
    // documents. Any file marked visible-to-buyers is shown automatically.
    const imageFiles = deal.files.filter((f) => isImage(f.mimeType));
    const documents = deal.files.filter((f) => !isImage(f.mimeType))
      .map(({ id, filename, mimeType, sizeBytes, folder }) => ({ id, filename, mimeType, sizeBytes, folder }));
    const images = s3Configured()
      ? await Promise.all(imageFiles.map(async (f) => ({ id: f.id, filename: f.filename, url: await getDownloadUrl(f.s3Key, f.filename, true).catch(() => null) })))
      : [];

    // Production is aggregated whenever the deal's wells match imported wells;
    // returns null (and the section hides) when there's nothing to show.
    const production = deal.organizationId ? await productionSummary(deal.organizationId, deal.wells) : null;

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

    // Deliberately `private` and short, unlike the marketplace routes' `public`
    // caching: this body embeds presigned S3 URLs that expire, so a shared cache
    // could hand a later visitor dead image links. 30s is enough to absorb a
    // reload without outliving the signatures.
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json({
      org,
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
    await guardPortalRead(req);
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
    await guardPortalRead(req);
    const file = await prisma.fileAttachment.findUnique({
      where: { id: String(req.params.fileId) },
      // portalEnabled is the org's portal kill switch. Every other portal route
      // honours it; this one didn't, so a saved document link kept minting fresh
      // presigned URLs after an owner had taken the portal down.
      include: { deal: { select: { portalSlug: true, publishedToPortal: true, organization: { select: { portalEnabled: true } } } } },
    });
    if (
      !file ||
      !file.visibleToBuyers ||
      !file.deal ||
      file.deal.portalSlug !== req.params.slug ||
      !file.deal.publishedToPortal ||
      !file.deal.organization?.portalEnabled
    ) {
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
  phone: z.string().trim().max(40).optional().default("").transform(normalizePhone),
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
    let outcome: "created" | "review" | "flagged";
    if (existing) {
      // This submission is UNAUTHENTICATED and the only thing proving identity
      // is knowledge of an email address — which is not a secret. So a match
      // must never write attacker-controlled content into a trusted CRM record:
      // previously the submitted text was appended to the buyer's notes and an
      // empty buy box was populated outright, letting anyone who knew a buyer's
      // address poison the targeting the team acts on.
      //
      // Only the timestamp (not attacker-controlled) is recorded; everything the
      // submitter typed rides along in the notification below for a human to
      // review and merge deliberately.
      await prisma.buyer.update({
        where: { id: existing.id },
        data: { portalSubmittedAt: now, duplicateReview: true },
      });
      buyerId = existing.id;
      outcome = "review";
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
    const suffix = outcome === "flagged"
      ? " · POSSIBLE DUPLICATE — review"
      : outcome === "review"
        // Matched an existing buyer by email alone, which anyone could guess.
        // The profile was NOT updated — the submission is reproduced here so an
        // authenticated user can merge what they judge legitimate.
        ? `\n\nMatched an existing buyer by email. The profile was NOT modified — review and merge manually.\n\n${criteriaNote}`
        : "";
    const body = `Submitted ${now.toLocaleDateString("en-US")} · Areas of interest: ${interest}${suffix}`;
    const targets: (string | null)[] = owners.length ? owners.map((o) => o.userId) : [null];
    await prisma.notification.createMany({
      data: targets.map((userId) => ({
        organizationId: org.id, userId, type: "portal_lead", title, body, link: `/buyers/${buyerId}`,
      })),
    });
    void pushTeams(org.id, { title, body, link: `/buyers/${buyerId}` });

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
  phone: z.string().trim().max(40).optional().default("").transform(normalizePhone),
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

    // Resolve the buyer the same way leads do — and with the same rule: this
    // submission is UNAUTHENTICATED, and the only thing tying it to an existing
    // profile is knowledge of an email address, which is not a secret. So an
    // email match must never write submitted content into a trusted CRM record.
    // Previously the submitter's contactName/phone were merged into any blank
    // field on the match, so anyone who knew a buyer's address could edit that
    // buyer's contact details and hang a fabricated offer off their profile.
    //
    // The offer still attaches to the matched buyer (that attribution is the
    // point of the record), but the profile is left untouched and flagged for
    // review, and the self-reported identity rides along on the offer note so
    // whoever works it can verify before acting.
    const existing = await prisma.buyer.findFirst({
      where: { organizationId: deal.organizationId, email: { equals: email, mode: "insensitive" } },
    });
    let buyerId: string;
    if (existing) {
      await prisma.buyer.update({
        where: { id: existing.id },
        data: { portalSubmittedAt: now, duplicateReview: true },
      });
      buyerId = existing.id;
    } else {
      const created = await prisma.buyer.create({
        data: {
          organizationId: deal.organizationId,
          name: body.companyName, companyName: body.companyName, contactName: body.contactName,
          contactFirstName: body.contactName.trim().split(/\s+/)[0] || null,
          contactLastName: body.contactName.trim().split(/\s+/).slice(1).join(" ") || null,
          email, phone: body.phone || null, normalizedCompany: normalizeCompany(body.companyName),
          source: "portal", portalSubmittedAt: now,
        },
      });
      buyerId = created.id;
    }

    // Provenance note. The submitter's self-reported identity is recorded HERE
    // rather than on the buyer profile: it is unverified input, so it belongs on
    // the artifact it describes, where it reads as a claim instead of as CRM fact.
    const submitted = [
      `Submitted via buyer portal on ${now.toLocaleDateString("en-US")}.`,
      `Submitter (unverified): ${body.contactName} · ${body.companyName} · ${email}${body.phone ? ` · ${body.phone}` : ""}`,
      existing ? "Matched an existing buyer by email alone — verify identity before acting on this offer." : null,
      body.message || null,
    ].filter(Boolean).join("\n\n");

    await prisma.offer.create({
      data: {
        dealId: deal.id, buyerId, amount: body.amount, status: "ACTIVE",
        conditions: body.conditions || null, expirationDate,
        notes: submitted,
      },
    });

    // Notify the deal's owner (else the org broadly) so an offer never sits unseen.
    const title = `Portal offer: ${body.companyName} on "${deal.name}"`;
    const bodyText = `$${Math.round(body.amount).toLocaleString("en-US")} offer from ${body.contactName}${body.conditions ? ` · terms: ${body.conditions.slice(0, 80)}` : ""}`
      // An email match is not proof of identity, so say so where it's read.
      + (existing ? " · UNVERIFIED — matched an existing buyer by email only; confirm before acting" : "");
    await prisma.notification.create({
      data: {
        organizationId: deal.organizationId, userId: deal.relationshipOwnerId ?? null,
        type: "portal_offer", title, body: bodyText, link: `/deals/${deal.id}`,
      },
    });
    void pushTeams(deal.organizationId, { title, body: bodyText, link: `/deals/${deal.id}` });

    res.status(201).json({ ok: true });
  }),
);
