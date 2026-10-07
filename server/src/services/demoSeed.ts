/**
 * Demo / showcase workspace seeder.
 *
 * Creates — or wipes and recreates — one fully populated, realistic org for a
 * fictional mineral acquisition company ("Brazos Ridge Minerals") so every
 * screen of the app has something credible on it. Used by the
 * `npm run seed:demo` CLI (scripts/seedDemo.ts) and safe to re-run: a reset
 * produces the same dataset every time (seeded PRNG; dates relative to `now`).
 *
 * SAFETY MODEL — this runs against the production database, which holds a real
 * company's data. Every write is provably confined to the demo org:
 *   - Only an Organization with `isDemo = true` is ever wiped/reseeded. The org
 *     is re-read and asserted demo immediately before any delete, and more than
 *     one demo org is a hard error.
 *   - Every delete is `where: { organizationId: demoOrgId }`, or reaches child
 *     rows through a relation filter that is itself scoped to demoOrgId. There is
 *     no unscoped deleteMany and no raw DELETE/TRUNCATE. The Organization row
 *     itself is never deleted.
 *   - Users: only rows whose organizationId is the demo org AND whose email ends
 *     with @brazosridge.demo are touched; a demo email owned by any other org is
 *     a hard error.
 *   - The reference org is read-only: validated (exists, not demo) and its id
 *     stored on the demo org. None of its CRM data is read or written. No
 *     Research / MapTract rows are created in the demo org (the app reads those
 *     live from the reference org).
 *   - gis.* / rrc.* are read with SELECT only (real abstracts, operators and
 *     wells when present; curated fallbacks otherwise).
 *
 * The reset itself (wipe + reseed) is ONE database transaction, so a failure
 * leaves the previous demo dataset in place. S3 objects are handled around it:
 * new documents are uploaded first (removed again if the transaction fails) and
 * the old demo documents are deleted only after the commit.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Prisma, PrismaClient } from "@prisma/client";
import { hashPassword } from "../auth/password.js";
import { generateTeamId } from "./org.js";
import { s3Configured, putObject, deleteObject, buildKey } from "./s3.js";
import { ensureDefaultPipeline, ensureStages, seedStages } from "../domain/stages.js";
import { STARTER_TYPES, nextTypeColor } from "../domain/calendar.js";
import { convertedDealFields, convertedSeller, type ConvertibleOpportunity, type ConvertibleContact } from "../domain/opportunities.js";
import { normalizeAssumptions, runValuation, type MonthVolumes, type ValuationAssumptions } from "../domain/valuation.js";
import { normalizeCompany } from "../serializers.js";
import { formatCalendarDay } from "../domain/dates.js";
import { abstractNumber } from "../domain/abstractLabel.js";
import {
  BUYERS, CONTACT_SOURCES, COUNTIES, DEAD_REASONS, DISTANT_TOWNS, EMAIL_TEMPLATES, EXPENSE_CATEGORIES,
  FALLBACK_WELLS, FIRST_NAMES, INTERESTS, LANDMEN, LAST_NAMES, OPPORTUNITY_NOTES, OPPORTUNITY_PLAN,
  PORTAL_SUMMARIES, STREETS, TEAM, type BuyerSpec, type CountyInfo, type FallbackWell, type Region, type TeamMember,
} from "./demoSeed.data.js";

export const DEMO_EMAIL_DOMAIN = "brazosridge.demo";
export const DEMO_ORG_NAME = "Brazos Ridge Minerals";
export const DEMO_PORTAL_SLUG = "brazos-ridge-minerals";
export const MIN_DEMO_PASSWORD_LENGTH = 12;
const PRNG_SEED = 20_261_007;
const TX_OPTIONS = { timeout: 10 * 60_000, maxWait: 60_000 } as const;

export interface SeedDemoOptions {
  referenceOrgId: string | null; // org whose Research/Map data the demo reads (validated: exists, not demo)
  demoUserEmail: string; // login user, must end with @brazosridge.demo
  demoUserPassword: string; // >= 12 chars; hashed with the app's password helper
  now?: Date; // all dates relative to this (default new Date())
  log?: (msg: string) => void;
}

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type AnyDb = Db | Tx;

// ===========================================================================
// Guards (exported for the CLI and unit tests)
// ===========================================================================

/** True for `local@brazosridge.demo` (case-insensitive, exact domain). */
export function isDemoEmail(email: string): boolean {
  const e = (email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return false;
  return e.slice(at + 1) === DEMO_EMAIL_DOMAIN && /^[a-z0-9._+-]+$/.test(e.slice(0, at));
}

export function assertDemoEmail(email: string): void {
  if (!isDemoEmail(email)) throw new Error(`Demo user email must end with @${DEMO_EMAIL_DOMAIN} (got "${email}")`);
}

/** Prisma filter for the only users the seeder may touch. */
function demoUserScope(demoOrgId: string) {
  return { organizationId: demoOrgId, email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } };
}

/** The demo org (isDemo = true), or null. More than one is a hard error. */
export async function findDemoOrg(prisma: AnyDb): Promise<{ id: string; referenceOrgId: string | null } | null> {
  const rows = await prisma.organization.findMany({ where: { isDemo: true }, select: { id: true, referenceOrgId: true }, take: 2 });
  if (rows.length > 1) throw new Error("More than one organization has isDemo = true — refusing to continue");
  return rows[0] ?? null;
}

/** Re-read the org and assert it is THE demo org. Called right before deletes. */
export async function assertDemoOrg(prisma: AnyDb, demoOrgId: string): Promise<void> {
  if (!demoOrgId || typeof demoOrgId !== "string") throw new Error("A demo organization id is required");
  const demos = await prisma.organization.findMany({ where: { isDemo: true }, select: { id: true }, take: 2 });
  if (demos.length > 1) throw new Error("More than one organization has isDemo = true — refusing to continue");
  const org = await prisma.organization.findUnique({ where: { id: demoOrgId }, select: { id: true, isDemo: true } });
  if (!org) throw new Error(`Organization ${demoOrgId} not found`);
  if (org.isDemo !== true) throw new Error(`Organization ${demoOrgId} is not a demo organization (isDemo is not true) — refusing to touch it`);
  if (demos[0]?.id !== demoOrgId) throw new Error("Demo organization mismatch — refusing to continue");
}

/** Validate a reference org id: must exist, must not be demo, must not be the demo org. */
export async function validateReferenceOrg(
  prisma: AnyDb,
  referenceOrgId: string | null,
  demoOrgId: string | null = null,
): Promise<{ id: string; name: string } | null> {
  if (referenceOrgId == null) return null;
  const org = await prisma.organization.findUnique({ where: { id: referenceOrgId }, select: { id: true, name: true, isDemo: true } });
  if (!org) throw new Error(`Reference organization ${referenceOrgId} not found`);
  if (org.isDemo !== false) throw new Error("The reference organization must not be a demo organization");
  if (demoOrgId && org.id === demoOrgId) throw new Error("The reference organization cannot be the demo organization itself");
  return { id: org.id, name: org.name };
}

/** Resolve `--reference-org` (an org id or an exact org name) to one non-demo org. */
export async function resolveReferenceOrg(prisma: AnyDb, idOrName: string): Promise<{ id: string; name: string }> {
  const key = (idOrName ?? "").trim();
  if (!key) throw new Error("--reference-org is required (an organization id or exact name)");
  const byId = await prisma.organization.findUnique({ where: { id: key }, select: { id: true, name: true, isDemo: true } });
  const matches = byId ? [byId] : await prisma.organization.findMany({ where: { name: key }, select: { id: true, name: true, isDemo: true }, take: 2 });
  if (matches.length === 0) throw new Error(`No organization matches "${key}"`);
  if (matches.length > 1) throw new Error(`"${key}" matches more than one organization — pass the org id instead`);
  if (matches[0].isDemo !== false) throw new Error("The reference organization must not be a demo organization");
  return { id: matches[0].id, name: matches[0].name };
}

// ===========================================================================
// Wipe
// ===========================================================================

const fileScope = (demoOrgId: string) => ({ OR: [{ deal: { organizationId: demoOrgId } }, { buyer: { organizationId: demoOrgId } }] });

/** S3 keys of every FileAttachment belonging to the demo org. */
async function demoFileKeys(prisma: AnyDb, demoOrgId: string): Promise<string[]> {
  const rows = await prisma.fileAttachment.findMany({ where: fileScope(demoOrgId), select: { s3Key: true } });
  return rows.map((r) => r.s3Key).filter(Boolean);
}

/**
 * Delete every CRM row of the demo org (never the Organization row, never a
 * user). Re-asserts isDemo first. Every statement is scoped to demoOrgId.
 */
async function wipeRows(tx: Tx, demoOrgId: string): Promise<void> {
  await assertDemoOrg(tx, demoOrgId);
  const D = { organizationId: demoOrgId };
  const viaDeal = { deal: { organizationId: demoOrgId } };
  const viaBuyer = { buyer: { organizationId: demoOrgId } };
  const viaOpp = { opportunity: { organizationId: demoOrgId } };

  await tx.notification.deleteMany({ where: D });
  await tx.activityLog.deleteMany({ where: D });
  await tx.calendarEvent.deleteMany({ where: D });
  await tx.calendarEventType.deleteMany({ where: D });
  await tx.contactActivity.deleteMany({ where: D });
  await tx.opportunityActivity.deleteMany({ where: viaOpp });
  await tx.opportunityStageHistory.deleteMany({ where: viaOpp });
  await tx.opportunity.deleteMany({ where: D });
  await tx.portalEvent.deleteMany({ where: viaDeal });
  await tx.fileAttachment.deleteMany({ where: fileScope(demoOrgId) });
  await tx.dealBuyerMessage.deleteMany({ where: { OR: [D, viaDeal, viaBuyer] } });
  await tx.dealBuyerActivity.deleteMany({ where: { OR: [viaDeal, viaBuyer] } });
  await tx.deal.updateMany({ where: D, data: { selectedOfferId: null, selectedBuyerId: null, parentDealId: null } });
  await tx.offer.deleteMany({ where: { OR: [viaDeal, viaBuyer] } });
  await tx.dealContractExtension.deleteMany({ where: viaDeal });
  await tx.assetRevenueEntry.deleteMany({ where: viaDeal });
  await tx.dealSeller.deleteMany({ where: viaDeal });
  await tx.dealStageHistory.deleteMany({ where: viaDeal });
  await tx.mapTract.deleteMany({ where: D });
  await tx.deal.deleteMany({ where: D });
  await tx.buyerTagOnBuyer.deleteMany({ where: viaBuyer });
  await tx.buyerOwner.deleteMany({ where: viaBuyer });
  await tx.buyBoxCriteria.deleteMany({ where: viaBuyer });
  await tx.buyer.deleteMany({ where: D });
  await tx.buyerTag.deleteMany({ where: D });
  await tx.contactList.deleteMany({ where: D });
  await tx.contact.deleteMany({ where: D });
  await tx.expense.deleteMany({ where: D });
  await tx.expenseCategory.deleteMany({ where: D });
  await tx.wellAnalysis.deleteMany({ where: D });
  await tx.wellProductionMonth.deleteMany({ where: { well: D } });
  await tx.researchWell.deleteMany({ where: D });
  await tx.researchIngestRow.deleteMany({ where: D });
  await tx.researchIngestRun.deleteMany({ where: D });
  await tx.researchDocument.deleteMany({ where: D });
  await tx.researchPermit.deleteMany({ where: D });
  await tx.emailTemplate.deleteMany({ where: D });
  await tx.portalContact.deleteMany({ where: D });
  await tx.pipelineStage.deleteMany({ where: D });
  await tx.pipeline.deleteMany({ where: D });
  await tx.rolePermissions.deleteMany({ where: D });
  await tx.inviteCode.deleteMany({ where: D });
  await tx.integration.deleteMany({ where: D });
  await tx.passwordResetToken.deleteMany({ where: { user: demoUserScope(demoOrgId) } });
}

/**
 * Wipe the demo org's data (asserts isDemo). S3 objects of its documents are
 * deleted first, then every row in one transaction. The Organization row and
 * its users are kept.
 */
export async function wipeDemoOrgData(prisma: Db, demoOrgId: string): Promise<void> {
  await assertDemoOrg(prisma, demoOrgId);
  if (s3Configured()) {
    for (const key of await demoFileKeys(prisma, demoOrgId)) await deleteObject(key);
  }
  await prisma.$transaction((tx) => wipeRows(tx, demoOrgId), TX_OPTIONS);
}

/** Per-model row counts of the demo org (dry-run plan + final report). */
export async function countDemoRows(prisma: AnyDb, demoOrgId: string): Promise<Record<string, number>> {
  const D = { organizationId: demoOrgId };
  const viaDeal = { deal: { organizationId: demoOrgId } };
  const viaBuyer = { buyer: { organizationId: demoOrgId } };
  const viaOpp = { opportunity: { organizationId: demoOrgId } };
  const entries: [string, Promise<number>][] = [
    ["User (demo team)", prisma.user.count({ where: demoUserScope(demoOrgId) })],
    ["Pipeline", prisma.pipeline.count({ where: D })],
    ["PipelineStage", prisma.pipelineStage.count({ where: D })],
    ["Deal (opportunity records)", prisma.deal.count({ where: { ...D, recordType: "OPPORTUNITY" } })],
    ["Deal (owned assets)", prisma.deal.count({ where: { ...D, recordType: "OWNED_ASSET" } })],
    ["DealSeller", prisma.dealSeller.count({ where: viaDeal })],
    ["DealStageHistory", prisma.dealStageHistory.count({ where: viaDeal })],
    ["DealBuyerActivity", prisma.dealBuyerActivity.count({ where: viaDeal })],
    ["DealBuyerMessage", prisma.dealBuyerMessage.count({ where: D })],
    ["Offer", prisma.offer.count({ where: viaDeal })],
    ["DealContractExtension", prisma.dealContractExtension.count({ where: viaDeal })],
    ["AssetRevenueEntry", prisma.assetRevenueEntry.count({ where: viaDeal })],
    ["FileAttachment", prisma.fileAttachment.count({ where: fileScope(demoOrgId) })],
    ["PortalEvent", prisma.portalEvent.count({ where: viaDeal })],
    ["PortalContact", prisma.portalContact.count({ where: D })],
    ["Buyer", prisma.buyer.count({ where: D })],
    ["BuyBoxCriteria", prisma.buyBoxCriteria.count({ where: viaBuyer })],
    ["BuyerOwner", prisma.buyerOwner.count({ where: viaBuyer })],
    ["BuyerTag", prisma.buyerTag.count({ where: D })],
    ["BuyerTagOnBuyer", prisma.buyerTagOnBuyer.count({ where: viaBuyer })],
    ["Contact", prisma.contact.count({ where: D })],
    ["ContactList", prisma.contactList.count({ where: D })],
    ["ContactActivity", prisma.contactActivity.count({ where: D })],
    ["Opportunity", prisma.opportunity.count({ where: D })],
    ["OpportunityStageHistory", prisma.opportunityStageHistory.count({ where: viaOpp })],
    ["OpportunityActivity", prisma.opportunityActivity.count({ where: viaOpp })],
    ["ExpenseCategory", prisma.expenseCategory.count({ where: D })],
    ["Expense", prisma.expense.count({ where: D })],
    ["CalendarEventType", prisma.calendarEventType.count({ where: D })],
    ["CalendarEvent", prisma.calendarEvent.count({ where: D })],
    ["ResearchWell", prisma.researchWell.count({ where: D })],
    ["WellProductionMonth", prisma.wellProductionMonth.count({ where: { well: D } })],
    ["WellAnalysis", prisma.wellAnalysis.count({ where: D })],
    ["EmailTemplate", prisma.emailTemplate.count({ where: D })],
    ["Notification", prisma.notification.count({ where: D })],
    ["ActivityLog", prisma.activityLog.count({ where: D })],
    ["MapTract", prisma.mapTract.count({ where: D })],
    ["ResearchDocument", prisma.researchDocument.count({ where: D })],
    ["ResearchPermit", prisma.researchPermit.count({ where: D })],
    ["Integration", prisma.integration.count({ where: D })],
    ["InviteCode", prisma.inviteCode.count({ where: D })],
  ];
  const values = await Promise.all(entries.map(([, p]) => p));
  return Object.fromEntries(entries.map(([k], i) => [k, values[i]]));
}

// ===========================================================================
// Small utilities
// ===========================================================================

/** Deterministic PRNG (mulberry32). */
class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  float(a: number, b: number): number { return a + (b - a) * this.next(); }
  int(a: number, b: number): number { return Math.floor(this.float(a, b + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  shuffle<T>(arr: readonly T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  token(len: number): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let s = "";
    for (let i = 0; i < len; i++) s += chars[Math.floor(this.next() * chars.length)];
    return s;
  }
}

let idSeq = 0;
/** Collision-resistant cuid-like id, generated client-side so batches can reference each other. */
function newId(): string {
  idSeq = (idSeq + 1) % 1_679_616;
  return `c${Date.now().toString(36)}${idSeq.toString(36).padStart(4, "0")}${crypto.randomBytes(6).toString("hex")}`;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Texas local business hours are UTC-5 (CDT); timestamps use local-hour inputs. */
const TZ_OFFSET_H = 5;

class Clock {
  readonly today: number;
  constructor(readonly now: Date) {
    this.today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
  /** Calendar day `n` days from today, at UTC midnight. */
  day(n: number): Date { return new Date(this.today + Math.round(n) * DAY_MS); }
  /** Timestamp on day `n` at a local (CT) hour, never later than a few minutes ago. */
  at(n: number, localHour: number, minute = 0): Date {
    const t = this.today + Math.round(n) * DAY_MS + (localHour + TZ_OFFSET_H) * HOUR_MS + minute * 60_000;
    return new Date(Math.min(t, this.now.getTime() - 7 * 60_000));
  }
  /** Like at() but allowed in the future (calendar/tasks). */
  future(n: number, localHour: number, minute = 0): Date {
    return new Date(this.today + Math.round(n) * DAY_MS + (localHour + TZ_OFFSET_H) * HOUR_MS + minute * 60_000);
  }
  /** Calendar day of a timestamp. */
  dayOf(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
  daysAgo(d: Date): number { return Math.round((this.today - this.dayOf(d).getTime()) / DAY_MS); }
  past(d: Date): Date { return new Date(Math.min(d.getTime(), this.now.getTime() - 7 * 60_000)); }
}

const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const round2 = (x: number) => Math.round(x * 100) / 100;
const money = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const fraction = (r: string) => { const [a, b] = r.split("/").map(Number); return a / b; };
const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);
const maxDate = (...ds: Date[]) => new Date(Math.max(...ds.map((d) => d.getTime())));
/** Route-identical stage label ("SENT_TO_BUYERS" → "Sent To Buyers"), see services/stageUndo. */
const prettyStage = (s: string) => s.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
const ym = (d: Date) => d.toISOString().slice(0, 7);
const ymToDate = (s: string) => new Date(`${s}-01T00:00:00Z`);
const addMonthsYm = (s: string, n: number) => { const d = ymToDate(s); d.setUTCMonth(d.getUTCMonth() + n); return ym(d); };
const monthDiff = (a: string, b: string) => { const [ay, am] = a.split("-").map(Number); const [by, bm] = b.split("-").map(Number); return (by - ay) * 12 + (bm - am); };

const UPPER_TOKENS = /^(RR|PSL|CSL|I&GN|H&TC|T&P|GC&SF|T&NO|CCSD&RGNG|MK&T|H&GN|B&B|SA&MG|BS&F|TC|II|III|[A-Z])$/;
function titleCase(s: string): string {
  return s.trim().split(/\s+/).map((w) => {
    const up = w.toUpperCase();
    if (UPPER_TOKENS.test(up.replace(/[.,]/g, "")) || up.includes("&")) return up;
    return up[0] + up.slice(1).toLowerCase();
  }).join(" ");
}

/** "J. M. Hidalgo Survey" → "Hidalgo Survey"; "Sec. 24, Blk 34, T-2-N, T&P RR Co. Survey" → "Blk 34 Sec 24". */
function shortSurvey(survey: string): string {
  const sec = survey.match(/Sec\.?\s*(\w+),?\s*Blk\.?\s*([\w-]+)/i);
  if (sec) return `Blk ${sec[2]} Sec ${sec[1]}`;
  const base = survey.replace(/\s+(Survey|Sur\.?|Svy)$/i, "").trim();
  if (/\bRR\b/i.test(base)) return `${base.replace(/\s+Co\.?$/i, "")} Survey`;
  const tokens = base.split(/\s+/).filter((t) => !/^[A-Z]\.?$/i.test(t) && !/^(Wm|Jr|Sr)\.?$/i.test(t));
  return `${tokens[tokens.length - 1] ?? base} Survey`;
}

// ---------------------------------------------------------------------------
// Minimal hand-written PDF (no dependency): one Letter page of Helvetica text.
// ---------------------------------------------------------------------------
export function buildPdf(title: string, lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, "-").replace(/([\\()])/g, "\\$1");
  let content = `BT\n/F2 18 Tf\n72 720 Td\n(${esc(title)}) Tj\n/F1 11 Tf\n0 -30 Td\n`;
  for (const l of lines) content += `(${esc(l)}) Tj\n0 -16 Td\n`;
  content += "ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ===========================================================================
// Read-only reference data: real abstracts / operators / wells when present
// ===========================================================================

interface GeoAbstract { id: string; label: string; survey: string }
interface CountyGeo { info: CountyInfo; abstracts: GeoAbstract[]; operators: string[]; realAbstracts: boolean; realOperators: boolean }

async function regclassExists(db: Db, name: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<{ r: string | null }[]>(`SELECT to_regclass($1)::text AS r`, name);
  return Boolean(rows[0]?.r);
}

async function loadGeography(db: Db, log: (m: string) => void): Promise<Map<string, CountyGeo>> {
  const hasGis = await regclassExists(db, "gis.abstracts");
  const hasWells = await regclassExists(db, "rrc.wells");
  log(`Geography: gis.abstracts ${hasGis ? "present (real abstracts)" : "absent (curated fallback)"}; rrc.wells ${hasWells ? "present (real operators)" : "absent (curated fallback)"}`);
  const out = new Map<string, CountyGeo>();
  for (const info of COUNTIES) {
    const geo: CountyGeo = {
      info,
      abstracts: info.abstracts.map((a) => ({ id: `TX-${info.fips}-${abstractNumber(a.abstract)}`, label: a.abstract, survey: a.survey })),
      operators: [...info.operators],
      realAbstracts: false,
      realOperators: false,
    };
    if (hasGis) {
      // SELECT only. Largest named tracts first (they read well on the map).
      const rows = await db.$queryRawUnsafe<{ id: string; abstract: string | null; survey: string | null }[]>(
        `SELECT id, replace(abstract, '?', '') AS abstract, survey
           FROM gis.abstracts
          WHERE upper(county) = upper($1) AND abstract IS NOT NULL AND abstract <> '' AND survey IS NOT NULL AND survey <> ''
          ORDER BY area_m2 DESC NULLS LAST, id
          LIMIT 40`, info.name);
      if (rows.length >= 3) {
        geo.abstracts = rows.map((r) => {
          const survey = titleCase(r.survey!);
          return { id: r.id, label: r.abstract!, survey: /(survey|sur\.?|svy)$/i.test(survey) ? survey : `${survey} Survey` };
        });
        geo.realAbstracts = true;
      }
    }
    if (hasWells) {
      const rows = await db.$queryRawUnsafe<{ operator: string }[]>(
        `SELECT operator FROM rrc.wells
          WHERE upper(county) = upper($1) AND operator IS NOT NULL AND operator <> ''
          GROUP BY operator ORDER BY count(*) DESC, operator LIMIT 6`, info.name);
      if (rows.length) { geo.operators = rows.map((r) => r.operator); geo.realOperators = true; }
    }
    out.set(info.name, geo);
  }
  return out;
}

interface RrcWellRow {
  fid: number; api8: string | null; api10: string | null; well_no: string | null;
  lease_no: string | null; lease_name: string | null; operator: string | null;
  county: string; district: string | null; oil_gas: string | null; type: string | null;
  status: string | null; field_name: string | null; formations: string[] | null;
  spud_date: Date | null; abstract: string | null; survey: string | null;
  lon: number | null; lat: number | null;
}

/** A Well Analysis well: the ResearchWell row to write + its monthly volumes. */
interface SourceWell {
  county: string;
  group: string; // analysis grouping key
  row: Omit<Prisma.ResearchWellCreateManyInput, "organizationId" | "id">;
  volumes: MonthVolumes[];
  manual: boolean;
}

// Copies of the private helpers in routes/wells.ts so RRC wells are mapped
// exactly as POST /wells/import-rrc maps them.
function classifyWellStatus(s: string): "PRODUCING" | "SHUT_IN" | "PLUGGED" | "INACTIVE" | "UNKNOWN" {
  const t = s.trim().toUpperCase();
  if (!t) return "UNKNOWN";
  if (/(PLUG|P&A|ABANDON)/.test(t)) return "PLUGGED";
  if (/(SHUT|SI)/.test(t)) return "SHUT_IN";
  if (/(INACT|IDLE|TA\b)/.test(t)) return "INACTIVE";
  if (/(PRODUC|ACTIVE|FLOW)/.test(t)) return "PRODUCING";
  return "UNKNOWN";
}
function classifyTrajectory(s: string): "HORIZONTAL" | "VERTICAL" | "DIRECTIONAL" | "UNKNOWN" {
  const t = s.trim().toUpperCase();
  if (t.startsWith("H")) return "HORIZONTAL";
  if (t.startsWith("V")) return "VERTICAL";
  if (t.startsWith("D")) return "DIRECTIONAL";
  return "UNKNOWN";
}

/** Live lease-allocated production (same allocation as routes/wells.ts rrcVolumesByWell). SELECT only. */
async function rrcVolumes(db: Db, wells: RrcWellRow[]): Promise<Map<number, MonthVolumes[]>> {
  const out = new Map<number, MonthVolumes[]>();
  const leases = new Map<string, { og: string; district: string; leaseNo: string }>();
  const key = (og: string, d: string, l: string) => `${og}|${d}|${l}`;
  for (const w of wells) {
    if (!w.lease_no || !w.district) continue;
    const og = w.oil_gas === "Gas" ? "G" : "O";
    leases.set(key(og, w.district, w.lease_no), { og, district: w.district, leaseNo: w.lease_no });
  }
  if (!leases.size) return out;
  const list = [...leases.values()];
  const [prodRows, siblingRows] = await Promise.all([
    db.$queryRawUnsafe<{ og: string; district: string; lease_no: string; ym: number; oil: number; gas: number }[]>(
      `SELECT og_code AS og, district, lease_no, cycle_ym AS ym,
              sum(oil_bbl + cond_bbl)::float AS oil, sum(gas_mcf + csgd_mcf)::float AS gas
         FROM rrc.production
        WHERE (og_code, district, lease_no) IN (${list.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(",")})
        GROUP BY og_code, district, lease_no, cycle_ym ORDER BY cycle_ym`,
      ...list.flatMap((l) => [l.og, l.district, l.leaseNo]),
    ),
    db.$queryRawUnsafe<{ district: string; lease_no: string; oil_gas: string; n: bigint }[]>(
      `SELECT district, lease_no, oil_gas, count(*)::bigint AS n FROM rrc.wells
        WHERE (district, lease_no) IN (${list.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(",")})
        GROUP BY district, lease_no, oil_gas`,
      ...list.flatMap((l) => [l.district, l.leaseNo]),
    ),
  ]);
  const share = new Map<string, number>();
  for (const l of list) {
    const sib = siblingRows.find((s) => s.district === l.district && s.lease_no === l.leaseNo && (s.oil_gas === "Gas") === (l.og === "G"));
    share.set(key(l.og, l.district, l.leaseNo), l.og === "G" ? 1 : Math.max(1, Number(sib?.n ?? 1n)));
  }
  const byLease = new Map<string, MonthVolumes[]>();
  for (const r of prodRows) {
    const k = key(r.og, r.district, r.lease_no);
    const s = share.get(k) ?? 1;
    const month = `${Math.floor(r.ym / 100)}-${String(r.ym % 100).padStart(2, "0")}`;
    (byLease.get(k) ?? byLease.set(k, []).get(k)!).push({ month, oilBbl: r.oil / s, gasMcf: r.gas / s, nglBbl: 0, waterBbl: 0 });
  }
  for (const w of wells) {
    if (!w.lease_no || !w.district) continue;
    out.set(w.fid, byLease.get(key(w.oil_gas === "Gas" ? "G" : "O", w.district, w.lease_no)) ?? []);
  }
  return out;
}

const WELL_COUNTY_ORDER = ["Leon", "Karnes", "Martin", "Robertson", "Reeves", "Grimes", "Gonzales", "Midland", "Freestone", "Howard", "Upton", "La Salle", "Dimmit", "Brazos", "Madison", "Houston", "Anderson"];
const WELL_TARGET = 12;

async function loadWells(db: Db, clock: Clock, rng: Rng, log: (m: string) => void): Promise<SourceWell[]> {
  const out: SourceWell[] = [];
  const hasWells = await regclassExists(db, "rrc.wells");
  const hasProd = hasWells && (await regclassExists(db, "rrc.production"));
  if (hasWells && hasProd) {
    const seen = new Set<string>();
    for (const county of WELL_COUNTY_ORDER) {
      if (out.length >= WELL_TARGET) break;
      // SELECT only: producing horizontals with an API and reported production.
      const rows = await db.$queryRawUnsafe<RrcWellRow[]>(
        `WITH c AS (
           SELECT fid, api8, api10, well_no, lease_no, lease_name, operator, county, district, oil_gas,
                  type, status, field_name, formations, spud_date, abstract, survey,
                  ST_X(geom) AS lon, ST_Y(geom) AS lat
             FROM rrc.wells
            WHERE upper(county) = upper($1) AND lease_no IS NOT NULL AND district IS NOT NULL
              AND coalesce(api10, api8) IS NOT NULL
              AND (coalesce(type, '') ~* 'HORIZ' OR coalesce(well_no, '') ~* '[0-9]H$')
            ORDER BY spud_date DESC NULLS LAST, fid
            LIMIT 60)
         SELECT c.* FROM c
          WHERE EXISTS (SELECT 1 FROM rrc.production p
                         WHERE p.lease_no = c.lease_no AND p.district = c.district
                           AND p.og_code = CASE WHEN c.oil_gas = 'Gas' THEN 'G' ELSE 'O' END)
          ORDER BY (CASE WHEN coalesce(c.status, '') ~* 'PRODUC|ACTIVE|FLOW' THEN 0 ELSE 1 END), c.spud_date DESC NULLS LAST, c.fid
          LIMIT 3`, county);
      const fresh = rows.filter((w) => { const api = w.api10 ?? w.api8 ?? ""; if (!api || seen.has(api)) return false; seen.add(api); return true; });
      if (!fresh.length) continue;
      const vols = await rrcVolumes(db, fresh);
      for (const w of fresh.slice(0, WELL_TARGET - out.length)) {
        const v = vols.get(w.fid) ?? [];
        if (!v.length) continue;
        const api = w.api10 ?? w.api8;
        const first = v.map((x) => x.month).sort()[0];
        out.push({
          county, group: county, manual: false, volumes: v,
          row: {
            apiNumber: api,
            name: `${w.lease_name ?? "WELL"}${w.well_no ? ` #${w.well_no}` : ""}`.toUpperCase(),
            operator: w.operator,
            leaseName: w.lease_name,
            fieldName: w.field_name,
            formation: w.formations?.[0] ?? null,
            state: "TX",
            county: w.county,
            status: classifyWellStatus(w.status ?? ""),
            trajectory: classifyTrajectory(/HORIZ|\dH\b/i.test(`${w.type ?? ""} ${w.well_no ?? ""}`) ? "H" : ""),
            wellType: w.oil_gas ?? w.type,
            spudDate: w.spud_date,
            firstProdDate: first ? ymToDate(first) : null,
            abstractId: w.abstract,
            survey: w.survey,
            latitude: w.lat,
            longitude: w.lon,
            source: "rrc",
            sourceRef: String(w.fid),
          },
        });
      }
    }
    log(`Well Analysis: ${out.length} real RRC wells selected`);
  } else {
    log("Well Analysis: rrc.wells/rrc.production absent — using the curated fallback wells (source manual)");
  }
  // Fill the remainder with curated wells + synthetic decline-curve production.
  const lastYm = ym(new Date(Date.UTC(clock.now.getUTCFullYear(), clock.now.getUTCMonth() - 2, 1)));
  for (const fw of FALLBACK_WELLS) {
    if (out.length >= WELL_TARGET) break;
    out.push(fallbackWell(fw, lastYm, rng));
  }
  return out;
}

function fallbackWell(fw: FallbackWell, lastYm: string, rng: Rng): SourceWell {
  const months = Math.max(1, monthDiff(fw.firstProd, lastYm) + 1);
  const di = fw.diAnnual / 12;
  const volumes: MonthVolumes[] = [];
  for (let t = 0; t < months; t++) {
    const decline = Math.pow(1 + fw.b * di * t, -1 / fw.b);
    const ramp = t === 0 ? 0.55 : 1; // partial first month
    const down = rng.chance(0.06) ? rng.float(0.45, 0.8) : 1; // occasional downtime
    const n = rng.float(0.93, 1.07) * ramp * down;
    const oil = fw.qiOil * decline * n;
    const gas = fw.qiGas * decline * n;
    volumes.push({
      month: addMonthsYm(fw.firstProd, t),
      oilBbl: Math.round(oil),
      gasMcf: Math.round(gas),
      nglBbl: fw.county === "Martin" || fw.county === "Reeves" ? Math.round(gas * 0.11) : 0,
      waterBbl: Math.round(oil * (fw.county === "Reeves" ? 3.2 : fw.county === "Martin" ? 2.1 : 1.1) + gas * 0.004),
    });
  }
  return {
    county: fw.county, group: fw.lease.split(" ")[0] === "BLK" ? "BLK 34" : fw.county === "Karnes" ? "KARNES" : fw.lease, manual: true, volumes,
    row: {
      apiNumber: fw.api,
      name: fw.name,
      operator: fw.operator,
      leaseName: fw.lease,
      fieldName: fw.field,
      formation: fw.formation,
      state: "TX",
      county: fw.county,
      status: "PRODUCING",
      trajectory: fw.trajectory,
      wellType: fw.wellType,
      spudDate: ymToDate(addMonthsYm(fw.firstProd, -4)),
      firstProdDate: ymToDate(fw.firstProd),
      latitude: fw.lat,
      longitude: fw.lon,
      source: "manual",
      sourceRef: null,
    },
  };
}

// ===========================================================================
// Plan: the whole dataset, built in memory with explicit ids
// ===========================================================================

interface UserRef { id: string; key: string; name: string; email: string; phone: string; title: string; member: TeamMember }
interface BuyerRef { id: string; spec: BuyerSpec; name: string; contactName: string; email: string; createdAt: Date }
interface ContactRef { id: string; firstName: string; lastName: string; entityName: string | null; sellerType: "INDIVIDUAL" | "TRUST" | "ESTATE" | "LLC"; phone: string; email: string | null; preferredContact: string; street: string; city: string; state: string; zip: string; county: string; ownerKey: string }

interface DealRef {
  id: string; name: string; county: CountyInfo; region: Region; stage: string; ownerKey: string;
  ourPrice: number; askPrice: number; nma: number; dateUnderContract: Date; originalClosingDate: Date;
  stageTimes: Record<string, Date>; published: boolean; sellerContact: ContactRef | null; recordType: "OPPORTUNITY" | "OWNED_ASSET";
  daysToClose: number; buyerIds: string[]; abstract: GeoAbstract; interestLabel: string;
}

interface Plan {
  users: UserRef[];
  oppPipelineId: string;
  buyers: Prisma.BuyerCreateManyInput[];
  buyBoxes: Prisma.BuyBoxCriteriaCreateManyInput[];
  buyerOwners: Prisma.BuyerOwnerCreateManyInput[];
  buyerTags: Prisma.BuyerTagCreateManyInput[];
  buyerTagLinks: Prisma.BuyerTagOnBuyerCreateManyInput[];
  contacts: Prisma.ContactCreateManyInput[];
  contactLists: { id: string; name: string; memberIds: string[] }[];
  contactActivities: Prisma.ContactActivityCreateManyInput[];
  wells: Prisma.ResearchWellCreateManyInput[];
  production: Prisma.WellProductionMonthCreateManyInput[];
  analyses: Prisma.WellAnalysisCreateManyInput[];
  deals: (Prisma.DealUncheckedCreateInput & { id: string })[];
  dealSelections: { id: string; selectedOfferId: string; selectedBuyerId: string }[];
  sellers: Prisma.DealSellerCreateManyInput[];
  stageHistory: Prisma.DealStageHistoryCreateManyInput[];
  buyerActivities: Prisma.DealBuyerActivityCreateManyInput[];
  messages: Prisma.DealBuyerMessageCreateManyInput[];
  offers: Prisma.OfferCreateManyInput[];
  extensions: Prisma.DealContractExtensionCreateManyInput[];
  revenue: Prisma.AssetRevenueEntryCreateManyInput[];
  opportunities: Prisma.OpportunityCreateManyInput[];
  oppHistory: Prisma.OpportunityStageHistoryCreateManyInput[];
  oppActivities: Prisma.OpportunityActivityCreateManyInput[];
  portalContacts: Prisma.PortalContactCreateManyInput[];
  portalEvents: Prisma.PortalEventCreateManyInput[];
  expenseCategories: Prisma.ExpenseCategoryCreateManyInput[];
  expenses: Prisma.ExpenseCreateManyInput[];
  calendarTypes: Prisma.CalendarEventTypeCreateManyInput[];
  calendarEvents: Prisma.CalendarEventCreateManyInput[];
  emailTemplates: Prisma.EmailTemplateCreateManyInput[];
  files: { row: Prisma.FileAttachmentCreateManyInput; body: Buffer }[];
  notifications: Prisma.NotificationCreateManyInput[];
  activityLogs: Prisma.ActivityLogCreateManyInput[];
}

const ACQ_KEYS = ["owner", "elena", "travis", "kayla"]; // people who own deals
const DEAL_STAGES = ["UNDER_CONTRACT", "PREPARING_PACKAGE", "SENT_TO_BUYERS", "NEGOTIATING", "CLOSING"];

class Planner {
  readonly p: Plan;
  readonly users = new Map<string, UserRef>();
  readonly buyers: BuyerRef[] = [];
  readonly contacts: ContactRef[] = [];
  readonly deals: DealRef[] = [];
  private usedPhones = new Set<string>();
  private usedNames = new Set<string>();
  private usedAbstracts = new Set<string>();
  readonly sourceWells: (SourceWell & { id: string })[] = [];

  constructor(
    readonly orgId: string,
    readonly rng: Rng,
    readonly clock: Clock,
    readonly geo: Map<string, CountyGeo>,
    users: UserRef[],
    readonly withFiles: boolean,
  ) {
    for (const u of users) { this.users.set(u.key, u); this.usedPhones.add(u.phone); }
    this.p = {
      users, oppPipelineId: newId(), buyers: [], buyBoxes: [], buyerOwners: [], buyerTags: [], buyerTagLinks: [],
      contacts: [], contactLists: [], contactActivities: [], wells: [], production: [], analyses: [], deals: [],
      dealSelections: [], sellers: [], stageHistory: [], buyerActivities: [], messages: [], offers: [], extensions: [],
      revenue: [], opportunities: [], oppHistory: [], oppActivities: [], portalContacts: [], portalEvents: [],
      expenseCategories: [], expenses: [], calendarTypes: [], calendarEvents: [], emailTemplates: [], files: [],
      notifications: [], activityLogs: [],
    };
  }

  u(key: string): UserRef { const u = this.users.get(key); if (!u) throw new Error(`unknown team member ${key}`); return u; }

  phone(areaCode: string): string {
    for (let n = 100; n < 200; n++) {
      const p = `${areaCode}5550${n}`;
      if (!this.usedPhones.has(p)) { this.usedPhones.add(p); return p; }
    }
    throw new Error(`ran out of fictional 555-01xx numbers for ${areaCode}`);
  }

  log(eventType: string, summary: string, at: Date, actorKey: string | null, dealId?: string | null, buyerId?: string | null): void {
    this.p.activityLogs.push({
      id: newId(), organizationId: this.orgId, eventType, summary, createdAt: this.clock.past(at),
      actorUserId: actorKey ? this.u(actorKey).id : null, dealId: dealId ?? null, buyerId: buyerId ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Buyers
  // -------------------------------------------------------------------------
  planBuyers(): void {
    const { rng, clock } = this;
    const tagIds = new Map<string, string>();
    BUYERS.forEach((b, i) => {
      const id = newId();
      const createdAt = clock.at(-(560 - i * 27 - rng.int(0, 10)), rng.int(9, 16), rng.int(0, 59));
      const email = `${b.first[0].toLowerCase()}${b.last.toLowerCase()}@${b.domain}`;
      const contactName = `${b.first} ${b.last}`;
      this.buyers.push({ id, spec: b, name: b.company, contactName, email, createdAt });
      const basins = [...new Set(b.regions.flatMap((r) => COUNTIES.filter((c) => c.region === r).flatMap((c) => c.basins)))];
      this.p.buyers.push({
        id, organizationId: this.orgId, name: b.company, companyName: b.company, normalizedCompany: normalizeCompany(b.company),
        contactFirstName: b.first, contactLastName: b.last, contactName, email, phone: this.phone(b.areaCode),
        mailingAddress: b.street, mailingCity: b.city, mailingState: b.state, mailingZip: b.zip,
        relationshipStatus: b.status, notes: b.notes, active: b.active !== false, createdAt,
        nextFollowUpDate: b.status === "HOT" && b.active !== false ? clock.day(rng.int(1, 12)) : null,
        ...(b.portalLead ? { source: "portal", portalSubmittedAt: createdAt } : {}),
      });
      this.p.buyBoxes.push({
        id: newId(), buyerId: id, states: ["TX"], counties: b.counties, basins, formations: b.formations, assetTypes: b.assetTypes,
        minAcreage: b.minNma, maxAcreage: b.maxNma, minPrice: b.minPrice, maxPrice: b.maxPrice,
      });
      const owners = [...new Set([...(b.portalLead ? ["owner"] : []), ACQ_KEYS[i % ACQ_KEYS.length], ...(i % 3 === 0 ? [ACQ_KEYS[(i + 1) % ACQ_KEYS.length]] : [])])];
      for (const k of owners) this.p.buyerOwners.push({ buyerId: id, userId: this.u(k).id });
      for (const t of b.tags) {
        if (!tagIds.has(t)) { const tid = newId(); tagIds.set(t, tid); this.p.buyerTags.push({ id: tid, organizationId: this.orgId, name: t }); }
        this.p.buyerTagLinks.push({ buyerId: id, tagId: tagIds.get(t)! });
      }
      if (b.portalLead) {
        const ownerIds = owners.map((k) => this.u(k).id);
        if (ownerIds.includes(this.u("owner").id)) {
          const interest = ["TX", ...b.counties].slice(0, 6).join(", ");
          this.p.notifications.push({
            id: newId(), organizationId: this.orgId, userId: this.u("owner").id, type: "portal_lead",
            title: `Portal lead: ${contactName} (${b.company})`,
            body: `Submitted ${createdAt.toLocaleDateString("en-US")} · Areas of interest: ${interest}`,
            link: `/buyers/${id}`, createdAt, readAt: addMs(createdAt, 3 * HOUR_MS),
          });
        }
      }
    });
  }

  matchingBuyers(region: Region): BuyerRef[] {
    return this.buyers.filter((b) => b.spec.active !== false && b.spec.regions.includes(region));
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------
  planContacts(countyOrder: CountyInfo[]): void {
    const { rng } = this;
    for (let i = 0; i < 40; i++) {
      const county = countyOrder[i % countyOrder.length];
      const firstName = FIRST_NAMES[i];
      const lastName = LAST_NAMES[(i * 7 + 3) % LAST_NAMES.length];
      const kind = i % 9 === 2 ? "TRUST" : i % 9 === 5 ? "ESTATE" : i % 9 === 7 ? "LLC" : "INDIVIDUAL";
      const entityName = kind === "TRUST" ? `${lastName} Family Trust` : kind === "ESTATE" ? `Estate of ${rng.pick(["Harold", "Ruth", "Clarence", "Edna", "Otis", "Mildred"])} ${lastName}` : kind === "LLC" ? `${lastName} Mineral Holdings, LLC` : null;
      const local = rng.chance(0.6);
      const town = local ? rng.pick(county.towns) : null;
      const distant = local ? null : rng.pick(DISTANT_TOWNS);
      const pref = rng.pick(["CALL", "CALL", "EMAIL", "TEXT", "MAIL"]);
      const emailUser = `${firstName.split(" ")[0].toLowerCase()}.${lastName.toLowerCase()}`;
      const c: ContactRef = {
        id: newId(), firstName, lastName, entityName, sellerType: kind, phone: this.phone(local ? county.areaCode : distant!.areaCode),
        email: pref === "MAIL" && rng.chance(0.5) ? null : `${emailUser}@${rng.pick(["mail", "post", "inbox"])}.demo`,
        preferredContact: pref, street: STREETS[(i * 3) % STREETS.length], city: town?.city ?? distant!.city, state: distant?.state ?? "TX",
        zip: town?.zip ?? distant!.zip, county: county.name, ownerKey: ACQ_KEYS[i % ACQ_KEYS.length],
      };
      this.contacts.push(c);
    }
    // Landmen (referral network).
    LANDMEN.forEach((l, i) => {
      this.contacts.push({
        id: newId(), firstName: l.first, lastName: l.last, entityName: l.entity, sellerType: "LLC", phone: this.phone(l.areaCode),
        email: `${l.first.toLowerCase()}@${l.entity.toLowerCase().replace(/[^a-z]/g, "")}.demo`, preferredContact: "CALL",
        street: STREETS[(i * 5 + 7) % STREETS.length], city: l.city, state: "TX", zip: l.zip,
        county: COUNTIES.find((c) => c.towns.some((t) => t.city === l.city))?.name ?? "Brazos", ownerKey: "travis",
      });
    });
  }

  /** Contact rows are written after deals/opps so type/status/dates reflect them. */
  finalizeContacts(status: Map<string, { type: string; status: string; createdAt: Date; source: string; tags: string[] }>): void {
    const { rng, clock } = this;
    this.contacts.forEach((c, i) => {
      const s = status.get(c.id) ?? (i >= 40
        ? { type: "REFERRAL", status: "ENGAGED", createdAt: clock.at(-(400 + i * 13), 10), source: "Industry contact", tags: ["Landman"] }
        : { type: "LEAD", status: "NEW", createdAt: clock.at(-rng.int(5, 90), rng.int(9, 16)), source: rng.pick(CONTACT_SOURCES), tags: ["Mailer response"] });
      this.p.contacts.push({
        id: c.id, organizationId: this.orgId, firstName: c.firstName, lastName: c.lastName, entityName: c.entityName,
        type: s.type, status: s.status, source: s.source, email: c.email, phone: c.phone, preferredContact: c.preferredContact,
        mailingStreet: c.street, mailingCity: c.city, mailingState: c.state, mailingZip: c.zip,
        states: ["TX"], counties: [c.county], tags: s.tags, ownerId: this.u(c.ownerKey).id, createdAt: s.createdAt,
        notes: i >= 40 ? "Field landman — sends us heir leads and handles courthouse runs in the area." : null,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Tracts: geography + economics for one deal/asset/opportunity
  // -------------------------------------------------------------------------
  tract(info: CountyInfo, minPrice: number) {
    const { rng } = this;
    const g = this.geo.get(info.name)!;
    const fresh = g.abstracts.filter((a) => !this.usedAbstracts.has(a.id));
    const abstract = rng.pick(fresh.length ? fresh : g.abstracts);
    this.usedAbstracts.add(abstract.id);
    const interest = rng.pick([INTERESTS[0], INTERESTS[0], INTERESTS[0], INTERESTS[1], INTERESTS[1], INTERESTS[2], INTERESTS[2], INTERESTS[3]]);
    const grossOpts = info.region === "EAST" ? [80, 100, 120, 160, 200, 320, 640] : info.region === "EAGLE_FORD" ? [40, 80, 120, 160, 320] : [80, 160, 320, 640];
    const fracOpts = info.region === "EAST" ? [1 / 2, 1 / 4, 1 / 6, 1 / 8, 1 / 12, 1 / 16] : info.region === "EAGLE_FORD" ? [1 / 4, 1 / 8, 1 / 16, 1 / 32] : [1 / 16, 1 / 32, 1 / 64, 1 / 128];
    const [lo, hi] = info.region === "EAST" ? [8, 200] : info.region === "EAGLE_FORD" ? [3, 60] : [1.5, 40];
    let gross = 160, nma = 20, cost = info.costPerNma[0];
    for (let t = 0; t < 40; t++) {
      gross = rng.pick(grossOpts);
      nma = round2(gross * rng.pick(fracOpts));
      cost = roundTo(rng.float(info.costPerNma[0], info.costPerNma[1]), 25);
      if (nma >= lo && nma <= hi && nma * cost >= minPrice) break;
    }
    const royalty = rng.pick(info.royaltyRates);
    const nra = round2((nma * fraction(royalty)) / 0.125);
    const ask = roundTo(cost * rng.float(1.3, 1.55), 25);
    const ourPrice = roundTo(nma * cost, 100);
    const askPrice = roundTo(nma * ask, 100);
    const formations = rng.shuffle(info.formations).slice(0, rng.int(1, Math.min(2, info.formations.length)));
    const operator = rng.pick(g.operators);
    let name = `${shortSurvey(abstract.survey)} ${interest.label} — ${info.name} Co.`;
    for (let n = 2; this.usedNames.has(name); n++) name = `${shortSurvey(abstract.survey)} ${interest.label} (Tract ${n}) — ${info.name} Co.`;
    this.usedNames.add(name);
    const closingCosts = Math.min(7500, roundTo(900 + ourPrice * 0.01, 50));
    return { info, abstract, interest, gross, nma, nra, royalty, cost, ask, ourPrice, askPrice, formations, operator, name, closingCosts };
  }

  dealNotes(t: ReturnType<Planner["tract"]>): string {
    return `${t.interest.label} in Abstract ${abstractNumber(t.abstract.label)}, ${t.abstract.survey}, ${t.info.name} County. ${t.nma} NMA out of a ${t.gross}-acre tract under a ${t.royalty} lease operated by ${t.operator}.`;
  }

  // -------------------------------------------------------------------------
  // Deals (acquisitions): active, closed, dead
  // -------------------------------------------------------------------------
  planDeals(countyOrder: CountyInfo[]): { converted: { deal: DealRef; contact: ContactRef }[] } {
    const { rng, clock } = this;
    type Spec = { kind: "ACTIVE" | "CLOSED" | "DEAD"; stageIdx: number; convert?: boolean; publish?: boolean; extend?: boolean; deadReason?: string; closeOffset?: number };
    const specs: Spec[] = [];
    const activeCounts = [6, 5, 6, 6, 5];
    activeCounts.forEach((n, idx) => { for (let i = 0; i < n; i++) specs.push({ kind: "ACTIVE", stageIdx: idx }); });
    // Conversions (2 Under Contract + 1 Preparing Package), publishing (3 Sent + 2 Negotiating), extensions (2 Closing).
    specs[0].convert = true; specs[1].convert = true; specs[6].convert = true;
    specs[11].publish = true; specs[12].publish = true; specs[13].publish = true; specs[17].publish = true; specs[18].publish = true;
    specs[23].extend = true; specs[24].extend = true;
    for (let i = 0; i < 16; i++) specs.push({ kind: "CLOSED", stageIdx: 5, closeOffset: -(12 + Math.round(i * 28.5) + rng.int(0, 6)) });
    DEAD_REASONS.forEach((r, i) => specs.push({ kind: "DEAD", stageIdx: [2, 1, 3, 2][i], deadReason: r }));

    const converted: { deal: DealRef; contact: ContactRef }[] = [];
    let sellerIdx = 0;
    specs.forEach((spec, n) => {
      const info = countyOrder[n % countyOrder.length];
      const minPrice = info.region === "EAST" ? 15_000 : info.region === "EAGLE_FORD" ? 40_000 : 60_000;
      const t = this.tract(info, minPrice);
      const id = newId();
      const ownerKey = spec.publish ? "owner" : spec.convert ? ACQ_KEYS[(n + 1) % ACQ_KEYS.length] : ACQ_KEYS[n % ACQ_KEYS.length];
      const owner = this.u(ownerKey);

      // ---- timeline ---------------------------------------------------------
      let startDay: number;
      let daysToClose: number;
      const stageTimes: Record<string, Date> = {};
      let stage: string;
      let closedAt: Date | null = null;
      let deadAt: Date | null = null;
      if (spec.kind === "ACTIVE") {
        const ageRange: [number, number][] = [[2, 12], [6, 18], [10, 28], [16, 40], [24, 52]];
        const age = rng.int(...ageRange[spec.stageIdx]);
        startDay = -age;
        const options = [30, 45, 60, 75, 90].filter((d) => d >= age + (spec.stageIdx === 4 ? 4 : 10));
        // Any contracted window that still fits (30–90 days), so active closings
        // spread over the next few months instead of bunching into one.
        daysToClose = spec.extend ? Math.max(30, age - 4) : options.length ? rng.pick(options) : 90;
        stage = DEAL_STAGES[spec.stageIdx];
        const start = clock.at(startDay, rng.int(8, 11), rng.int(0, 59));
        stageTimes.UNDER_CONTRACT = start;
        const span = clock.now.getTime() - 3 * HOUR_MS - start.getTime();
        const cuts = Array.from({ length: spec.stageIdx }, () => rng.float(0.12, 0.95)).sort((a, b) => a - b);
        cuts.forEach((c, i) => { stageTimes[DEAL_STAGES[i + 1]] = clock.past(addMs(start, Math.max(span * c, (i + 1) * 6 * HOUR_MS))); });
      } else if (spec.kind === "CLOSED") {
        daysToClose = rng.pick([30, 30, 45, 45, 60]);
        const closeDay = spec.closeOffset!;
        startDay = closeDay - daysToClose;
        stage = "CLOSED";
        const start = clock.at(startDay, rng.int(8, 11), rng.int(0, 59));
        stageTimes.UNDER_CONTRACT = start;
        const span = (daysToClose - 3) * DAY_MS;
        [0.08, 0.2, 0.42, 0.68].forEach((c, i) => { stageTimes[DEAL_STAGES[i + 1]] = addMs(start, span * (c + rng.float(-0.03, 0.03))); });
        closedAt = clock.at(closeDay + rng.int(0, 2), rng.int(13, 16), rng.int(0, 59));
        stageTimes.CLOSED = closedAt;
      } else {
        startDay = -rng.int(60, 300);
        daysToClose = rng.pick([30, 45, 60]);
        stage = "DEAD";
        const start = clock.at(startDay, rng.int(8, 11), rng.int(0, 59));
        stageTimes.UNDER_CONTRACT = start;
        for (let i = 1; i <= spec.stageIdx; i++) stageTimes[DEAL_STAGES[i]] = addMs(start, i * rng.float(3, 7) * DAY_MS);
        deadAt = addMs(stageTimes[DEAL_STAGES[spec.stageIdx]], rng.float(3, 12) * DAY_MS);
        stageTimes.DEAD = deadAt;
      }
      const dateUnderContract = clock.day(startDay);
      const originalClosingDate = clock.day(startDay + daysToClose);

      // ---- sellers -----------------------------------------------------------
      let sellerContact: ContactRef | null = null;
      let coOwner: ContactRef | null = null;
      if (spec.convert) {
        sellerContact = this.contacts[32 + converted.length];
      } else {
        sellerContact = this.contacts[sellerIdx % 28];
        if (sellerIdx % 5 === 3) coOwner = this.contacts[28 + (sellerIdx % 4)];
        sellerIdx++;
      }
      sellerContact.county = info.name;
      if (coOwner) coOwner.county = info.name;

      const ref: DealRef = {
        id, name: t.name, county: info, region: info.region, stage, ownerKey, ourPrice: t.ourPrice, askPrice: t.askPrice, nma: t.nma,
        dateUnderContract, originalClosingDate, stageTimes, published: !!spec.publish, sellerContact, recordType: "OPPORTUNITY",
        daysToClose, buyerIds: [], abstract: t.abstract, interestLabel: t.interest.label,
      };
      this.deals.push(ref);

      // ---- core deal row ----------------------------------------------------
      const assigneeKeys = [...new Set([ownerKey, ...(rng.chance(0.45) ? [rng.pick(ACQ_KEYS)] : []), ...(spec.stageIdx >= 4 && rng.chance(0.5) ? ["ben"] : [])])];
      const base: Prisma.DealUncheckedCreateInput & { id: string } = {
        id, organizationId: this.orgId, pipelineId: null, name: t.name, sellerNames: [], recordType: "OPPORTUNITY", assetMode: null,
        counties: [info.name], state: "TX", states: ["TX"], acreageNma: t.nma, nra: t.nra, abstractIds: [t.abstract.id],
        surveys: [t.abstract.survey], operator: t.operator, askPrice: t.askPrice, ourPrice: t.ourPrice,
        ourCostPerNma: t.cost, askPricePerNma: t.ask, daysToClose, assetTypes: [t.interest.type], basins: info.basins,
        formations: t.formations, royaltyRate: t.royalty, stage,
        currentStageEnteredAt: stageTimes[stage], deadReason: spec.deadReason ?? null,
        dateUnderContract, originalClosingDate, closedDate: closedAt ? clock.dayOf(closedAt) : null,
        relationshipOwnerId: owner.id, estimatedClosingCosts: t.closingCosts, notes: this.dealNotes(t),
        createdAt: stageTimes.UNDER_CONTRACT,
        assignees: { connect: assigneeKeys.map((k) => ({ id: this.u(k).id })) },
      };
      if (spec.convert) {
        const opp = this.opportunityFromDeal(ref, t, sellerContact);
        const f = convertedDealFields(opp.input, owner.id);
        Object.assign(base, f);
        base.notes = f.notes;
        const seller = convertedSeller(opp.input, opp.contact);
        if (seller) this.p.sellers.push({ id: newId(), dealId: id, ...seller, createdAt: stageTimes.UNDER_CONTRACT });
        converted.push({ deal: ref, contact: sellerContact });
      } else {
        for (const [c, pct, primary] of [[sellerContact, coOwner ? 50 : null, true], ...(coOwner ? [[coOwner, 50, false]] : [])] as [ContactRef, number | null, boolean][]) {
          this.p.sellers.push(this.sellerFromContact(id, c, primary, pct, ownerKey, stageTimes.UNDER_CONTRACT));
        }
      }
      if (spec.publish) {
        Object.assign(base, {
          publishedToPortal: true, portalSlug: crypto.randomBytes(12).toString("base64url"),
          portalVisibility: n === 13 ? "LINK_ONLY" : "PUBLIC", portalFeatured: n === 11 || n === 17,
          portalSummary: PORTAL_SUMMARIES[[11, 12, 13, 17, 18].indexOf(n)] ?? PORTAL_SUMMARIES[0],
          portalContacts: [{ id: "c0", name: owner.name, title: owner.title, email: owner.email, phone: owner.phone }] as Prisma.InputJsonValue,
          portalContactName: owner.name, portalContactTitle: owner.title, portalContactEmail: owner.email, portalContactPhone: owner.phone,
        });
      }
      if (spec.stageIdx >= 4 && spec.kind === "ACTIVE") {
        base.buyerClosingDate = clock.day(Math.max(2, startDay + daysToClose - rng.int(1, 4)));
      }
      if (spec.kind === "CLOSED" && rng.chance(0.7)) base.buyerClosingDate = clock.day(spec.closeOffset! - rng.int(0, 2));
      if (spec.extend) {
        // Contract timeline "Extended" once: Final Closing (Original + 15) → +15.
        const from = clock.day(startDay + daysToClose + 15);
        const to = clock.day(startDay + daysToClose + 30);
        base.finalClosingDateOverride = to;
        const at = clock.at(-rng.int(1, 3), rng.int(9, 15));
        this.p.extensions.push({ id: newId(), dealId: id, fromDate: from, toDate: to, days: 15, extendedByUserId: owner.id, createdAt: at });
        this.log("CLOSING_EXTENDED", `${owner.name} extended the closing on "${t.name}" to ${formatCalendarDay(to)} (+15 days)`, at, ownerKey, id);
      }
      this.p.deals.push(base);

      // ---- stage history + logs ---------------------------------------------
      if (!spec.convert) this.log("DEAL_CREATED", `${owner.name} created deal "${t.name}"`, stageTimes.UNDER_CONTRACT, ownerKey, id);
      const path = [...DEAL_STAGES.filter((s) => stageTimes[s]), ...(stage === "CLOSED" || stage === "DEAD" ? [stage] : [])];
      let prev: string | null = null;
      for (const s of path) {
        const at = stageTimes[s];
        this.p.stageHistory.push({ id: newId(), dealId: id, fromStage: prev, toStage: s, changedByUserId: owner.id, deadReason: s === "DEAD" ? spec.deadReason! : null, createdAt: at });
        if (prev && s !== "CLOSING") {
          this.log("STAGE_CHANGE", `${owner.name} moved "${t.name}" to ${prettyStage(s)}${s === "DEAD" ? ` (${spec.deadReason})` : ""}`, at, ownerKey, id);
        }
        prev = s;
      }
      // ---- marketing ----------------------------------------------------------
      this.marketDeal(ref, spec.kind, spec.stageIdx);
    });
    return { converted };
  }

  sellerFromContact(dealId: string, c: ContactRef, primary: boolean, pct: number | null, assignee: string, at: Date): Prisma.DealSellerCreateManyInput {
    return {
      id: newId(), dealId, isPrimary: primary, ownershipPercent: pct, firstName: c.firstName, lastName: c.lastName,
      companyName: c.sellerType === "LLC" ? c.entityName : null, trustName: c.sellerType === "TRUST" || c.sellerType === "ESTATE" ? c.entityName : null,
      sellerType: c.sellerType, primaryPhone: c.phone, email: c.email,
      preferredContactMethod: { CALL: "Phone", TEXT: "Text", EMAIL: "Email", MAIL: "Mail" }[c.preferredContact] ?? null,
      mailingAddress: c.street, mailingCity: c.city, mailingState: c.state, mailingZip: c.zip,
      assignedTeamMemberId: this.u(assignee).id, createdAt: at,
      internalNotes: c.sellerType === "ESTATE" ? "Executor signs for the estate; letters testamentary on file." : c.sellerType === "TRUST" ? "Trustee signs; trust certificate received." : null,
    };
  }

  /** Buyer outreach, offers, acceptance and closing for one deal. */
  marketDeal(d: DealRef, kind: "ACTIVE" | "CLOSED" | "DEAD" | "ASSET", stageIdx: number): void {
    const { rng, clock } = this;
    const sentAt = d.stageTimes.SENT_TO_BUYERS;
    if (!sentAt) return;
    const owner = this.u(d.ownerKey);
    const matches = rng.shuffle(this.matchingBuyers(d.region));
    const others = rng.shuffle(this.buyers.filter((b) => b.spec.active !== false && !matches.includes(b)));
    const chosen = [...matches, ...others].slice(0, rng.int(4, 7));
    d.buyerIds = chosen.map((b) => b.id);
    const closingStage = kind === "CLOSED" || (kind === "ACTIVE" && stageIdx === 4);
    const negotiating = kind === "ACTIVE" && stageIdx === 3;
    const terminal = kind === "CLOSED" || kind === "DEAD";
    const threadId = `deal-${d.id}-${sentAt.getTime()}`;
    const acceptAt = d.stageTimes.CLOSING;
    const negAt = d.stageTimes.NEGOTIATING;
    const offerConds = ["Subject to satisfactory title review", "Closing within 30 days of acceptance", "Subject to receipt of division orders and recent check stubs", "Cash; no financing contingency"];
    const offerAmt = (lo: number, hi: number) => { const x = Math.min(d.ourPrice * rng.float(lo, hi), d.askPrice * 0.98); return roundTo(x, x < 50_000 ? 250 : 1000); };

    this.log("DEAL_EMAILED", `${owner.name} emailed "${d.name}" to ${chosen.length} buyer(s)`, sentAt, d.ownerKey, d.id);
    const offererCount = closingStage ? 1 + rng.int(1, 2) : negotiating ? rng.int(1, 3) : 0;
    chosen.forEach((b, i) => {
      const actId = newId();
      const dateSent = addMs(sentAt, i * 4 * 60_000);
      let last = dateSent;
      const msg = (k: Prisma.DealBuyerMessageCreateManyInput["kind"], at: Date, subject: string | null, body: string, byKey: string | null = d.ownerKey, thread: string | null = null) => {
        const when = clock.past(at);
        if (when > last) last = when;
        this.p.messages.push({ id: newId(), organizationId: this.orgId, dealId: d.id, buyerId: b.id, activityId: actId, kind: k, subject, body, occurredAt: when, createdAt: when, createdByUserId: byKey ? this.u(byKey).id : null, threadId: thread });
      };
      msg("EMAIL_OUT", dateSent, `New acquisition package: ${d.name} (${d.county.name} County)`, `Hi ${b.spec.first},\n\nWe just put ${d.name} under contract and wanted ${b.name} to have an early look. Package attached: PSA summary, plat and title run sheet.\n\nAsking ${money(d.askPrice)}.\n\nThanks,\n${owner.name}`, d.ownerKey, threadId);

      let status: Prisma.DealBuyerActivityCreateManyInput["status"] = "CONTACTED";
      let offerAmount: number | null = null;
      let follow: Date | null = null;
      const isOfferer = i < offererCount;
      const replyAt = addMs(dateSent, rng.float(0.6, 3) * DAY_MS);
      if (closingStage && i === 0) {
        // Winner: offer → accepted (moves deal to Closing) → closed.
        const amt = offerAmt(1.16, 1.42);
        const offerId = newId();
        const submitted = clock.past(addMs(acceptAt, -rng.float(1, 4) * DAY_MS));
        this.p.offers.push({ id: offerId, dealId: d.id, buyerId: b.id, amount: amt, dateSubmitted: submitted, createdAt: submitted, conditions: rng.pick(offerConds), expirationDate: clock.dayOf(addMs(submitted, 10 * DAY_MS)), status: "ACCEPTED" });
        this.log("OFFER_MADE", `${b.name} made an offer of $${amt.toLocaleString("en-US")} on "${d.name}"`, submitted, d.ownerKey, d.id, b.id);
        msg("EMAIL_IN", replyAt < submitted ? replyAt : addMs(submitted, -HOUR_MS), `RE: ${d.name}`, `${owner.name.split(" ")[0]}, we like this one. Reviewing title now — expect a number from us shortly.\n\n${b.contactName}`, null, threadId);
        msg("NEGOTIATION", addMs(submitted, 2 * HOUR_MS), null, `Offer of ${money(amt)} received from ${b.contactName}. Countered on closing timeline; buyer agreed to fund within ${d.daysToClose >= 45 ? 30 : 21} days.`);
        msg("STATUS_CHANGE", acceptAt, null, "Status set to ACCEPTED (offer accepted)");
        this.log("OFFER_ACCEPTED", `${owner.name} accepted an offer on "${d.name}" — moved to Closing${d.published ? " and unpublished the offering" : ""}`, acceptAt, d.ownerKey, d.id, b.id);
        this.p.dealSelections.push({ id: d.id, selectedOfferId: offerId, selectedBuyerId: b.id });
        offerAmount = amt;
        status = kind === "CLOSED" ? "CLOSED" : "ACCEPTED";
        if (kind === "CLOSED") msg("STATUS_CHANGE", d.stageTimes.CLOSED, null, "Status automatically set to Closed — this buyer's accepted offer closed the deal.");
      } else if (closingStage && isOfferer) {
        const amt = offerAmt(0.95, 1.12);
        const submitted = clock.past(addMs(acceptAt, -rng.float(2, 6) * DAY_MS));
        this.p.offers.push({ id: newId(), dealId: d.id, buyerId: b.id, amount: amt, dateSubmitted: submitted, createdAt: submitted, conditions: rng.pick(offerConds), expirationDate: clock.dayOf(addMs(submitted, 7 * DAY_MS)), status: "REJECTED", notes: "Outbid — accepted a higher offer." });
        this.log("OFFER_MADE", `${b.name} made an offer of $${amt.toLocaleString("en-US")} on "${d.name}"`, submitted, d.ownerKey, d.id, b.id);
        msg("PHONE", addMs(acceptAt, 3 * HOUR_MS), null, `Let ${b.contactName} know we went with a higher offer. They want to see the next ${d.county.name} County package.`);
        offerAmount = amt;
        status = "PASSED";
      } else if (negotiating && isOfferer) {
        const amt = offerAmt(1.05, 1.32);
        const submitted = clock.past(addMs(negAt, -rng.float(0, 1.5) * DAY_MS + i * 5 * HOUR_MS));
        const fromPortal = d.published && i === 0;
        if (i === 0 && !fromPortal && rng.chance(0.6)) {
          // A counter chain: the first number was countered, the revised offer is live.
          const firstId = newId();
          const firstAmt = roundTo(amt * 0.9, amt < 50_000 ? 250 : 1000);
          const firstAt = addMs(submitted, -2 * DAY_MS);
          this.p.offers.push({ id: firstId, dealId: d.id, buyerId: b.id, amount: firstAmt, dateSubmitted: firstAt, createdAt: firstAt, conditions: rng.pick(offerConds), expirationDate: clock.dayOf(addMs(firstAt, 7 * DAY_MS)), status: "COUNTERED" });
          this.log("OFFER_MADE", `${b.name} made an offer of $${firstAmt.toLocaleString("en-US")} on "${d.name}"`, firstAt, d.ownerKey, d.id, b.id);
          msg("NEGOTIATION", addMs(firstAt, 4 * HOUR_MS), null, `Countered ${b.name} at ${money(roundTo(d.askPrice * 0.96, 500))}; they came back at ${money(amt)}.`);
          this.p.offers.push({ id: newId(), dealId: d.id, buyerId: b.id, amount: amt, dateSubmitted: submitted, createdAt: submitted, conditions: rng.pick(offerConds), expirationDate: clock.dayOf(addMs(submitted, 10 * DAY_MS)), status: "ACTIVE", parentOfferId: firstId });
          this.log("OFFER_MADE", `${b.name} revised their offer to $${amt.toLocaleString("en-US")} on "${d.name}"`, submitted, d.ownerKey, d.id, b.id);
          status = "NEGOTIATING";
        } else {
          this.p.offers.push({
            id: newId(), dealId: d.id, buyerId: b.id, amount: amt, dateSubmitted: submitted, createdAt: submitted, conditions: rng.pick(offerConds), expirationDate: clock.dayOf(addMs(submitted, 10 * DAY_MS)), status: "ACTIVE",
            ...(fromPortal ? { notes: `Submitted via buyer portal on ${submitted.toLocaleDateString("en-US")}.\n\nSubmitter (unverified): ${b.contactName} · ${b.name} · ${b.email}` } : {}),
          });
          this.log("OFFER_MADE", `${b.name} made an offer of $${amt.toLocaleString("en-US")} on "${d.name}"`, submitted, d.ownerKey, d.id, b.id);
          if (fromPortal) {
            this.p.notifications.push({
              id: newId(), organizationId: this.orgId, userId: owner.id, type: "portal_offer",
              title: `Portal offer: ${b.name} on "${d.name}"`, body: `$${Math.round(amt).toLocaleString("en-US")} offer from ${b.contactName}`,
              link: `/deals/${d.id}`, createdAt: submitted,
            });
          }
          status = "OFFER_RECEIVED";
        }
        msg("EMAIL_IN", clock.past(addMs(submitted, -3 * HOUR_MS)), `RE: ${d.name}`, `Please see our offer of ${money(amt)} attached. Happy to discuss terms.\n\n${b.contactName}\n${b.name}`, null, threadId);
        offerAmount = amt;
        follow = clock.day(rng.int(1, 4));
      } else {
        // Everyone else: interest levels by position.
        const pool: Prisma.DealBuyerActivityCreateManyInput["status"][] = kind === "DEAD" ? ["CONTACTED", "PASSED", "NO_RESPONSE", "INTERESTED"]
          : closingStage ? ["PASSED", "NO_RESPONSE", "PASSED", "CONTACTED"]
            : ["INTERESTED", "REVIEWING", "CONTACTED", "NO_RESPONSE", "PASSED", "INTERESTED", "CONTACTED"];
        status = pool[i % pool.length];
        if (status === "INTERESTED" || status === "REVIEWING") {
          msg("EMAIL_IN", replyAt, `RE: ${d.name}`, status === "REVIEWING" ? `Thanks — our engineer is running the decline on the unit now. Can you send the division order?\n\n${b.contactName}` : `Interested. What's the lease date and is there a Pugh clause?\n\n${b.contactName}`, null, threadId);
          if (!terminal) follow = clock.day(rng.int(1, 7));
        } else if (status === "PASSED") {
          msg("EMAIL_IN", replyAt, `RE: ${d.name}`, rng.pick(["We'll pass on this one — outside our current buy box.", "Pass for now; price is ahead of where we are on that area.", "Not a fit for the fund right now, thanks for thinking of us."]), null, threadId);
        } else if (status === "CONTACTED" && rng.chance(0.4) && !terminal) {
          msg("PHONE", addMs(dateSent, 2 * DAY_MS), null, `Left a voicemail for ${b.contactName} about the package.`);
          follow = clock.day(rng.int(2, 6));
        }
      }
      this.p.buyerActivities.push({
        id: actId, dealId: d.id, buyerId: b.id, dateSent, status, offerAmount,
        responseReceived: status !== "CONTACTED" && status !== "NO_RESPONSE",
        lastActivityDate: last, nextFollowUpDate: terminal ? null : follow,
        notes: status === "PASSED" && isOfferer ? "Outbid." : null,
        sentByUserId: owner.id, assignedTeamMemberId: owner.id, createdAt: dateSent,
      });
      if (status === "INTERESTED" && !terminal && rng.chance(0.3)) {
        this.log("CONTACT_LOGGED", `${owner.name} logged contact with ${b.name} on "${d.name}"`, addMs(replyAt, 2 * HOUR_MS), d.ownerKey, d.id, b.id);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Opportunities (prospects pipeline)
  // -------------------------------------------------------------------------
  opportunityFromDeal(d: DealRef, t: ReturnType<Planner["tract"]>, contact: ContactRef) {
    const { rng } = this;
    const oppId = newId();
    const convertAt = d.stageTimes.UNDER_CONTRACT;
    const owner = this.u(d.ownerKey);
    const input: ConvertibleOpportunity = {
      name: d.name, ownerId: owner.id, sellerName: `${contact.firstName} ${contact.lastName}`, companyName: contact.entityName,
      phone: contact.phone, email: contact.email, state: "TX", county: d.county.name, abstract: t.abstract.id, survey: t.abstract.survey,
      estAcres: t.gross, estNma: t.nma, estNra: t.nra, source: rng.pick(CONTACT_SOURCES), notes: rng.pick(OPPORTUNITY_NOTES),
    };
    const contactIn: ConvertibleContact = {
      firstName: contact.firstName, lastName: contact.lastName, entityName: contact.entityName, phone: contact.phone, email: contact.email,
      preferredContact: contact.preferredContact, mailingStreet: contact.street, mailingCity: contact.city, mailingState: contact.state, mailingZip: contact.zip,
    };
    const created = addMs(convertAt, -rng.float(20, 40) * DAY_MS);
    const stages = ["NEW_OPPORTUNITY", "RESEARCHING", "CONTACTED", "INTERESTED", "NEGOTIATING"];
    const times = stages.map((_, i) => addMs(created, (i / stages.length) * (convertAt.getTime() - created.getTime()) * rng.float(0.9, 1)));
    this.p.opportunities.push({
      id: oppId, organizationId: this.orgId, name: input.name, pipelineId: this.p.oppPipelineId, stage: "NEGOTIATING",
      currentStageEnteredAt: times[4], ownerId: owner.id, contactId: contact.id, sellerName: input.sellerName, companyName: input.companyName,
      phone: input.phone, email: input.email, state: "TX", county: input.county, abstract: input.abstract, survey: input.survey,
      estAcres: input.estAcres, estNma: input.estNma, estNra: input.estNra, source: input.source, notes: input.notes,
      lastActivityAt: convertAt, convertedDealId: d.id, convertedAt: convertAt, createdByUserId: owner.id, createdAt: created,
    });
    this.oppTrail(oppId, stages, times, d.ownerKey, null);
    this.p.oppActivities.push({ id: newId(), opportunityId: oppId, kind: "CALL", body: `Talked with ${contact.firstName} — open to an offer around ${money(d.ourPrice)}.`, createdByUserId: owner.id, createdAt: addMs(times[2], 2 * HOUR_MS) });
    this.p.oppActivities.push({ id: newId(), opportunityId: oppId, kind: "MEETING", body: "Met at the kitchen table to walk through the PSA. Agreed on price; sending the contract.", createdByUserId: owner.id, createdAt: addMs(times[4], 4 * HOUR_MS) });
    this.p.oppActivities.push({ id: newId(), opportunityId: oppId, kind: "SYSTEM", body: `Converted to deal ${d.name}`, createdByUserId: owner.id, createdAt: convertAt });
    this.log("DEAL_CREATED", `${owner.name} created deal "${d.name}"`, convertAt, d.ownerKey, d.id);
    this.log("OPPORTUNITY_CONVERTED", `${owner.name} converted opportunity "${d.name}" into a deal`, addMs(convertAt, 1000), d.ownerKey, d.id);
    return { input, contact: contactIn };
  }

  oppTrail(oppId: string, stages: string[], times: Date[], ownerKey: string, reason: string | null): void {
    let prev = "";
    stages.forEach((s, i) => {
      this.p.oppHistory.push({ id: newId(), opportunityId: oppId, fromStage: prev, toStage: s, reason: i === stages.length - 1 ? reason : null, changedByUserId: this.u(ownerKey).id, createdAt: times[i] });
      prev = s;
    });
  }

  planOpportunities(countyOrder: CountyInfo[], contactStatus: Map<string, { type: string; status: string; createdAt: Date; source: string; tags: string[] }>): void {
    const { rng, clock } = this;
    const open = ["NEW_OPPORTUNITY", "RESEARCHING", "CONTACTED", "INTERESTED", "NEGOTIATING"];
    const ageFor: Record<string, [number, number]> = { NEW_OPPORTUNITY: [1, 6], RESEARCHING: [5, 15], CONTACTED: [8, 25], INTERESTED: [12, 35], NEGOTIATING: [18, 45], PASSED: [20, 60], LOST: [25, 70] };
    let contactCursor = 35; // 32–34 are the converted opportunities' sellers
    OPPORTUNITY_PLAN.filter((o) => !o.convert).forEach((plan, i) => {
      const info = countyOrder[(i * 5 + 2) % countyOrder.length];
      const t = this.tract(info, 0);
      const ownerKey = ACQ_KEYS[(i + 2) % ACQ_KEYS.length];
      const owner = this.u(ownerKey);
      const id = newId();
      const age = rng.int(...ageFor[plan.stage]);
      const created = clock.at(-age, rng.int(8, 15), rng.int(0, 59));
      const terminal = plan.stage === "PASSED" || plan.stage === "LOST";
      const reachIdx = terminal ? rng.int(1, 3) : open.indexOf(plan.stage);
      const stages = [...open.slice(0, reachIdx + 1), ...(terminal ? [plan.stage] : [])];
      const span = clock.now.getTime() - 4 * HOUR_MS - created.getTime();
      const times = stages.map((_, k) => (k === 0 ? created : clock.past(addMs(created, (span * k) / stages.length))));
      const c = contactCursor < 40 ? this.contacts[contactCursor++] : null;
      const plainName = `${FIRST_NAMES[(i * 3 + 11) % FIRST_NAMES.length]} ${LAST_NAMES[(i * 11 + 5) % LAST_NAMES.length]}`;
      const source = rng.pick(CONTACT_SOURCES);
      if (c) {
        c.county = info.name;
        const cs = { NEW_OPPORTUNITY: "NEW", RESEARCHING: "NEW", CONTACTED: "CONTACTED", INTERESTED: "ENGAGED", NEGOTIATING: "NEGOTIATING", PASSED: "NOT_INTERESTED", LOST: "NOT_INTERESTED" }[plan.stage] ?? "NEW";
        contactStatus.set(c.id, { type: plan.stage === "NEW_OPPORTUNITY" ? "LEAD" : "PROSPECT", status: cs, createdAt: addMs(created, -rng.float(0.5, 3) * DAY_MS), source, tags: source.startsWith("Direct mail") ? ["Mailer response"] : [] });
      }
      this.p.opportunities.push({
        id, organizationId: this.orgId, name: t.name, pipelineId: this.p.oppPipelineId, stage: plan.stage,
        currentStageEnteredAt: times[times.length - 1], ownerId: owner.id, contactId: c?.id ?? null,
        sellerName: c ? `${c.firstName} ${c.lastName}` : plainName, companyName: c?.entityName ?? null,
        phone: c?.phone ?? this.phone(info.areaCode), email: c?.email ?? null, state: "TX", county: info.name,
        abstract: t.abstract.id, survey: t.abstract.survey, estAcres: t.gross, estNma: t.nma, estNra: t.nra,
        source, notes: OPPORTUNITY_NOTES[i % OPPORTUNITY_NOTES.length], closeReason: plan.reason ?? null,
        lastActivityAt: times[times.length - 1], nextFollowUpDate: terminal ? null : clock.day(rng.int(1, 10)),
        createdByUserId: owner.id, createdAt: created,
      });
      this.oppTrail(id, stages, times, ownerKey, plan.reason ?? null);
      const kinds = ["NOTE", "CALL", "EMAIL", "TEXT", "MEETING"];
      const bodies: Record<string, string[]> = {
        NOTE: ["Pulled the deed records — interest traces cleanly to the 1962 partition.", "Unit plat shows the tract inside two producing laterals.", "Ran comps: recent sales in this survey at roughly " + money(t.cost) + "/NMA."],
        CALL: ["No answer, left a voicemail.", `Spoke with ${c?.firstName ?? plainName.split(" ")[0]} — wants to talk it over with family first.`, "Owner asked for a written offer by mail."],
        EMAIL: ["Sent our one-page overview and a W-9.", "Emailed the ownership report we pulled from the county."],
        TEXT: ["Texted to confirm a call Thursday afternoon.", "Owner texted back: still interested, busy until next week."],
        MEETING: ["Met at the courthouse annex to review the probate file together."],
      };
      const nActs = Math.min(stages.length + 1, 4);
      for (let k = 0; k < nActs; k++) {
        const kind = k === 0 ? "NOTE" : rng.pick(kinds);
        this.p.oppActivities.push({ id: newId(), opportunityId: id, kind, body: rng.pick(bodies[kind]), createdByUserId: owner.id, createdAt: clock.past(addMs(created, (k + 0.5) * (span / (nActs + 1)))) });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Owned mineral assets (portfolio): HOLD + SELL, with royalty revenue
  // -------------------------------------------------------------------------
  planAssets(): void {
    const { rng, clock } = this;
    // `yieldPct` = trailing-12-month royalty income as a share of the purchase price.
    const specs: { county: string; mode: "HOLD" | "SELL"; stage: string; status: string; yieldPct: number }[] = [
      { county: "Leon", mode: "HOLD", stage: "CLOSING", status: "Held by Production", yieldPct: 0.19 },
      { county: "Karnes", mode: "HOLD", stage: "CLOSING", status: "Held by Production", yieldPct: 0.16 },
      { county: "Martin", mode: "HOLD", stage: "CLOSING", status: "Held by Production", yieldPct: 0.14 },
      { county: "Robertson", mode: "HOLD", stage: "CLOSING", status: "Leased", yieldPct: 0.11 },
      { county: "Gonzales", mode: "SELL", stage: "PREPARING_PACKAGE", status: "Held by Production", yieldPct: 0.13 },
      { county: "Reeves", mode: "SELL", stage: "SENT_TO_BUYERS", status: "Held by Production", yieldPct: 0.17 },
    ];
    const lastMonth = ym(new Date(Date.UTC(clock.now.getUTCFullYear(), clock.now.getUTCMonth() - 1, 1)));
    specs.forEach((s, i) => {
      const info = COUNTIES.find((c) => c.name === s.county)!;
      const t = this.tract(info, info.region === "EAST" ? 25_000 : 60_000);
      const id = newId();
      const ownerKey = ACQ_KEYS[i % ACQ_KEYS.length];
      const owner = this.u(ownerKey);
      const acqDay = -rng.int(220, 820);
      const acquiredAt = clock.at(acqDay, 10, rng.int(0, 59));
      const months = rng.int(12, 24);
      const unitAcres = info.region === "PERMIAN" ? 1280 : 640;
      const nri = Math.round(((t.nma / unitAcres) * fraction(t.royalty)) * 1e6) / 1e6;
      const wells = this.sourceWells.filter((w) => w.county.toUpperCase() === s.county.toUpperCase()).map((w) => String(w.row.name)).slice(0, 3);
      // Royalty checks: gentle decline with month-to-month noise, sized to the asset.
      const base = (t.ourPrice * s.yieldPct) / 12 / Math.pow(0.975, Math.max(0, months - 12));
      let annual = 0;
      for (let m = months - 1; m >= 0; m--) {
        const month = addMonthsYm(lastMonth, -m);
        const amount = round2(base * Math.pow(0.975, months - m) * rng.float(0.88, 1.12));
        if (m < 12) annual += amount;
        this.p.revenue.push({ id: newId(), dealId: id, month: ymToDate(month), amount, kind: "ROYALTY", operator: t.operator, note: `Check #${100000 + rng.int(0, 899999)}`, createdAt: clock.past(addMs(ymToDate(addMonthsYm(month, 2)), 20 * DAY_MS)) });
      }
      if (s.status === "Leased") {
        const bonusMonth = addMonthsYm(lastMonth, -rng.int(4, 9));
        this.p.revenue.push({ id: newId(), dealId: id, month: ymToDate(bonusMonth), amount: roundTo(t.nma * rng.float(250, 400), 50), kind: "LEASE_BONUS", operator: t.operator, note: "3-year paid-up lease, 1/4 royalty", createdAt: ymToDate(addMonthsYm(bonusMonth, 1)) });
      }
      const purchasePrice = t.ourPrice;
      const stageTimes: Record<string, Date> = { CLOSING: acquiredAt };
      if (s.mode === "SELL") stageTimes.PREPARING_PACKAGE = clock.at(-rng.int(10, 20), 11);
      if (s.stage === "SENT_TO_BUYERS") stageTimes.SENT_TO_BUYERS = clock.at(-rng.int(3, 8), 10);
      const ref: DealRef = {
        id, name: t.name, county: info, region: info.region, stage: s.stage, ownerKey, ourPrice: purchasePrice, askPrice: roundTo(purchasePrice * rng.float(1.35, 1.6), 1000),
        nma: t.nma, dateUnderContract: clock.dayOf(acquiredAt), originalClosingDate: clock.dayOf(acquiredAt), stageTimes, published: false,
        sellerContact: null, recordType: "OWNED_ASSET", daysToClose: 30, buyerIds: [], abstract: t.abstract, interestLabel: t.interest.label,
      };
      this.deals.push(ref);
      this.p.deals.push({
        id, organizationId: this.orgId, pipelineId: null, name: t.name, sellerNames: [], recordType: "OWNED_ASSET", assetMode: s.mode,
        counties: [info.name], state: "TX", states: ["TX"], acreageNma: t.nma, nra: t.nra, abstractIds: [t.abstract.id], operator: t.operator,
        askPrice: s.mode === "SELL" ? ref.askPrice : null, ourPrice: purchasePrice, assetTypes: [t.interest.type], basins: info.basins, formations: t.formations,
        stage: s.stage, currentStageEnteredAt: stageTimes[s.stage], relationshipOwnerId: owner.id,
        acquisitionDate: clock.dayOf(acquiredAt), purchasePrice, bookValue: purchasePrice, currentValue: roundTo(purchasePrice * rng.float(1.08, 1.45), 1000),
        ownershipStatus: s.status, ownershipType: t.interest.type === "MI" ? "Mineral" : t.interest.type === "ORRI" ? "ORRI" : "Royalty", workingInterest: 0, netRevenueInterest: nri,
        surveys: [t.abstract.survey], wells, producingStatus: "Producing", royaltyIncomeAnnual: Math.round(annual),
        leaseStatuses: [s.status === "Leased" ? "Leased" : "Held By Production"], royaltyRate: t.royalty,
        leaseEffectiveDate: clock.day(acqDay - rng.int(400, 1600)), leaseExpirationDate: s.status === "Leased" ? clock.day(rng.int(300, 900)) : null,
        notes: `${this.dealNotes(t)} Acquired ${formatCalendarDay(clock.dayOf(acquiredAt))}; pays monthly.`,
        createdAt: acquiredAt, assignees: { connect: [{ id: owner.id }] },
      });
      this.p.stageHistory.push({ id: newId(), dealId: id, fromStage: null, toStage: "CLOSING", changedByUserId: owner.id, createdAt: acquiredAt });
      this.log("DEAL_CREATED", `${owner.name} created deal "${t.name}"`, acquiredAt, ownerKey, id);
      if (stageTimes.PREPARING_PACKAGE) this.p.stageHistory.push({ id: newId(), dealId: id, fromStage: "CLOSING", toStage: "PREPARING_PACKAGE", changedByUserId: owner.id, createdAt: stageTimes.PREPARING_PACKAGE });
      if (stageTimes.SENT_TO_BUYERS) {
        this.p.stageHistory.push({ id: newId(), dealId: id, fromStage: "PREPARING_PACKAGE", toStage: "SENT_TO_BUYERS", changedByUserId: owner.id, createdAt: stageTimes.SENT_TO_BUYERS });
        this.log("STAGE_CHANGE", `${owner.name} moved "${t.name}" to ${prettyStage("SENT_TO_BUYERS")}`, stageTimes.SENT_TO_BUYERS, ownerKey, id);
        this.marketDeal(ref, "ASSET", 2);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Wells + saved analyses
  // -------------------------------------------------------------------------
  planWells(wells: SourceWell[]): void {
    for (const w of wells) {
      const id = newId();
      this.sourceWells.push({ ...w, id });
      this.p.wells.push({ ...w.row, id, organizationId: this.orgId } as Prisma.ResearchWellCreateManyInput);
      if (w.manual) {
        for (const v of w.volumes) {
          const [y, m] = v.month.split("-").map(Number);
          this.p.production.push({ id: newId(), wellId: id, month: ymToDate(v.month), oilBbl: v.oilBbl, gasMcf: v.gasMcf, nglBbl: v.nglBbl, waterBbl: v.waterBbl, daysOn: new Date(Date.UTC(y, m, 0)).getUTCDate() - (v.oilBbl + v.gasMcf === 0 ? 0 : this.rng.chance(0.1) ? this.rng.int(3, 9) : 0), source: "manual" });
        }
      }
    }
    // Three saved analyses over the first groups with production.
    const groups = new Map<string, (SourceWell & { id: string })[]>();
    for (const w of this.sourceWells) (groups.get(w.group) ?? groups.set(w.group, []).get(w.group)!).push(w);
    const picks = [...groups.values()].filter((g) => g.some((w) => w.volumes.length)).slice(0, 3);
    const users = ["owner", "elena", "kayla"];
    picks.forEach((g, i) => {
      const ws = g.slice(0, 3);
      const rows = ws.flatMap((w) => w.volumes);
      const gas = rows.reduce((s, r) => s + r.gasMcf, 0) > rows.reduce((s, r) => s + r.oilBbl, 0) * 6;
      // A royalty buyer values its decimal interest in the unit, not the whole
      // well: realistic owner decimals (royalty-only, no working interest).
      const nri = [0.0125, 0.00586, 0.0094][i];
      const base: Partial<ValuationAssumptions> = { oilPrice: 72, gasPrice: 2.85, nglPrice: 24, nri, workingInterest: 0, discountRatePct: 10, targetRoiPct: 25, closingCosts: 2500 };
      const probe = runValuation(rows, base);
      const npv = Math.max(5_000, probe.economics.presentValue ?? 0);
      const assumptions = normalizeAssumptions({ ...base, askingPrice: roundTo(npv * [0.62, 0.7, 0.55][i], 1000) });
      const results = JSON.parse(JSON.stringify(runValuation(rows, assumptions))) as Prisma.InputJsonValue;
      const lease = titleCase(String(ws[0].row.leaseName ?? ws[0].row.name));
      const created = this.clock.at(-[18, 9, 3][i], [10, 14, 11][i], 15);
      this.p.analyses.push({
        id: newId(), organizationId: this.orgId, name: `${lease} — ${titleCase(ws[0].county)} Co. ${gas ? "gas" : "oil"} valuation`,
        wellIds: ws.map((w) => w.id), assumptions: assumptions as unknown as Prisma.InputJsonValue, results,
        notes: ["Comparing against the buyer's bid; PV10 at strip-like flat deck.", "Two-well unit; checking the decline before we set the ask.", "Quick screen ahead of the seller call."][i],
        createdByUserId: this.u(users[i]).id, createdAt: created, updatedAt: created,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Contact activities, tasks, reminders, lists
  // -------------------------------------------------------------------------
  planContactActivity(contactStatus: Map<string, { type: string; status: string; createdAt: Date; source: string; tags: string[] }>): void {
    const { rng, clock } = this;
    const dealByContact = new Map<string, DealRef>();
    for (const d of this.deals) if (d.sellerContact && !dealByContact.has(d.sellerContact.id)) dealByContact.set(d.sellerContact.id, d);
    // Seller contacts: status follows their deal.
    for (const d of this.deals) {
      const c = d.sellerContact;
      if (!c || contactStatus.has(c.id)) continue;
      const created = addMs(d.stageTimes.UNDER_CONTRACT, -rng.float(10, 60) * DAY_MS);
      const source = rng.pick(CONTACT_SOURCES);
      contactStatus.set(c.id, {
        type: "SELLER", status: d.stage === "DEAD" ? "NOT_INTERESTED" : "CONVERTED", createdAt: created, source,
        tags: [...(c.sellerType === "ESTATE" ? ["Probate"] : []), ...(source.startsWith("Direct mail") ? ["Mailer response"] : []), ...(c.sellerType === "TRUST" ? ["Trust"] : [])],
      });
    }
    // Co-owners (heirs).
    for (const s of this.p.sellers) {
      if (s.isPrimary) continue;
      const c = this.contacts.find((x) => x.firstName === s.firstName && x.lastName === s.lastName);
      if (c && !contactStatus.has(c.id)) contactStatus.set(c.id, { type: "SELLER", status: "CONVERTED", createdAt: clock.at(-rng.int(60, 300), 10), source: "Probate records", tags: ["Heir"] });
    }

    const lastTouch = new Map<string, Date>();
    const push = (row: Omit<Prisma.ContactActivityCreateManyInput, "id" | "organizationId">) => {
      const at = row.createdAt as Date;
      this.p.contactActivities.push({ id: newId(), organizationId: this.orgId, ...row });
      if (row.contactId && ["CALL", "EMAIL", "SMS"].includes(row.kind)) {
        const prev = lastTouch.get(row.contactId);
        if (!prev || prev < at) lastTouch.set(row.contactId, at);
      }
    };
    // Timeline per contact (owners, prospects, landmen).
    this.contacts.forEach((c, i) => {
      const st = contactStatus.get(c.id);
      const created = st?.createdAt ?? clock.at(-rng.int(30, 200), 10);
      const author = c.ownerKey;
      const d = dealByContact.get(c.id);
      const span = Math.max(DAY_MS, clock.now.getTime() - created.getTime());
      const at = (f: number) => clock.past(addMs(created, span * f));
      push({ contactId: c.id, kind: "CALL", body: i >= 40 ? "Caught up on new heir leads in the county." : `Initial call with ${c.firstName}. ${d ? `Discussed the ${d.interestLabel.toLowerCase()} in ${d.county.name} County and recent offers they've received.` : "Owner is curious what the interest is worth."}`, disposition: "Connected", durationSeconds: rng.int(240, 1500), createdById: this.u(author).id, createdAt: at(0.05) });
      if (rng.chance(0.7)) push({ contactId: c.id, kind: "NOTE", title: d ? "Ownership notes" : "Background", body: d ? `${c.entityName ? `${c.entityName}. ` : ""}Interest came down through the ${c.lastName} family; deed of record found in the ${d.county.name} County clerk's office.` : "Mailer response. Inherited the minerals from a grandparent; has never leased directly.", pinned: rng.chance(0.25), color: rng.chance(0.4) ? rng.pick(["yellow", "blue", "green"]) : null, createdById: this.u(author).id, createdAt: at(0.12) });
      if (rng.chance(0.6)) push({ contactId: c.id, kind: "EMAIL", body: d ? "Sent the purchase and sale agreement and W-9 for signature." : "Sent our one-page overview and an ownership report.", createdById: this.u(author).id, createdAt: at(0.35) });
      if (rng.chance(0.45)) push({ contactId: c.id, kind: rng.pick(["CALL", "SMS"]), body: rng.pick(["Confirmed they received the paperwork.", "Left a voicemail — will try again next week.", "Texted a reminder about the notary appointment."]), disposition: null, createdById: this.u(author).id, createdAt: at(0.7) });
      if (rng.chance(0.5)) push({ contactId: c.id, kind: "CALL", body: "Quick check-in call.", disposition: rng.pick(["No Answer", "Voicemail", "Connected", "Callback Requested"]), durationSeconds: rng.int(30, 400), createdById: this.u(author).id, createdAt: at(0.9) });
    });
    // Fix: dispositions only on CALL rows.
    for (const a of this.p.contactActivities) if (a.kind !== "CALL") { a.disposition = null; a.durationSeconds = null; }

    // Open tasks (several for the login user due within the week), completed tasks, reminders.
    const active = this.deals.filter((d) => d.recordType === "OPPORTUNITY" && d.stage !== "CLOSED" && d.stage !== "DEAD" && d.sellerContact);
    const closed = this.deals.filter((d) => d.stage === "CLOSED" && d.sellerContact);
    const name = (c: ContactRef) => `${c.firstName} ${c.lastName}`;
    const openTasks: [number, string, "LOW" | "MEDIUM" | "HIGH", (d: DealRef) => string][] = [
      [-2, "owner", "HIGH", (d) => `Get signed PSA back from ${name(d.sellerContact!)}`],
      [0, "owner", "HIGH", (d) => `Call ${name(d.sellerContact!)} about the curative affidavit`],
      [1, "owner", "MEDIUM", (d) => `Send W-9 and ACH form to ${name(d.sellerContact!)}`],
      [3, "owner", "MEDIUM", (d) => `Confirm closing date with ${name(d.sellerContact!)}`],
      [5, "owner", "LOW", (d) => `Mail closing statement copy to ${name(d.sellerContact!)}`],
      [2, "elena", "HIGH", (d) => `Order title update — ${d.county.name} County tract`],
      [4, "travis", "MEDIUM", (d) => `Pull probate records for the ${d.sellerContact!.lastName} family`],
      [6, "kayla", "MEDIUM", (d) => `Follow up on mailer response from ${name(d.sellerContact!)}`],
      [9, "ben", "MEDIUM", (d) => `Draft affidavit of heirship — ${d.sellerContact!.lastName}`],
      [-1, "travis", "HIGH", (d) => `Record mineral deed in ${d.county.name} County`],
      [12, "kayla", "LOW", (d) => `Re-send offer letter to ${name(d.sellerContact!)}`],
      [8, "elena", "MEDIUM", (d) => `Review operator division order for ${d.name}`],
    ];
    const taskIds: { id: string; contact: ContactRef | null; title: string; due: number; assignee: string; priority: string; author: string }[] = [];
    openTasks.forEach(([due, who, pr, title], i) => {
      const d = active[i % active.length];
      const id = newId();
      const t = title(d);
      const author = i % 3 === 0 ? d.ownerKey : who;
      push({ contactId: d.sellerContact!.id, kind: "TASK", title: t, body: `${d.name}. ${pr === "HIGH" ? "Blocking the closing — please prioritize." : "Notes in the deal file."}`, dueDate: clock.day(due), priority: pr, assignedToId: this.u(who).id, createdById: this.u(author).id, createdAt: clock.at(-rng.int(2, 9), rng.int(8, 16)) });
      this.p.contactActivities[this.p.contactActivities.length - 1].id = id;
      taskIds.push({ id, contact: d.sellerContact, title: t, due, assignee: who, priority: pr, author });
    });
    // Standalone Dashboard tasks (no contact).
    const standalone: [number, string, string, "LOW" | "MEDIUM" | "HIGH", string][] = [
      [1, "owner", "elena", "MEDIUM", "Prep pipeline review for Monday's team meeting"],
      [6, "owner", "owner", "LOW", "Renew the production data subscription"],
      [4, "elena", "owner", "MEDIUM", "Reconcile September expense reports with Grace"],
    ];
    for (const [due, who, author, pr, title] of standalone) {
      const id = newId();
      const createdAt = clock.at(-rng.int(1, 4), rng.int(8, 16));
      this.p.contactActivities.push({ id, organizationId: this.orgId, contactId: null, kind: "TASK", title, body: title, dueDate: clock.day(due), priority: pr, assignedToId: this.u(who).id, createdById: this.u(author).id, createdAt });
      taskIds.push({ id, contact: null, title, due, assignee: who, priority: pr, author });
    }
    // Completed tasks.
    const doneTitles = ["Collect signed PSA", "Notarize mineral deed", "Send closing funds confirmation", "Upload recorded deed to the deal file", "Request division order transfer from operator", "Verify heirship affidavit recording"];
    closed.slice(0, 12).forEach((d, i) => {
      const close = d.stageTimes.CLOSED;
      const due = addMs(close, -rng.int(1, 8) * DAY_MS);
      push({ contactId: d.sellerContact!.id, kind: "TASK", title: `${doneTitles[i % doneTitles.length]} — ${d.sellerContact!.lastName}`, body: d.name, dueDate: clock.dayOf(due), priority: rng.pick(["LOW", "MEDIUM", "HIGH"]), assignedToId: this.u(rng.pick(["owner", "elena", "travis", "ben"])).id, completedAt: addMs(due, -rng.float(0, 1.5) * DAY_MS), createdById: this.u(d.ownerKey).id, createdAt: addMs(due, -rng.int(5, 15) * DAY_MS) });
    });
    // Reminders.
    const remind: [number, string, string][] = [
      [2, "owner", "Seller asked us to call back after the family meeting"],
      [7, "kayla", "Check whether the operator released the 2019 lease"],
      [14, "travis", "Lease expires next quarter — revisit offer"],
      [-3, "elena", "Seller traveling until the 10th; resume outreach"],
    ];
    remind.forEach(([due, who, title], i) => {
      const c = this.contacts[35 + i] ?? this.contacts[i];
      push({ contactId: c.id, kind: "REMINDER", title, body: title, dueDate: clock.day(due), assignedToId: this.u(who).id, createdById: this.u(who).id, createdAt: clock.at(-rng.int(3, 12), rng.int(9, 16)), completedAt: due < 0 ? clock.at(due, 10) : null });
    });
    // Contacts: last touch + next follow-up.
    this.finalizeContacts(contactStatus);
    for (const row of this.p.contacts) {
      const lt = lastTouch.get(row.id!);
      if (lt) row.lastContactedAt = lt;
      if (row.status !== "CONVERTED" && row.status !== "NOT_INTERESTED" && rng.chance(0.6)) row.nextFollowUpDate = clock.day(rng.int(1, 14));
    }
    // Contact lists.
    const mailer = this.p.contacts.filter((c) => (c.counties as string[]).some((x) => x === "Leon" || x === "Robertson" || x === "Freestone")).map((c) => c.id!);
    const heirs = this.p.contacts.filter((c) => (c.tags as string[]).some((t) => t === "Heir" || t === "Probate")).map((c) => c.id!);
    this.p.contactLists.push({ id: newId(), name: "Leon / Robertson / Freestone mailer — Q3 2026", memberIds: mailer });
    this.p.contactLists.push({ id: newId(), name: "Heirs & probate follow-up", memberIds: heirs.length ? heirs : this.p.contacts.slice(28, 32).map((c) => c.id!) });
    this.p.contactLists.push({ id: newId(), name: "Landman network", memberIds: this.p.contacts.slice(40).map((c) => c.id!) });

    // Notifications for the login user (tasks).
    const mine = taskIds.filter((t) => t.assignee === "owner").sort((a, b) => a.due - b.due);
    for (const t of mine.filter((x) => x.due <= 0).slice(0, 2)) {
      const who = t.contact ? `${t.contact.firstName} ${t.contact.lastName}` : null;
      const when = t.due < 0 ? `${-t.due} day${t.due === -1 ? "" : "s"} overdue.` : "due today.";
      this.p.notifications.push({
        id: newId(), organizationId: this.orgId, userId: this.u("owner").id, type: "task_due",
        title: `${t.due < 0 ? "Task overdue" : "Task due"}: ${t.title.slice(0, 80)}`,
        body: who ? `On ${who} · ${when}` : when[0].toUpperCase() + when.slice(1),
        link: t.contact ? `/contacts/${t.contact.id}?task=${t.id}` : `/?task=${t.id}`, createdAt: clock.at(0, 7, 5),
      });
    }
    const assigned = taskIds.find((t) => t.contact === null && t.assignee === "owner" && t.author !== "owner");
    if (assigned) {
      const due = clock.day(assigned.due).toISOString().slice(0, 10);
      this.p.notifications.push({
        id: newId(), organizationId: this.orgId, userId: this.u("owner").id, type: "task_assigned",
        title: `New task: ${assigned.title.slice(0, 80)}`,
        body: `${this.u(assigned.author).name} assigned you a task · ${assigned.priority === "HIGH" ? "High" : assigned.priority === "LOW" ? "Low" : "Medium"} priority · due ${due.slice(5, 7)}/${due.slice(8, 10)}/${due.slice(0, 4)}.`,
        link: `/?task=${assigned.id}`, createdAt: clock.at(-1, 16, 20), readAt: null,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Portal, expenses, calendar, templates, notifications, documents
  // -------------------------------------------------------------------------
  planPortal(): void {
    const { rng, clock } = this;
    const elena = this.u("elena");
    const owner = this.u("owner");
    this.p.portalContacts.push(
      { id: newId(), organizationId: this.orgId, name: elena.name, title: elena.title, email: elena.email, phone: elena.phone, department: "Acquisitions · Bryan, Texas", isPrimary: true, published: true, sortOrder: 0 },
      { id: newId(), organizationId: this.orgId, name: owner.name, title: owner.title, email: owner.email, phone: owner.phone, department: "Management", isPrimary: false, published: true, sortOrder: 1 },
    );
    for (const d of this.deals.filter((x) => x.published)) {
      const since = d.stageTimes.SENT_TO_BUYERS ?? d.stageTimes.PREPARING_PACKAGE ?? d.stageTimes.UNDER_CONTRACT;
      const days = Math.max(1, clock.daysAgo(since));
      const visitors = Array.from({ length: rng.int(12, 30) }, () => rng.token(32));
      const views = rng.int(25, 60);
      const docs = this.p.files.filter((f) => f.row.dealId === d.id && f.row.visibleToBuyers).map((f) => f.row.id!);
      for (let i = 0; i < views; i++) {
        const at = clock.past(addMs(since, rng.float(0.02, 1) * days * DAY_MS));
        this.p.portalEvents.push({ id: newId(), dealId: d.id, kind: "VIEW", visitorId: rng.pick(visitors), createdAt: at });
      }
      for (let i = 0; i < rng.int(2, 7); i++) {
        const at = clock.past(addMs(since, rng.float(0.1, 1) * days * DAY_MS));
        this.p.portalEvents.push({ id: newId(), dealId: d.id, kind: "DOWNLOAD", visitorId: rng.pick(visitors), fileId: docs.length ? rng.pick(docs) : null, createdAt: at });
      }
    }
  }

  planExpenses(): void {
    const { rng, clock } = this;
    EXPENSE_CATEGORIES.forEach((c, i) => this.p.expenseCategories.push({ id: newId(), organizationId: this.orgId, name: c.name, color: c.color, sortOrder: i, active: true }));
    const catId = (name: string) => this.p.expenseCategories.find((c) => c.name === name)!.id!;
    const submitters = ["owner", "elena", "travis", "kayla", "ben"];
    const dealNear = (day: number) => {
      const target = clock.day(day).getTime();
      const cands = this.deals.filter((d) => d.recordType === "OPPORTUNITY" && Math.abs(d.stageTimes.UNDER_CONTRACT.getTime() - target) < 50 * DAY_MS);
      return cands.length ? rng.pick(cands) : rng.pick(this.deals);
    };
    const add = (catName: string, day: number, who: string, amount: number, note: string) => {
      const date = clock.day(day);
      const aged = -day > 25;
      const reimbursed = who !== "owner" && aged && rng.chance(0.85);
      this.p.expenses.push({
        id: newId(), organizationId: this.orgId, userId: this.u(who).id, date, amount: round2(amount), categoryId: catId(catName), notes: note,
        reimbursed, reimbursementDate: reimbursed ? clock.day(Math.min(-1, day + rng.int(6, 20))) : null, createdAt: clock.at(day, rng.int(9, 17)),
      });
    };
    // Monthly data subscription (company card, owner).
    for (let m = 11; m >= 0; m--) add("Data Subscriptions", -(m * 30 + 3), "owner", 349, "Monthly production data subscription");
    const others = EXPENSE_CATEGORIES.filter((c) => c.name !== "Data Subscriptions");
    const weights = [3, 4, 4, 1, 2, 3]; // Title, Recording, Travel, Mailers, Legal, Courthouse
    const bag = others.flatMap((c, i) => Array(weights[i]).fill(c) as typeof others);
    for (let i = 0; i < 58; i++) {
      const c = rng.pick(bag);
      const day = -rng.int(0, 360);
      const d = dealNear(day);
      const who = c.name === "Mailers & Marketing" || c.name === "Legal" ? rng.pick(["owner", "elena"]) : c.name === "Title & Curative" ? rng.pick(["ben", "travis", "elena"]) : rng.pick(submitters);
      const note = rng.pick(c.notes).replace("{deal}", d.name).replace("{county}", d.county.name);
      add(c.name, day, who, rng.float(c.range[0], c.range[1]), note);
    }
    const recent = [...this.p.expenses].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()).slice(0, 6);
    for (const e of recent) {
      const who = [...this.users.values()].find((u) => u.id === e.userId)!;
      this.log("EXPENSE_ADDED", `${who.name} added a ${money(e.amount)} expense`, e.createdAt as Date, who.key);
    }
  }

  planCalendar(): void {
    const { rng, clock } = this;
    STARTER_TYPES.forEach((t, i) => this.p.calendarTypes.push({ id: newId(), organizationId: this.orgId, name: t.name, color: t.color, systemKey: t.systemKey, sortOrder: i }));
    const buyerCallColor = nextTypeColor(this.p.calendarTypes.map((t) => t.color));
    this.p.calendarTypes.push({ id: newId(), organizationId: this.orgId, name: "Buyer call", color: buyerCallColor, systemKey: null, sortOrder: STARTER_TYPES.length });
    this.p.calendarTypes.push({ id: newId(), organizationId: this.orgId, name: "Courthouse visit", color: nextTypeColor(this.p.calendarTypes.map((t) => t.color)), systemKey: null, sortOrder: STARTER_TYPES.length + 1 });
    const type = (name: string) => this.p.calendarTypes.find((t) => t.name === name)!.id!;
    const weekday = (n: number) => { let k = n; for (;;) { const dow = clock.day(k).getUTCDay(); if (dow !== 0 && dow !== 6) return k; k++; } };
    const active = this.deals.filter((d) => d.recordType === "OPPORTUNITY" && d.stage !== "CLOSED" && d.stage !== "DEAD");
    const marketed = active.filter((d) => d.buyerIds.length);
    const ev = (day: number, title: string, typeName: string, who: string, extra: Partial<Prisma.CalendarEventCreateManyInput> = {}) => {
      const k = weekday(day);
      const allDay = extra.allDay ?? false;
      const start = allDay ? null : extra.startTime ?? `${String(rng.int(8, 15)).padStart(2, "0")}:${rng.pick(["00", "30"])}`;
      const end = allDay || !start ? null : extra.endTime ?? `${String(Number(start.slice(0, 2)) + 1).padStart(2, "0")}:${start.slice(3)}`;
      this.p.calendarEvents.push({
        id: newId(), organizationId: this.orgId, title, typeId: type(typeName), date: clock.day(k), allDay, startTime: start, endTime: end,
        assignedToId: this.u(who).id, createdByUserId: this.u(rng.pick(["owner", "elena"])).id, createdAt: clock.at(-rng.int(1, 10), 9),
        completedAt: k < 0 ? clock.at(k, 17) : null, ...extra, ...(allDay ? { startTime: null, endTime: null } : {}),
      });
    };
    // Upcoming (next 8 weeks).
    for (let i = 0; i < 6; i++) { const d = active[(i * 4) % active.length]; ev(2 + i * 7 + rng.int(0, 3), `Title run — ${d.name}`, "Title & diligence", "ben", { dealId: d.id, startTime: "09:00", endTime: "12:00" }); }
    for (let i = 0; i < 6; i++) {
      const d = marketed[i % Math.max(1, marketed.length)] ?? active[i];
      const bId = d.buyerIds[0] ?? this.buyers[i].id;
      const b = this.buyers.find((x) => x.id === bId)!;
      ev(1 + i * 6 + rng.int(0, 2), `Call with ${b.name} re: ${d.name}`, "Buyer call", d.ownerKey, { dealId: d.id, buyerId: b.id, startTime: rng.pick(["10:00", "10:30", "14:00", "15:30"]), endTime: null });
    }
    const counties = [...new Set(active.map((d) => d.county.name))].slice(0, 4);
    counties.forEach((c, i) => ev(4 + i * 12, `${c} County courthouse — deed and probate records`, "Courthouse visit", i % 2 ? "travis" : "ben", { allDay: true, notes: "Pull grantor/grantee index and copies for open title files." }));
    for (const d of active.filter((x) => x.stage === "UNDER_CONTRACT").slice(0, 2)) ev(rng.int(3, 9), `Option period ends — ${d.name}`, "Option expiry", d.ownerKey, { dealId: d.id, allDay: true });
    for (const d of active.filter((x) => x.stage === "PREPARING_PACKAGE").slice(0, 2)) ev(rng.int(5, 15), `Earnest money due — ${d.name}`, "Contract deadline", d.ownerKey, { dealId: d.id, allDay: true });
    ev(3, "Seller follow-up visit — Centerville", "Follow-up", "kayla", { startTime: "13:00", endTime: "15:00", notes: "Two heir households on the same road; bring signed copies." });
    ev(10, "Quarterly buyer roundtable (Midland)", "Buyer call", "owner", { allDay: true, notes: "Meet Caprock, Red Mesa and Comanche Springs in person." });
    // Recent past (completed).
    for (let i = 0; i < 5; i++) { const d = active[(i * 3 + 1) % active.length]; ev(-(2 + i * 3), i % 2 ? `Call with seller — ${d.name}` : `Title run — ${d.name}`, i % 2 ? "Follow-up" : "Title & diligence", i % 2 ? d.ownerKey : "ben", { dealId: d.id }); }
    // weekday() can roll a negative day forward; keep completedAt consistent with the date actually used.
    for (const e of this.p.calendarEvents) { const k = Math.round(((e.date as Date).getTime() - clock.today) / DAY_MS); e.completedAt = k < 0 ? clock.at(k, 17) : null; }
  }

  planTemplates(): void {
    for (const t of EMAIL_TEMPLATES) this.p.emailTemplates.push({ id: newId(), organizationId: this.orgId, name: t.name, subject: t.subject, body: t.body });
  }

  planNotifications(): void {
    const { rng, clock } = this;
    const owner = this.u("owner");
    const mineActive = this.deals.filter((d) => d.ownerKey === "owner" && d.recordType === "OPPORTUNITY" && d.stage !== "CLOSED" && d.stage !== "DEAD");
    const acts = this.p.buyerActivities.filter((a) => a.nextFollowUpDate && mineActive.some((d) => d.id === a.dealId));
    for (const a of acts.slice(0, 2)) {
      const b = this.buyers.find((x) => x.id === a.buyerId)!;
      const d = this.deals.find((x) => x.id === a.dealId)!;
      this.p.notifications.push({ id: newId(), organizationId: this.orgId, userId: owner.id, type: "follow_up_due", title: `Follow-up due: ${b.name}`, body: `Scheduled follow-up on ${d.name} has arrived.`, link: `/deals/${d.id}`, createdAt: clock.at(-rng.int(0, 2), 7, 0) });
    }
    const replied = this.p.messages.find((m) => m.kind === "EMAIL_IN" && mineActive.some((d) => d.id === m.dealId));
    if (replied) {
      const b = this.buyers.find((x) => x.id === replied.buyerId)!;
      this.p.notifications.push({ id: newId(), organizationId: this.orgId, userId: owner.id, type: "email_reply", title: `Email reply from ${b.name}`, body: replied.subject ?? null, link: `/deals/${replied.dealId}`, createdAt: replied.occurredAt as Date, readAt: addMs(replied.occurredAt as Date, 2 * HOUR_MS) });
    }
    const isOverdue = (d: DealRef) => d.recordType === "OPPORTUNITY" && (d.stage === "NEGOTIATING" || d.stage === "SENT_TO_BUYERS") && clock.dayOf(addMs(d.dateUnderContract, Math.max(0, d.daysToClose - 30) * DAY_MS)) < clock.day(0);
    const overdue = this.deals.find((d) => isOverdue(d) && d.ownerKey === "owner") ?? this.deals.find(isOverdue);
    if (overdue) this.p.notifications.push({ id: newId(), organizationId: this.orgId, userId: this.u(overdue.ownerKey).id, type: "deal_overdue", title: `Deal overdue: ${overdue.name}`, body: "Past its Find Buyer By date with no buyer selected.", link: `/deals/${overdue.id}`, createdAt: clock.at(-1, 7, 0) });
  }

  /** Small generated PDFs, only when S3 is configured. */
  planFiles(): void {
    if (!this.withFiles) return;
    const { rng, clock } = this;
    const add = (d: DealRef, folder: string, category: "PSA" | "DEED" | "TITLE_DOC" | "OTHER", title: string, lines: string[], visible: boolean, at: Date, byKey: string) => {
      const filename = `${title} - ${shortSurvey(d.abstract.survey)} (${d.county.name} Co).pdf`;
      const body = buildPdf(title, [d.name, `${d.county.name} County, Texas`, `Abstract ${abstractNumber(d.abstract.label)} - ${d.abstract.survey}`, "", ...lines, "", "Brazos Ridge Minerals - demonstration document"]);
      this.p.files.push({
        body,
        row: {
          id: newId(), dealId: d.id, category, folder, filename, mimeType: "application/pdf", sizeBytes: body.length,
          s3Key: buildKey("deal", d.id, filename), visibleToBuyers: visible, uploadedByUserId: this.u(byKey).id, createdAt: at, updatedAt: at,
        },
      });
    };
    const docDeals = this.deals.filter((d) => d.recordType === "OPPORTUNITY" && (d.published || d.stage === "CLOSING" || d.stage === "CLOSED")).slice(0, 10);
    for (const d of docDeals) {
      const t0 = d.stageTimes.UNDER_CONTRACT;
      add(d, "Seller PSA", "PSA", "Purchase and Sale Agreement", [`Purchase price: ${money(d.ourPrice)}`, `Net mineral acres: ${d.nma}`, `Effective date: ${formatCalendarDay(d.dateUnderContract)}`], false, t0, d.ownerKey);
      add(d, "Title", "TITLE_DOC", "Title Opinion Summary", ["Record title vested in seller; no unreleased liens found.", "Requirement 1: affidavit of heirship for the 1961 estate (satisfied).", "Requirement 2: ratification of the 2021 lease by all heirs (satisfied)."], d.published, addMs(t0, 3 * DAY_MS), "ben");
      if (d.stage === "CLOSED") add(d, "Deeds", "DEED", "Mineral Deed", [`Grantee: Brazos Ridge Minerals`, `Recorded ${formatCalendarDay(clock.dayOf(d.stageTimes.CLOSED))}`, "Instrument No. 2026-" + String(rng.int(1000, 9999))], false, d.stageTimes.CLOSED, "travis");
      if (d.published) add(d, "Division Orders", "OTHER", "Division Order", [`Operator: ${this.p.deals.find((x) => x.id === d.id)?.operator ?? ""}`, `Decimal interest: 0.00${rng.int(1000, 9999)}`], true, addMs(t0, 4 * DAY_MS), d.ownerKey);
    }
    for (const d of this.deals.filter((x) => x.recordType === "OWNED_ASSET").slice(0, 4)) {
      add(d, "Division Orders", "OTHER", "Division Order", [`Decimal interest on file`, "Pay status: current"], false, d.stageTimes.CLOSING, d.ownerKey);
      add(d, "Check Stubs", "OTHER", "Lease Check Stub", [`Production month: ${ym(new Date(Date.UTC(clock.now.getUTCFullYear(), clock.now.getUTCMonth() - 2, 1)))}`, `Owner net: ${money(rng.float(900, 6500))}`], false, clock.at(-rng.int(5, 25), 10), "grace");
    }
  }

  /** Buyers' last-contact dates follow the seeded outreach. */
  finalizeBuyers(): void {
    for (const b of this.p.buyers) {
      const times = this.p.buyerActivities.filter((a) => a.buyerId === b.id).map((a) => (a.lastActivityDate as Date).getTime());
      if (times.length) b.lastContactDate = this.clock.dayOf(new Date(Math.max(...times)));
    }
  }
}

function buildPlan(args: {
  orgId: string; users: UserRef[]; now: Date; geo: Map<string, CountyGeo>; wells: SourceWell[]; withFiles: boolean;
}): Plan {
  const rng = new Rng(PRNG_SEED);
  const clock = new Clock(args.now);
  const pl = new Planner(args.orgId, rng, clock, args.geo, args.users, args.withFiles);
  // Deterministic county order weighted toward the core East Texas footprint.
  const byName = (n: string) => COUNTIES.find((c) => c.name === n)!;
  const countyOrder = rng.shuffle([...COUNTIES, ...["Leon", "Robertson", "Leon", "Karnes", "Martin", "Midland", "Freestone", "Grimes", "Reeves", "Brazos"].map(byName)]);
  pl.planBuyers();
  pl.planContacts(countyOrder);
  pl.planWells(args.wells);
  pl.planDeals(countyOrder);
  pl.planAssets();
  const contactStatus = new Map<string, { type: string; status: string; createdAt: Date; source: string; tags: string[] }>();
  // Converted opportunities' contacts are sellers on live deals.
  for (const d of pl.deals) if (d.sellerContact && pl.p.opportunities.some((o) => o.convertedDealId === d.id)) {
    contactStatus.set(d.sellerContact.id, { type: "SELLER", status: "CONVERTED", createdAt: addMs(d.stageTimes.UNDER_CONTRACT, -45 * DAY_MS), source: "Direct mail — Q2 2026", tags: ["Mailer response"] });
  }
  pl.planOpportunities(countyOrder, contactStatus);
  pl.planContactActivity(contactStatus);
  pl.planFiles();
  pl.planPortal();
  pl.planExpenses();
  pl.planCalendar();
  pl.planTemplates();
  pl.planNotifications();
  pl.finalizeBuyers();
  return pl.p;
}

// ===========================================================================
// Seed
// ===========================================================================

export async function seedDemoOrg(prisma: Db, opts: SeedDemoOptions): Promise<{ organizationId: string; counts: Record<string, number> }> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();

  // ---- validation (before ANY write) --------------------------------------
  assertDemoEmail(opts.demoUserEmail);
  if (typeof opts.demoUserPassword !== "string" || opts.demoUserPassword.length < MIN_DEMO_PASSWORD_LENGTH) {
    throw new Error(`The demo user password must be at least ${MIN_DEMO_PASSWORD_LENGTH} characters`);
  }
  const loginEmail = opts.demoUserEmail.trim().toLowerCase();
  const teamEmails = TEAM.map((m) => (m.emailLocal ? `${m.emailLocal}@${DEMO_EMAIL_DOMAIN}` : loginEmail));
  if (new Set(teamEmails).size !== teamEmails.length) throw new Error(`The login email ${loginEmail} collides with a seeded team member's email`);

  const existing = await findDemoOrg(prisma);
  const reference = await validateReferenceOrg(prisma, opts.referenceOrgId, existing?.id ?? null);
  const orgId = existing?.id ?? newId();
  log(existing ? `Demo org found (${orgId}) — resetting` : `No demo org yet — creating "${DEMO_ORG_NAME}"`);
  log(reference ? `Reference org: "${reference.name}" (${reference.id})` : "Reference org: none");

  // Users: stable ids across resets; a demo email in any other org is fatal.
  const found = await prisma.user.findMany({ where: { email: { in: teamEmails } }, select: { id: true, email: true, organizationId: true } });
  for (const u of found) {
    if (!existing || u.organizationId !== existing.id) {
      throw new Error(`User ${u.email} already exists outside the demo organization — refusing to touch it`);
    }
  }
  const users: UserRef[] = TEAM.map((m, i) => {
    const email = teamEmails[i];
    return { id: found.find((u) => u.email === email)?.id ?? newId(), key: m.key, name: `${m.firstName} ${m.lastName}`, email, phone: m.phone, title: m.title, member: m };
  });

  // ---- read-only reference data ------------------------------------------
  const clock = new Clock(now);
  const geo = await loadGeography(prisma, log);
  const wells = await loadWells(prisma, clock, new Rng(PRNG_SEED + 1), log);
  const withFiles = s3Configured();
  if (!withFiles) log("S3 is not configured — skipping generated documents");

  const plan = buildPlan({ orgId, users, now, geo, wells, withFiles });

  // ---- password hashes (outside the transaction: bcrypt is slow) ---------
  const loginHash = await hashPassword(opts.demoUserPassword);
  const teamHashes = await Promise.all(users.map((u) => (u.key === "owner" ? Promise.resolve(loginHash) : hashPassword(crypto.randomBytes(32).toString("base64url")))));

  // ---- documents: upload new objects first ---------------------------------
  let oldKeys: string[] = [];
  if (existing && withFiles) {
    await assertDemoOrg(prisma, existing.id);
    oldKeys = await demoFileKeys(prisma, existing.id);
  }
  const uploaded: string[] = [];
  try {
    for (const f of plan.files) {
      await putObject(f.row.s3Key, f.body, "application/pdf");
      uploaded.push(f.row.s3Key);
    }
    if (uploaded.length) log(`Uploaded ${uploaded.length} generated PDF documents to S3`);

    await prisma.$transaction(async (tx) => {
      // Serialize concurrent runs.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('mineral-hub-demo-seed'))`);
      const demoNow = await findDemoOrg(tx);
      if ((demoNow?.id ?? null) !== (existing?.id ?? null)) throw new Error("The demo organization changed while seeding — re-run");
      if (existing) {
        await wipeRows(tx, orgId); // re-asserts isDemo inside the transaction
      }
      await writeOrg(tx, orgId, !existing, reference?.id ?? null, users);
      await assertDemoOrg(tx, orgId);
      await writeUsers(tx, orgId, users, teamHashes, opts.demoUserPassword);
      await writePlan(tx, orgId, plan);
    }, TX_OPTIONS);
  } catch (e) {
    for (const k of uploaded) await deleteObject(k).catch(() => {});
    throw e;
  }
  // Old documents are unreferenced now; remove them.
  for (const k of oldKeys) await deleteObject(k).catch((err) => log(`warning: could not delete old S3 object ${k}: ${err instanceof Error ? err.message : err}`));

  const counts = await countDemoRows(prisma, orgId);
  return { organizationId: orgId, counts };
}

async function writeOrg(tx: Tx, orgId: string, create: boolean, referenceOrgId: string | null, users: UserRef[]): Promise<void> {
  let slug = DEMO_PORTAL_SLUG;
  for (let i = 2; ; i++) {
    const taken = await tx.organization.findFirst({ where: { portalSlug: slug, NOT: { id: orgId } }, select: { id: true } });
    if (!taken) break;
    slug = i < 10 ? `${DEMO_PORTAL_SLUG}-${i}` : `${DEMO_PORTAL_SLUG}-${crypto.randomBytes(3).toString("hex")}`;
  }
  const elena = users.find((u) => u.key === "elena")!;
  const portal = {
    portalEnabled: true, portalContactName: elena.name, portalContactEmail: `acquisitions@${DEMO_EMAIL_DOMAIN}`,
    portalContactPhone: elena.phone, portalOfficeLocation: "Bryan, Texas", referenceOrgId,
  };
  if (create) {
    await tx.organization.create({ data: { id: orgId, name: DEMO_ORG_NAME, teamId: await generateTeamId(tx), isDemo: true, portalSlug: slug, ...portal } });
  } else {
    const cur = await tx.organization.findUnique({ where: { id: orgId }, select: { portalSlug: true } });
    await tx.organization.update({ where: { id: orgId }, data: { name: DEMO_ORG_NAME, ...(cur?.portalSlug ? {} : { portalSlug: slug }), ...portal } });
  }
}

async function writeUsers(tx: Tx, orgId: string, users: UserRef[], hashes: string[], loginPassword: string): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    assertDemoEmail(u.email);
    const prior = await tx.user.findUnique({ where: { email: u.email }, select: { id: true, organizationId: true, passwordHash: true } });
    if (prior && prior.organizationId !== orgId) throw new Error(`User ${u.email} belongs to another organization — refusing to touch it`);
    const profile = {
      name: u.name, firstName: u.member.firstName, lastName: u.member.lastName, phone: u.phone,
      role: u.key === "owner" ? ("OWNER" as const) : ("ASSOCIATE" as const), status: "ACTIVE" as const, orgRole: u.member.orgRole,
      mustChangePassword: false, totpEnabled: false, totpSecret: null, totpRecoveryCodes: [],
      lastActiveAt: new Date(now - (i + 1) * 3 * HOUR_MS),
    };
    if (prior) {
      // Only the scoped (demo org + @brazosridge.demo) row is updated.
      const unchanged = u.key === "owner" && (await bcrypt.compare(loginPassword, prior.passwordHash));
      const res = await tx.user.updateMany({
        where: { id: prior.id, ...demoUserScope(orgId) },
        data: { ...profile, passwordHash: unchanged ? prior.passwordHash : hashes[i], ...(unchanged ? {} : { sessionEpoch: { increment: 1 } }) },
      });
      if (res.count !== 1) throw new Error(`Could not update demo user ${u.email}`);
    } else {
      await tx.user.create({ data: { id: u.id, email: u.email, passwordHash: hashes[i], organizationId: orgId, ...profile } });
    }
  }
}

async function writePlan(tx: Tx, orgId: string, p: Plan): Promise<void> {
  const chunked = async <T>(rows: T[], fn: (batch: T[]) => Promise<unknown>, size = 500) => {
    for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
  };
  const assertOrg = <T extends { organizationId?: string | null }>(rows: T[], what: string) => {
    for (const r of rows) if (r.organizationId !== orgId) throw new Error(`internal: ${what} row outside the demo org`);
  };
  [p.buyers, p.contacts, p.contactActivities, p.wells, p.analyses, p.deals, p.messages, p.opportunities, p.portalContacts,
    p.expenseCategories, p.expenses, p.calendarTypes, p.calendarEvents, p.emailTemplates, p.notifications, p.activityLogs, p.buyerTags]
    .forEach((rows, i) => assertOrg(rows as { organizationId?: string | null }[], `batch ${i}`));

  // Pipelines: the default (DEALS) pipeline through the app's own helpers, plus a prospects pipeline.
  const def = await ensureDefaultPipeline(tx, orgId);
  await tx.pipeline.update({ where: { id: def.id }, data: { name: "Acquisitions", description: "Tracts under contract, from signed PSA to funded closing." } });
  await ensureStages(tx, orgId, def.id);
  await tx.pipeline.create({
    data: {
      id: p.oppPipelineId, organizationId: orgId, name: "Prospects", kind: "OPPORTUNITIES", position: 1,
      description: "Owners we're working before a contract is signed.", convertStageKey: "NEGOTIATING", convertMode: "MANUAL",
    },
  });
  await seedStages(tx, orgId, p.oppPipelineId, true, "OPPORTUNITIES");

  await tx.buyer.createMany({ data: p.buyers });
  await tx.buyBoxCriteria.createMany({ data: p.buyBoxes });
  await tx.buyerOwner.createMany({ data: p.buyerOwners });
  await tx.buyerTag.createMany({ data: p.buyerTags });
  await tx.buyerTagOnBuyer.createMany({ data: p.buyerTagLinks });
  await tx.contact.createMany({ data: p.contacts });
  for (const l of p.contactLists) {
    await tx.contactList.create({ data: { id: l.id, organizationId: orgId, name: l.name, members: { connect: l.memberIds.map((id) => ({ id })) } } });
  }
  await tx.researchWell.createMany({ data: p.wells });
  await chunked(p.production, (b) => tx.wellProductionMonth.createMany({ data: b }));
  await tx.wellAnalysis.createMany({ data: p.analyses });

  for (const d of p.deals) await tx.deal.create({ data: d, select: { id: true } });
  await tx.dealSeller.createMany({ data: p.sellers });
  await chunked(p.stageHistory, (b) => tx.dealStageHistory.createMany({ data: b }));
  await chunked(p.buyerActivities, (b) => tx.dealBuyerActivity.createMany({ data: b }));
  await chunked(p.messages, (b) => tx.dealBuyerMessage.createMany({ data: b }));
  await tx.offer.createMany({ data: p.offers.filter((o) => !o.parentOfferId) });
  await tx.offer.createMany({ data: p.offers.filter((o) => o.parentOfferId) });
  for (const s of p.dealSelections) {
    await tx.deal.update({ where: { id: s.id }, data: { selectedOfferId: s.selectedOfferId, selectedBuyerId: s.selectedBuyerId }, select: { id: true } });
  }
  await tx.dealContractExtension.createMany({ data: p.extensions });
  await chunked(p.revenue, (b) => tx.assetRevenueEntry.createMany({ data: b }));

  await tx.opportunity.createMany({ data: p.opportunities });
  await tx.opportunityStageHistory.createMany({ data: p.oppHistory });
  await tx.opportunityActivity.createMany({ data: p.oppActivities });

  await tx.contactActivity.createMany({ data: p.contactActivities });
  if (p.files.length) await tx.fileAttachment.createMany({ data: p.files.map((f) => f.row) });
  await tx.portalContact.createMany({ data: p.portalContacts });
  await chunked(p.portalEvents, (b) => tx.portalEvent.createMany({ data: b }));
  await tx.expenseCategory.createMany({ data: p.expenseCategories });
  await tx.expense.createMany({ data: p.expenses });
  await tx.calendarEventType.createMany({ data: p.calendarTypes });
  await tx.calendarEvent.createMany({ data: p.calendarEvents });
  await tx.emailTemplate.createMany({ data: p.emailTemplates });
  await tx.notification.createMany({ data: p.notifications });
  await chunked(p.activityLogs, (b) => tx.activityLog.createMany({ data: b }));
}
