/**
 * Reports → SMS performance (read-only). Aggregates the HighLevel mirror
 * tables (HighLevelMessage / HighLevelContact / HighLevelOpportunity, filled
 * by the HighLevel sync) in Postgres. Nothing here writes: the sync owns
 * those rows and the Integration row.
 *
 *  - Scope: ?scope=minerals (the default) counts only contacts the sync
 *    classified as minerals (HighLevelContact.line, domain/smsScope.ts
 *    classifyContact with the org's minerals filter); ?scope=all counts all
 *    texting. Volume figures join the contact to know its line.
 *  - Volume figures (texts sent / delivered / failed, replies, contacts
 *    texted, the trend, texting cost) are dated by each message's sentAt.
 *  - Response figures (reached, replied, opt-outs, wrong numbers, time to
 *    first reply, speed to lead, the funnel, best time to text, phone-list
 *    quality) come from the per-contact summaries computed by
 *    domain/smsMetrics.ts summarizeContact(), dated by the contact's first
 *    reached text (firstOutboundAt) — the response cohort.
 *  - "Still waiting" = cohort contacts with no reply yet who got a text that
 *    reached them within the response window of now: a reply now would still
 *    count. (A failed text doesn't restart the window, as in summarizeContact.)
 *  - Carrier health always counts ALL texting with no filters: carriers judge
 *    the sending numbers, whatever the texts were about.
 *  - Team member of a message = its sender, else the contact's assignee;
 *    of a contact's response = whoever sent their first reached text, else
 *    the assignee. Null = "Automated / unassigned".
 *
 * Status SQL is built from the status lists exported by smsMetrics.ts, phone
 * tags from the org's tags classified by smsScope.ts phoneTagKinds(), and
 * funnel ranks from smsFunnel.ts, so a rule means the same thing here as in
 * the sync. Every query is scoped to the
 * caller's org and leans on the (organizationId, sentAt),
 * (organizationId, line, firstOutboundAt) and (organizationId, hlContactId)
 * indexes.
 */
import { Router, type NextFunction, type Response } from "express";
import rateLimit from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, hasPermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import {
  DELIVERED_STATUSES, FAILED_STATUSES, HEALTH_FAILURE_WARN, HEALTH_MIN_TEXTS, HEALTH_OPT_OUT_WARN, PENDING_STATUSES, TOUCH_BUCKETS,
  touchRates, isDeliveredStatus, isFailedStatus, isPendingStatus, type SmsOutcome, type TouchOutcomeCount,
} from "../domain/smsMetrics.js";
import { stepRank, type FunnelStep } from "../domain/smsFunnel.js";
import {
  BEST_TIME_MIN_SAMPLE, DAY_MS, DELTA_KIND, DRILL_SETS, FUNNEL_SETS, NO_SENDER, NO_SOURCE, NO_TAG, TEXTED_SETS, UNASSIGNED_LABEL,
  allRange, bestTimeGrid, cohortCounts, computeKpis, costSummary, drillRow, effectiveScope, fillTrend, funnelSummary, furthestStep,
  healthDays, healthOf, lineCounts, mergeBreakdown, mergeQuality, parseReportScope, parseSmsFilters, phoneTagSets, rangeJson, readHlConfig,
  requestedPeriod, senderName, smsDeltas, speedSummary, trendBucket, waitingSince,
  type CohortGroup, type CostSummary, type DayRange, type DrillRowDim, type DrillSet, type FunnelCounts, type FunnelSummary,
  type HealthCounts, type HlReportConfig, type HlUser, type PhoneGroup, type PhoneTagSets, type QualityCohortGroup,
  type QualityVolumeGroup, type ReportScope,
  type SlotCount, type SmsFilters, type SmsKpis, type SpeedCounts, type SpeedSummary, type TrendBucket, type TrendPoint,
  type VolumeGroup,
} from "../domain/smsReport.js";

export const smsReportsRouter = Router();
smsReportsRouter.use(requireAuth, requireOrg, requirePermission("viewReports"));
// One report load runs ~12 aggregate queries over the org's message history in
// parallel; any viewReports user (VIEWER included) could otherwise loop it and
// drain the shared connection pool for every tenant. Keyed on the user, like
// the AI limiter, so rotating addresses doesn't help.
smsReportsRouter.use(rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).user?.id ?? req.ip ?? "unknown",
  message: { error: "Too many report requests. Wait a minute and try again." },
}));

const PROVIDER = "highlevel";

// --- SQL building blocks -----------------------------------------------------

const OUTBOUND = Prisma.sql`m."direction" = 'outbound'`;
const INBOUND = Prisma.sql`m."direction" = 'inbound'`;
/** The status column normalized like smsMetrics' norm(). */
const STATUS = Prisma.sql`lower(btrim(coalesce(m."status", '')))`;
const SENT = Prisma.sql`NOT (${STATUS} = ANY(${[...PENDING_STATUSES]}::text[]))`;
const DELIVERED = Prisma.sql`${STATUS} = ANY(${[...DELIVERED_STATUSES]}::text[])`;
const FAILED = Prisma.sql`${STATUS} = ANY(${[...FAILED_STATUSES]}::text[])`;
/** Reached the person: went out and didn't fail (smsMetrics isReachedStatus). */
const REACHED = Prisma.sql`${SENT} AND NOT (${FAILED})`;
const col = (alias: string, name: string) => Prisma.raw(`${alias}."${name}"`);
const outcomeIs = (o: SmsOutcome, alias = "c") => Prisma.sql`${col(alias, "outcome")} = ${o}`;

/** A UTC instant as a timestamp literal (the columns are timestamp without time zone, stored in UTC). */
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

/** Minerals scope: only contacts the sync classified as minerals (needs contact `c`). */
const lineIn = (scope: ReportScope) => (scope === "minerals" ? Prisma.sql`AND c."line" = 'minerals'` : Prisma.empty);

const hasFilters = (f: SmsFilters) => f.senders.length + f.tags.length + f.sources.length > 0;

/** The report filters over contact `c`, with `senderExpr` as the team member. */
function filterSql(f: SmsFilters, senderExpr: Prisma.Sql): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  const anyOf = (opts: Prisma.Sql[]) => Prisma.sql`(${Prisma.join(opts, " OR ")})`;
  if (f.senders.length) {
    const ids = f.senders.filter((s) => s !== NO_SENDER);
    const opts: Prisma.Sql[] = [];
    if (ids.length) opts.push(Prisma.sql`${senderExpr} = ANY(${ids}::text[])`);
    if (f.senders.includes(NO_SENDER)) opts.push(Prisma.sql`${senderExpr} IS NULL`);
    parts.push(anyOf(opts));
  }
  if (f.tags.length) {
    const tags = f.tags.filter((t) => t !== NO_TAG);
    const opts: Prisma.Sql[] = [];
    if (tags.length) opts.push(Prisma.sql`c."tags" && ${tags}::text[]`);
    if (f.tags.includes(NO_TAG)) opts.push(Prisma.sql`coalesce(cardinality(c."tags"), 0) = 0`);
    parts.push(anyOf(opts));
  }
  if (f.sources.length) {
    const sources = f.sources.filter((s) => s !== NO_SOURCE);
    const opts: Prisma.Sql[] = [];
    if (sources.length) opts.push(Prisma.sql`btrim(c."source") = ANY(${sources}::text[])`);
    if (f.sources.includes(NO_SOURCE)) opts.push(Prisma.sql`coalesce(btrim(c."source"), '') = ''`);
    parts.push(anyOf(opts));
  }
  return parts.length ? Prisma.sql`AND ${Prisma.join(parts, " AND ")}` : Prisma.empty;
}
const contactSender = Prisma.sql`coalesce(c."creditedHlUserId", c."assignedToHlUserId")`;
const messageSender = Prisma.sql`coalesce(m."hlUserId", c."assignedToHlUserId")`;

/** Messages `m` of the org sent in the range, matching the filters and scope.
 *  Joins their contact `c` when a filter, the scope (or `withContact`) needs it. */
function messagesIn(org: string, r: DayRange, f: SmsFilters, scope: ReportScope, withContact = false): Prisma.Sql {
  const join = withContact || hasFilters(f) || scope === "minerals"
    ? Prisma.sql`LEFT JOIN "HighLevelContact" c ON c."organizationId" = m."organizationId" AND c."hlId" = m."hlContactId"`
    : Prisma.empty;
  return Prisma.sql`FROM "HighLevelMessage" m ${join}
    WHERE m."organizationId" = ${org} AND m."sentAt" >= ${ts(r.from)} AND m."sentAt" < ${ts(r.toExclusive)}
    ${hasFilters(f) ? filterSql(f, messageSender) : Prisma.empty} ${lineIn(scope)}`;
}

/** The response cohort: contacts `c` of the org first reached in the range, matching the filters and scope.
 *  `join` goes between FROM and WHERE (the opportunity lateral). */
function cohortIn(org: string, r: DayRange, f: SmsFilters, scope: ReportScope, join: Prisma.Sql = Prisma.empty): Prisma.Sql {
  return Prisma.sql`FROM "HighLevelContact" c ${join}
    WHERE c."organizationId" = ${org} AND c."firstOutboundAt" >= ${ts(r.from)} AND c."firstOutboundAt" < ${ts(r.toExclusive)}
    ${filterSql(f, contactSender)} ${lineIn(scope)}`;
}

/** Contacts `c` who texted first, dated by that first inbound text. */
function inboundFirstIn(org: string, r: DayRange, f: SmsFilters, scope: ReportScope): Prisma.Sql {
  return Prisma.sql`FROM "HighLevelContact" c
    WHERE c."organizationId" = ${org} AND ${outcomeIs("INBOUND_FIRST")}
      AND c."outcomeAt" >= ${ts(r.from)} AND c."outcomeAt" < ${ts(r.toExclusive)}
    ${filterSql(f, contactSender)} ${lineIn(scope)}`;
}

/** A contact's tags as rows (DISTINCT: a tag listed twice counts once); none → "(no tag)". */
const tagRows = (alias: string) =>
  Prisma.sql`CROSS JOIN LATERAL (SELECT DISTINCT unnest(CASE WHEN coalesce(cardinality(${col(alias, "tags")}), 0) = 0
    THEN ARRAY[${NO_TAG}]::text[] ELSE ${col(alias, "tags")} END) AS tag) t`;
const sourceKey = (alias: string) => Prisma.sql`coalesce(nullif(btrim(${col(alias, "source")}), ''), ${NO_SOURCE})`;

// --- Phone tags (domain/smsScope.ts phoneTagKinds) -----------------------------

/** The org's tags, classified into phone-quality groups (domain phoneTagSets). */
async function loadPhoneTags(org: string): Promise<PhoneTagSets> {
  const rows = await prisma.$queryRaw<{ v: string }[]>(Prisma.sql`/* sms:tags */
    SELECT DISTINCT unnest(c."tags") AS v FROM "HighLevelContact" c WHERE c."organizationId" = ${org}`);
  return phoneTagSets(rows.map((r) => r.v));
}

/** Contact `alias` carries one of these exact tags. */
const hasAnyTag = (tags: readonly string[], alias = "c") => Prisma.sql`(${col(alias, "tags")} && ${[...tags]}::text[])`;

/** A wrong number: a reply flagged as one, or an XLeads wrong-number tag. */
const wrongNumberSql = (pt: PhoneTagSets, alias = "c") =>
  Prisma.sql`(${col(alias, "wrongNumberAt")} IS NOT NULL OR ${hasAnyTag(pt.wrongNumber, alias)})`;

/** Phone-quality drill sets → their tag group. */
const PHONE_SETS: Partial<Record<DrillSet, Exclude<PhoneGroup, "wrongNumber">>> = {
  disconnected: "disconnected", landline: "landline", rotated: "rotated", exhausted: "exhausted",
};

/** A contact's LIST tags: every tag except the phone-rotation ones (they describe a number, not a list). */
const listTags = (pt: PhoneTagSets, alias: string) => Prisma.sql`ARRAY(SELECT lt.v FROM unnest(${col(alias, "tags")}) AS lt(v)
  WHERE lt.v <> ALL(${pt.any}::text[]))`;
const listTagRows = (pt: PhoneTagSets, alias: string) =>
  Prisma.sql`CROSS JOIN LATERAL (SELECT DISTINCT unnest(CASE WHEN cardinality(l.tags) = 0 THEN ARRAY[${NO_TAG}]::text[] ELSE l.tags END) AS tag
    FROM (SELECT ${listTags(pt, alias)} AS tags) l) t`;

// --- Opportunities (domain/smsFunnel.ts) ----------------------------------------

const RANK = { offer: stepRank("offer"), accepted: stepRank("accepted"), contract: stepRank("contract"), closed: stepRank("closed") };
const NOT_ACCEPTED: FunnelStep = "not_accepted";
const DEAD: FunnelStep = "dead";

/**
 * Per cohort contact `c`, their opportunities (`x`) in the given pipelines
 * (null = any), deleted ones left out. Only opportunities created at or after
 * the person's first text count; earlier ones are "pre-existing" (x.pre).
 * maxRank is the furthest step ever seen, so an offer that died still counts.
 */
function oppLateral(org: string, pipelines: string[] | null): Prisma.Sql {
  const counts = Prisma.sql`(o."hlCreatedAt" IS NOT NULL AND o."hlCreatedAt" >= c."firstOutboundAt")`;
  return Prisma.sql`LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE ${counts})::int AS n,
      count(*) FILTER (WHERE NOT ${counts})::int AS pre,
      coalesce(bool_or(${counts} AND (o."step" = ${NOT_ACCEPTED} OR o."maxRank" >= ${RANK.offer})), false) AS offer,
      coalesce(bool_or(${counts} AND o."maxRank" >= ${RANK.accepted}), false) AS accepted,
      coalesce(bool_or(${counts} AND o."maxRank" >= ${RANK.contract}), false) AS contract,
      coalesce(bool_or(${counts} AND o."maxRank" >= ${RANK.closed}), false) AS closed,
      count(*) FILTER (WHERE ${counts} AND o."step" <> ${DEAD})::int AS alive,
      min(o."hlCreatedAt") FILTER (WHERE ${counts}) AS "firstAt",
      min(o."closedAt") FILTER (WHERE ${counts} AND o."maxRank" >= ${RANK.closed}) AS "closedAt"
    FROM "HighLevelOpportunity" o
    WHERE o."organizationId" = ${org} AND o."hlContactId" = c."hlId" AND NOT o."deletedInHl"
      ${pipelines ? Prisma.sql`AND o."pipelineId" = ANY(${pipelines}::text[])` : Prisma.empty}
  ) x ON TRUE`;
}

/** Drill condition for a funnel set (people at or past the step; dead = every counted opportunity dead now). */
const FUNNEL_COND: Record<string, Prisma.Sql> = {
  opportunity: Prisma.sql`x.n > 0`,
  offer: Prisma.sql`x.offer`,
  accepted: Prisma.sql`x.accepted`,
  contract: Prisma.sql`x.contract`,
  closed: Prisma.sql`x.closed`,
  dead: Prisma.sql`x.n > 0 AND x.alive = 0`,
};

/**
 * Contact `c` has no reply yet but a text reached them at or after `since`
 * (domain waitingSince), so a reply now still counts. lastMessageAt (any
 * text, failed ones too) is the cheap first cut; the index on (org, contact,
 * sentAt) answers the rest.
 */
const stillWaitingSql = (org: string, since: Date) => Prisma.sql`(${outcomeIs("NO_REPLY")} AND c."lastMessageAt" >= ${ts(since)}
  AND EXISTS (SELECT 1 FROM "HighLevelMessage" m WHERE m."organizationId" = ${org} AND m."hlContactId" = c."hlId"
    AND m."sentAt" >= ${ts(since)} AND ${OUTBOUND} AND ${REACHED}))`;

const seconds = (a: Prisma.Sql, b: Prisma.Sql) => Prisma.sql`greatest(extract(epoch FROM ${a} - ${b}), 0)::float8`;

// --- Queries ------------------------------------------------------------------

interface VolumeRow { sent: number; delivered: number; failed: number; inbound: number; contactsTexted: number; segments: number; unknownSegments: number }

async function volumeTotals(org: string, r: DayRange, f: SmsFilters, scope: ReportScope): Promise<VolumeRow> {
  const rows = await prisma.$queryRaw<Partial<VolumeRow>[]>(Prisma.sql`/* sms:volume */
    SELECT count(*) FILTER (WHERE ${OUTBOUND} AND ${SENT})::int AS sent,
      count(*) FILTER (WHERE ${OUTBOUND} AND ${DELIVERED})::int AS delivered,
      count(*) FILTER (WHERE ${OUTBOUND} AND ${FAILED})::int AS failed,
      count(*) FILTER (WHERE ${INBOUND})::int AS inbound,
      count(DISTINCT m."hlContactId") FILTER (WHERE ${OUTBOUND} AND ${SENT})::int AS "contactsTexted",
      -- Billable segments; a text the sync hasn't counted yet is one segment (disclosed).
      coalesce(sum(coalesce(m."segments", 1)) FILTER (WHERE ${OUTBOUND} AND ${SENT}), 0)::int AS segments,
      count(*) FILTER (WHERE ${OUTBOUND} AND ${SENT} AND m."segments" IS NULL)::int AS "unknownSegments"
    ${messagesIn(org, r, f, scope)}`);
  const v = rows[0] ?? {};
  return {
    sent: v.sent ?? 0, delivered: v.delivered ?? 0, failed: v.failed ?? 0, inbound: v.inbound ?? 0,
    contactsTexted: v.contactsTexted ?? 0, segments: v.segments ?? 0, unknownSegments: v.unknownSegments ?? 0,
  };
}

async function trendPoints(org: string, r: DayRange, f: SmsFilters, scope: ReportScope, bucket: TrendBucket): Promise<TrendPoint[]> {
  const fmt = bucket === "month" ? "YYYY-MM" : "YYYY-MM-DD";
  // Grouped on the truncated timestamp; formatted once per bucket, not per row.
  const rows = await prisma.$queryRaw<TrendPoint[]>(Prisma.sql`/* sms:trend */
    SELECT to_char(b.start, ${fmt}) AS period, b.sent, b.delivered, b.failed, b.inbound
    FROM (
      SELECT date_trunc(${bucket}, m."sentAt") AS start,
        count(*) FILTER (WHERE ${OUTBOUND} AND ${SENT})::int AS sent,
        count(*) FILTER (WHERE ${OUTBOUND} AND ${DELIVERED})::int AS delivered,
        count(*) FILTER (WHERE ${OUTBOUND} AND ${FAILED})::int AS failed,
        count(*) FILTER (WHERE ${INBOUND})::int AS inbound
      ${messagesIn(org, r, f, scope)}
      GROUP BY 1
    ) b`);
  return fillTrend(r, bucket, rows);
}

interface CohortRow extends TouchOutcomeCount { unconfirmed: number; texts: number }

async function cohortRows(org: string, r: DayRange, f: SmsFilters, scope: ReportScope): Promise<CohortRow[]> {
  return prisma.$queryRaw<CohortRow[]>(Prisma.sql`/* sms:cohort */
    SELECT c."touches" AS touches, c."outcome" AS outcome, count(*)::int AS count,
      coalesce(sum(c."unconfirmedTouches"), 0)::int AS unconfirmed, coalesce(sum(c."touches"), 0)::int AS texts
    ${cohortIn(org, r, f, scope)}
    GROUP BY 1, 2`);
}

async function responseTimes(org: string, r: DayRange, f: SmsFilters, scope: ReportScope): Promise<{ avg: number | null; median: number | null }> {
  const rows = await prisma.$queryRaw<{ avg: number | null; median: number | null }[]>(Prisma.sql`/* sms:times */
    SELECT avg(c."responseSeconds")::float8 AS avg,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY c."responseSeconds")::float8 AS median
    ${cohortIn(org, r, f, scope)} AND ${outcomeIs("RESPONDED")} AND c."responseSeconds" IS NOT NULL`);
  return rows[0] ?? { avg: null, median: null };
}

/** Wrong numbers, people still waiting on a reply and speed to lead over the cohort, in one pass. */
async function cohortExtras(org: string, r: DayRange, f: SmsFilters, scope: ReportScope, pt: PhoneTagSets, since: Date):
  Promise<{ wrongNumbers: number; stillWaiting: number; speed: SpeedCounts }> {
  const answered = Prisma.sql`${outcomeIs("RESPONDED")} AND c."replyAnsweredSeconds" IS NOT NULL`;
  const rows = await prisma.$queryRaw<(SpeedCounts & { wrongNumbers: number; stillWaiting: number })[]>(Prisma.sql`/* sms:cohort-x */
    SELECT count(*) FILTER (WHERE ${wrongNumberSql(pt)})::int AS "wrongNumbers",
      count(*) FILTER (WHERE ${stillWaitingSql(org, since)})::int AS "stillWaiting",
      count(*) FILTER (WHERE ${outcomeIs("RESPONDED")})::int AS responded,
      count(*) FILTER (WHERE ${answered})::int AS answered,
      count(*) FILTER (WHERE ${answered} AND c."replyAnsweredSeconds" <= 300)::int AS "within5m",
      count(*) FILTER (WHERE ${answered} AND c."replyAnsweredSeconds" <= 3600)::int AS "within1h",
      count(*) FILTER (WHERE ${answered} AND c."replyAnsweredSeconds" <= 86400)::int AS "within24h",
      (avg(c."replyAnsweredSeconds") FILTER (WHERE ${answered}))::float8 AS avg,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY c."replyAnsweredSeconds") FILTER (WHERE ${answered}))::float8 AS median
    ${cohortIn(org, r, f, scope)}`);
  const x = rows[0];
  return {
    wrongNumbers: x?.wrongNumbers ?? 0,
    stillWaiting: x?.stillWaiting ?? 0,
    speed: {
      responded: x?.responded ?? 0, answered: x?.answered ?? 0, within5m: x?.within5m ?? 0, within1h: x?.within1h ?? 0,
      within24h: x?.within24h ?? 0, avg: x?.avg ?? null, median: x?.median ?? null,
    },
  };
}

type FunnelRow = Omit<FunnelCounts, "reached" | "responded" | "toOpportunity" | "toClose"> & {
  oppAvg: number | null; oppMedian: number | null; closeAvg: number | null; closeMedian: number | null; closeKnown: number;
};

/** The cohort's opportunities in the given pipelines (null = any), per person. */
async function funnelCounts(org: string, r: DayRange, f: SmsFilters, scope: ReportScope, pipelines: string[] | null) {
  const toOpp = seconds(Prisma.sql`x."firstAt"`, Prisma.sql`c."firstOutboundAt"`);
  const toClose = seconds(Prisma.sql`x."closedAt"`, Prisma.sql`c."firstOutboundAt"`);
  const closedKnown = Prisma.sql`x.closed AND x."closedAt" IS NOT NULL`;
  const rows = await prisma.$queryRaw<Partial<FunnelRow>[]>(Prisma.sql`/* sms:funnel */
    SELECT count(*) FILTER (WHERE ${FUNNEL_COND.opportunity})::int AS opportunity,
      count(*) FILTER (WHERE ${FUNNEL_COND.offer})::int AS offer,
      count(*) FILTER (WHERE ${FUNNEL_COND.accepted})::int AS accepted,
      count(*) FILTER (WHERE ${FUNNEL_COND.contract})::int AS contract,
      count(*) FILTER (WHERE ${FUNNEL_COND.closed})::int AS closed,
      count(*) FILTER (WHERE ${FUNNEL_COND.dead})::int AS dead,
      coalesce(sum(x.pre), 0)::int AS "preExisting",
      coalesce(sum(c."outboundTotal"), 0)::int AS "cohortTexts",
      (avg(${toOpp}) FILTER (WHERE x.n > 0))::float8 AS "oppAvg",
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${toOpp}) FILTER (WHERE x.n > 0))::float8 AS "oppMedian",
      (avg(${toClose}) FILTER (WHERE ${closedKnown}))::float8 AS "closeAvg",
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${toClose}) FILTER (WHERE ${closedKnown}))::float8 AS "closeMedian",
      count(*) FILTER (WHERE ${closedKnown})::int AS "closeKnown"
    ${cohortIn(org, r, f, scope, oppLateral(org, pipelines))}`);
  const x = rows[0] ?? {};
  return {
    opportunity: x.opportunity ?? 0, offer: x.offer ?? 0, accepted: x.accepted ?? 0, contract: x.contract ?? 0, closed: x.closed ?? 0,
    dead: x.dead ?? 0, preExisting: x.preExisting ?? 0, cohortTexts: x.cohortTexts ?? 0,
    toOpportunity: { avg: x.oppAvg ?? null, median: x.oppMedian ?? null },
    toClose: { avg: x.closeAvg ?? null, median: x.closeMedian ?? null, known: x.closeKnown ?? 0 },
  };
}

async function inboundFirstCount(org: string, r: DayRange, f: SmsFilters, scope: ReportScope): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>(Prisma.sql`/* sms:inbound-first */
    SELECT count(*)::int AS n ${inboundFirstIn(org, r, f, scope)}`);
  return rows[0]?.n ?? 0;
}

interface PeriodData {
  kpis: SmsKpis; rows: CohortRow[]; volume: VolumeRow; funnel: FunnelSummary; cost: CostSummary; speed: SpeedSummary;
}

/** Everything one period's KPI tiles need (the current period and the comparison window alike). */
async function periodData(org: string, r: DayRange, f: SmsFilters, scope: ReportScope,
  ctx: { pipelines: string[] | null; price: number | null; phoneTags: PhoneTagSets; waitingSince: Date }): Promise<PeriodData> {
  const [v, rows, times, extras, fun] = await Promise.all([
    volumeTotals(org, r, f, scope), cohortRows(org, r, f, scope), responseTimes(org, r, f, scope),
    cohortExtras(org, r, f, scope, ctx.phoneTags, ctx.waitingSince), funnelCounts(org, r, f, scope, ctx.pipelines),
  ]);
  const c = cohortCounts(rows);
  const funnel = funnelSummary({ reached: c.reached, responded: c.responded, ...fun });
  const cost = costSummary(v.segments, v.unknownSegments, ctx.price,
    { responded: c.responded, opportunities: fun.opportunity, offers: fun.offer, closed: fun.closed });
  const speed = speedSummary(extras.speed);
  const kpis = computeKpis(v, {
    reached: c.reached, responded: c.responded, optedOut: c.optedOut, respondedTexts: c.respondedTexts,
    avgSeconds: times.avg == null ? null : Math.round(times.avg),
    medianSeconds: times.median == null ? null : Math.round(times.median),
  }, { stillWaiting: extras.stillWaiting, wrongNumbers: extras.wrongNumbers, funnel, cost, speed });
  return { kpis, rows, volume: v, funnel, cost, speed };
}

type Dim = "sender" | "tag" | "source" | "listTag";

async function breakdownGroups(org: string, r: DayRange, f: SmsFilters, scope: ReportScope, pt: PhoneTagSets) {
  const agg = Prisma.sql`count(*)::int AS reached,
    count(*) FILTER (WHERE ${outcomeIs("RESPONDED", "k")})::int AS responded,
    count(*) FILTER (WHERE ${outcomeIs("OPTED_OUT", "k")})::int AS "optedOut",
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY k."responseSeconds") FILTER (WHERE ${outcomeIs("RESPONDED", "k")}))::float8 AS median`;
  const cohort = prisma.$queryRaw<(CohortGroup & { dim: Dim })[]>(Prisma.sql`/* sms:bd-cohort */
    WITH k AS (
      SELECT c."creditedHlUserId", c."assignedToHlUserId", c."tags", c."source", c."outcome", c."responseSeconds"
      ${cohortIn(org, r, f, scope)}
    )
    SELECT 'sender' AS dim, coalesce(k."creditedHlUserId", k."assignedToHlUserId", ${NO_SENDER}) AS key, ${agg} FROM k GROUP BY 2
    UNION ALL
    SELECT 'tag' AS dim, t.tag AS key, ${agg} FROM k ${tagRows("k")} GROUP BY 2
    UNION ALL
    SELECT 'source' AS dim, ${sourceKey("k")} AS key, ${agg} FROM k GROUP BY 2`);
  // Texts sent (and delivered, for the phone lists): aggregated first on
  // (team member, tag list, source) — a few hundred combinations, not one row
  // per contact — then rolled up per dimension. Tags are unnested only on
  // those few rows.
  const volume = prisma.$queryRaw<(VolumeGroup & { dim: Dim; delivered: number })[]>(Prisma.sql`/* sms:bd-volume */
    WITH g AS (
      SELECT ${messageSender} AS sender, c."tags", c."source", count(*)::int AS sent,
        count(*) FILTER (WHERE ${DELIVERED})::int AS delivered
      ${messagesIn(org, r, f, scope, true)} AND ${OUTBOUND} AND ${SENT}
      GROUP BY 1, 2, 3
    )
    SELECT 'sender' AS dim, coalesce(g.sender, ${NO_SENDER}) AS key, sum(g.sent)::int AS "textsSent", sum(g.delivered)::int AS delivered FROM g GROUP BY 2
    UNION ALL
    SELECT 'tag' AS dim, t.tag AS key, sum(g.sent)::int AS "textsSent", sum(g.delivered)::int AS delivered FROM g ${tagRows("g")} GROUP BY 2
    UNION ALL
    SELECT 'source' AS dim, ${sourceKey("g")} AS key, sum(g.sent)::int AS "textsSent", sum(g.delivered)::int AS delivered FROM g GROUP BY 2
    UNION ALL
    SELECT 'listTag' AS dim, t.tag AS key, sum(g.sent)::int AS "textsSent", sum(g.delivered)::int AS delivered FROM g ${listTagRows(pt, "g")} GROUP BY 2`);
  return Promise.all([cohort, volume]);
}

/** Phone-list quality of the cohort, per list tag and per source. */
async function qualityGroups(org: string, r: DayRange, f: SmsFilters, scope: ReportScope, pt: PhoneTagSets) {
  const agg = Prisma.sql`count(*)::int AS reached,
    count(*) FILTER (WHERE ${outcomeIs("RESPONDED", "k")})::int AS responded,
    count(*) FILTER (WHERE k.wrong)::int AS "wrongNumber",
    count(*) FILTER (WHERE k.disc)::int AS disconnected,
    count(*) FILTER (WHERE k.land)::int AS landline,
    count(*) FILTER (WHERE k.rot)::int AS rotated,
    count(*) FILTER (WHERE k.exh)::int AS exhausted`;
  return prisma.$queryRaw<(QualityCohortGroup & { dim: Dim })[]>(Prisma.sql`/* sms:quality */
    WITH k AS (
      SELECT c."tags", c."source", c."outcome", ${wrongNumberSql(pt)} AS wrong,
        ${hasAnyTag(pt.disconnected)} AS disc, ${hasAnyTag(pt.landline)} AS land,
        ${hasAnyTag(pt.rotated)} AS rot, ${hasAnyTag(pt.exhausted)} AS exh
      ${cohortIn(org, r, f, scope)}
    )
    SELECT 'listTag' AS dim, t.tag AS key, ${agg} FROM k ${listTagRows(pt, "k")} GROUP BY 2
    UNION ALL
    SELECT 'source' AS dim, ${sourceKey("k")} AS key, ${agg} FROM k GROUP BY 2`);
}

/** Speed to lead per team member who answered (the person who typed the answering text). */
async function speedMembers(org: string, r: DayRange, f: SmsFilters, scope: ReportScope) {
  return prisma.$queryRaw<{ key: string | null; answered: number; median: number | null; within1h: number }[]>(Prisma.sql`/* sms:speed-members */
    SELECT c."answeredByHlUserId" AS key, count(*)::int AS answered,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY c."replyAnsweredSeconds")::float8 AS median,
      count(*) FILTER (WHERE c."replyAnsweredSeconds" <= 3600)::int AS "within1h"
    ${cohortIn(org, r, f, scope)} AND ${outcomeIs("RESPONDED")} AND c."replyAnsweredSeconds" IS NOT NULL
    GROUP BY 1`);
}

/** Response rate by weekday × hour of the first text, in the location's time zone. */
async function slotCounts(org: string, r: DayRange, f: SmsFilters, scope: ReportScope, tz: string): Promise<SlotCount[]> {
  return prisma.$queryRaw<SlotCount[]>(Prisma.sql`/* sms:best-time */
    SELECT extract(isodow FROM l.t)::int AS dow, extract(hour FROM l.t)::int AS hour,
      count(*)::int AS reached, count(*) FILTER (WHERE ${outcomeIs("RESPONDED", "l")})::int AS responded
    FROM (SELECT (c."firstOutboundAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz} AS t, c."outcome" ${cohortIn(org, r, f, scope)}) l
    GROUP BY 1, 2`);
}

/** People texted in the period, by business line (ignores the scope; honours the filters). */
async function lineSplit(org: string, r: DayRange, f: SmsFilters) {
  const rows = await prisma.$queryRaw<{ line: string | null; n: number }[]>(Prisma.sql`/* sms:line-split */
    SELECT c."line" AS line, count(DISTINCT m."hlContactId")::int AS n
    ${messagesIn(org, r, f, "all", true)} AND ${OUTBOUND} AND ${SENT}
    GROUP BY 1`);
  return lineCounts(rows);
}

/**
 * carrierHealth inputs: texts sent / failed, people reached, people who opted
 * out. Grouped per contact first (`key` = the extra grouping, e.g. the day),
 * which is far cheaper than counting distinct contacts per group.
 */
const healthAgg = (key: Prisma.Sql) => Prisma.sql`
  SELECT ${key} AS key, m."hlContactId",
    count(*) FILTER (WHERE ${OUTBOUND} AND ${SENT}) AS sent,
    count(*) FILTER (WHERE ${OUTBOUND} AND ${FAILED}) AS failed,
    count(*) FILTER (WHERE ${OUTBOUND} AND ${SENT} AND NOT (${FAILED})) AS reached,
    count(*) FILTER (WHERE ${INBOUND} AND m."optOut") AS opt
  FROM "HighLevelMessage" m`;
const HEALTH_TOTALS = Prisma.sql`coalesce(sum(x.sent), 0)::int AS sent, coalesce(sum(x.failed), 0)::int AS failed,
  count(*) FILTER (WHERE x.reached > 0)::int AS reached, count(*) FILTER (WHERE x.opt > 0)::int AS "optOuts"`;

/** Carrier health per UTC day — ALL texting, no filters (carriers judge the sending numbers). */
async function healthRows(org: string, r: DayRange): Promise<(HealthCounts & { day: string })[]> {
  return prisma.$queryRaw<(HealthCounts & { day: string })[]>(Prisma.sql`/* sms:health-days */
    SELECT to_char(x.key, 'YYYY-MM-DD') AS day, ${HEALTH_TOTALS}
    FROM (${healthAgg(Prisma.sql`date_trunc('day', m."sentAt")`)}
      WHERE m."organizationId" = ${org} AND m."sentAt" >= ${ts(r.from)} AND m."sentAt" < ${ts(r.toExclusive)}
      GROUP BY 1, 2) x
    GROUP BY x.key`);
}

/** Carrier health over the 7 days up to now. */
async function healthLast7(org: string, now: Date): Promise<HealthCounts> {
  const rows = await prisma.$queryRaw<HealthCounts[]>(Prisma.sql`/* sms:health-7d */
    SELECT ${HEALTH_TOTALS}
    FROM (${healthAgg(Prisma.sql`0`)}
      WHERE m."organizationId" = ${org} AND m."sentAt" >= ${ts(new Date(now.getTime() - 7 * DAY_MS))} AND m."sentAt" < ${ts(now)}
      GROUP BY 1, 2) x`);
  return rows[0] ?? { sent: 0, failed: 0, reached: 0, optOuts: 0 };
}

async function loadIntegration(org: string) {
  return prisma.integration.findUnique({
    where: { organizationId_provider: { organizationId: org, provider: PROVIDER } },
    select: { status: true, config: true, lastSyncAt: true, lastError: true, connectedAt: true },
  });
}

/** The funnel's pipelines: the minerals ones (by the minerals filter in force) in minerals scope, every one otherwise. */
function funnelPipelines(cfg: HlReportConfig, scope: ReportScope): string[] | null {
  return scope === "minerals" ? effectiveScope(cfg).mineralPipelineIds : null;
}
const pipelineName = (cfg: HlReportConfig, id: string) => cfg.hlPipelines.find((p) => p.id === id)?.name ?? "HighLevel pipeline";

/** The report's time zone for "best time to text": the location's, else UTC (and say so). */
const reportTimeZone = (cfg: HlReportConfig) => ({ timezone: cfg.locationTimezone ?? "UTC", fallback: cfg.locationTimezone == null });

/** ?period=ALL → first..last text of the org; otherwise the asked range. */
async function resolveRange(org: string, q: Record<string, unknown>, now: Date): Promise<{ range: DayRange; compare: DayRange | null; all: boolean }> {
  const asked = requestedPeriod(q, now);
  if (!asked.all) return { range: asked.range, compare: asked.compare, all: false };
  const span = await prisma.highLevelMessage.aggregate({ where: { organizationId: org }, _min: { sentAt: true }, _max: { sentAt: true } });
  // Nothing precedes "All", so it never compares.
  return { range: allRange(span?._min.sentAt ?? null, span?._max.sentAt ?? null, now), compare: null, all: true };
}

// --- Routes ---------------------------------------------------------------------

/** Connection state for the SMS view's banners, and how texted people split by business line. */
smsReportsRouter.get(
  "/status",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const [row, anyMessage, lines] = await Promise.all([
      loadIntegration(org),
      prisma.highLevelMessage.findFirst({ where: { organizationId: org }, select: { id: true } }),
      prisma.$queryRaw<{ line: string | null; n: number }[]>(Prisma.sql`/* sms:status-lines */
        SELECT c."line" AS line, count(*)::int AS n FROM "HighLevelContact" c
        WHERE c."organizationId" = ${org} AND c."outboundTotal" > 0 GROUP BY 1`),
    ]);
    const cfg = readHlConfig(row?.config);
    const status = row?.status ?? "NOT_CONNECTED";
    const connected = status !== "NOT_CONNECTED";
    // The sync's own error text can name HighLevel internals; only people who
    // manage integrations (and can fix it) see it.
    const lastError = row?.lastError ?? (cfg.sync.lastRun && !cfg.sync.lastRun.ok ? cfg.sync.lastRun.message : null);
    res.json({
      connected,
      status,
      phase: connected ? cfg.sync.phase ?? "preview" : null,
      locationName: cfg.locationName,
      lastSyncAt: row?.lastSyncAt ?? null,
      imported: cfg.sync.imported,
      previewTexts: cfg.sync.previewTexts,
      responseWindowDays: cfg.responseWindowDays,
      lastError: hasPermission(req, "manageApiIntegrations") ? lastError : null,
      // Disconnecting keeps the synced history, which stays reportable.
      hasData: anyMessage != null,
      // The minerals filter: saved by an admin, or still the suggestion. People
      // ever texted, by business line (not yet classified = unclassified).
      scopeSaved: cfg.scope != null,
      ...lineCounts(lines),
    });
  }),
);

/** Choices for the SMS filters: team members (incl. Automated / unassigned), tags, sources — of the scope's contacts. */
smsReportsRouter.get(
  "/filters",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const scope = parseReportScope(req.query.scope);
    const [row, tags, sources, senders, blanks] = await Promise.all([
      loadIntegration(org),
      prisma.$queryRaw<{ v: string }[]>(Prisma.sql`/* sms:filter-tags */
        SELECT DISTINCT unnest(c."tags") AS v FROM "HighLevelContact" c WHERE c."organizationId" = ${org} ${lineIn(scope)} LIMIT 2000`),
      prisma.$queryRaw<{ v: string }[]>(Prisma.sql`/* sms:filter-sources */
        SELECT DISTINCT btrim(c."source") AS v FROM "HighLevelContact" c
        WHERE c."organizationId" = ${org} AND coalesce(btrim(c."source"), '') <> '' ${lineIn(scope)} LIMIT 2000`),
      prisma.$queryRaw<{ v: string }[]>(Prisma.sql`/* sms:filter-senders */
        SELECT DISTINCT v FROM (
          SELECT c."creditedHlUserId" AS v FROM "HighLevelContact" c WHERE c."organizationId" = ${org}
          UNION SELECT c."assignedToHlUserId" FROM "HighLevelContact" c WHERE c."organizationId" = ${org}
        ) s WHERE v IS NOT NULL LIMIT 500`),
      prisma.$queryRaw<{ noTag: boolean | null; noSource: boolean | null }[]>(Prisma.sql`/* sms:filter-blanks */
        SELECT bool_or(coalesce(cardinality(c."tags"), 0) = 0) AS "noTag", bool_or(coalesce(btrim(c."source"), '') = '') AS "noSource"
        FROM "HighLevelContact" c WHERE c."organizationId" = ${org} ${lineIn(scope)}`),
    ]);
    const users: HlUser[] = readHlConfig(row?.config).hlUsers;
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
    const ids = [...new Set([...users.map((u) => u.id), ...senders.map((s) => s.v)])];
    res.json({
      senders: [
        ...ids.map((id) => ({ id, name: senderName(id, users) })).sort((a, b) => byName(a.name, b.name)),
        { id: NO_SENDER, name: UNASSIGNED_LABEL },
      ],
      tags: [...tags.map((t) => t.v).filter(Boolean).sort(byName), ...(blanks[0]?.noTag ? [NO_TAG] : [])],
      sources: [...sources.map((s) => s.v).sort(byName), ...(blanks[0]?.noSource ? [NO_SOURCE] : [])],
    });
  }),
);

/** Answered by a person whose HighLevel user id wasn't recorded. */
const NO_ANSWERER_LABEL = "Team member not recorded";

/** The SMS performance report. */
smsReportsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const now = new Date();
    const filters = parseSmsFilters(req.query);
    const scope = parseReportScope(req.query.scope);
    const [row, { range, compare }, phoneTags] = await Promise.all([
      loadIntegration(org), resolveRange(org, req.query, now), loadPhoneTags(org),
    ]);
    const cfg = readHlConfig(row?.config);
    const bucket = trendBucket(range);
    const pipelines = funnelPipelines(cfg, scope);
    // Still waiting is judged against now, for the comparison window too.
    const ctx = { pipelines, price: cfg.pricePerSegment, phoneTags, waitingSince: waitingSince(now, cfg.responseWindowDays) };
    const tz = reportTimeZone(cfg);

    const [cur, prev, trend, [bdCohort, bdVolume], quality, members, slots, split, health, health7, inboundFirst, summariesPending] =
      await Promise.all([
        periodData(org, range, filters, scope, ctx),
        compare ? periodData(org, compare, filters, scope, ctx) : null,
        trendPoints(org, range, filters, scope, bucket),
        breakdownGroups(org, range, filters, scope, phoneTags),
        qualityGroups(org, range, filters, scope, phoneTags),
        speedMembers(org, range, filters, scope),
        slotCounts(org, range, filters, scope, tz.timezone),
        lineSplit(org, range, filters),
        healthRows(org, range),
        healthLast7(org, now),
        inboundFirstCount(org, range, filters, scope),
        prisma.highLevelContact.count({ where: { organizationId: org, summaryDirty: true } }),
      ]);

    const counts = cohortCounts(cur.rows);
    const pick = <T extends { dim: Dim }>(rows: T[], dim: Dim) => rows.filter((x) => x.dim === dim);
    const users = cfg.hlUsers;
    const plain = (key: string) => key;
    const volumeOf = (dim: Dim): QualityVolumeGroup[] =>
      pick(bdVolume, dim).map((v) => ({ key: v.key, sent: v.textsSent, delivered: v.delivered ?? 0 }));
    const days = healthDays(range, health);

    res.json({
      range: rangeJson(range),
      compare: compare ? rangeJson(compare) : null,
      windowDays: cfg.responseWindowDays,
      scope,
      scopeInfo: {
        saved: cfg.scope != null,
        // People texted in this period by business line (the filters apply, the scope doesn't).
        texted: split,
      },
      kpis: cur.kpis,
      previous: prev?.kpis ?? null,
      deltas: prev ? smsDeltas(cur.kpis, prev.kpis) : null,
      deltaKind: DELTA_KIND,
      byTouch: touchRates(cur.rows, TOUCH_BUCKETS),
      trend: { bucket, points: trend },
      funnel: {
        ...cur.funnel,
        // null = every pipeline (All texting).
        pipelines: pipelines ? pipelines.map((id) => ({ id, name: pipelineName(cfg, id) })) : null,
        // HighLevel reports only an opportunity's current stage: stage moves
        // are known from the day the sync started watching.
        historySince: row?.connectedAt ?? null,
      },
      cost: cur.cost,
      speed: {
        ...cur.speed,
        byMember: members
          .map((m) => ({
            key: m.key ?? NO_SENDER,
            name: m.key ? senderName(m.key, users) : NO_ANSWERER_LABEL,
            answered: m.answered,
            medianSeconds: m.median == null ? null : Math.round(m.median),
            within1hRate: m.answered > 0 ? m.within1h / m.answered : null,
          }))
          .sort((a, b) => b.answered - a.answered || a.name.localeCompare(b.name)),
      },
      bestTime: { ...tz, minSample: BEST_TIME_MIN_SAMPLE, ...bestTimeGrid(slots) },
      phoneQuality: {
        tags: mergeQuality(pick(quality, "listTag"), volumeOf("listTag"), plain),
        sources: mergeQuality(pick(quality, "source"), volumeOf("source"), plain),
      },
      carrierHealth: {
        thresholds: { optOutRate: HEALTH_OPT_OUT_WARN, failureRate: HEALTH_FAILURE_WARN, minTexts: HEALTH_MIN_TEXTS },
        last7: healthOf(health7),
        ...days,
      },
      breakdowns: {
        senders: mergeBreakdown(pick(bdCohort, "sender"), pick(bdVolume, "sender"), (k) => senderName(k, users)),
        tags: mergeBreakdown(pick(bdCohort, "tag"), pick(bdVolume, "tag"), plain),
        sources: mergeBreakdown(pick(bdCohort, "source"), pick(bdVolume, "source"), plain),
      },
      notes: {
        reachedTexts: cur.rows.reduce((s, x) => s + x.texts, 0),
        unconfirmedTexts: cur.rows.reduce((s, x) => s + x.unconfirmed, 0),
        inboundFirstContacts: inboundFirst,
        lateReplies: counts.lateReplies,
        // Texts whose segments the sync hasn't counted yet (each costed as one).
        unknownSegments: cur.cost.unknownSegments,
        // Contacts whose summary is waiting to be recomputed by the sync (e.g.
        // right after the response window changed) — counted on the old rules until then.
        summariesPending,
      },
    });
  }),
);

// --- Drill-downs: who is behind a number (needs contact access) --------------

function requireContactAccess(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (hasPermission(req, "viewContacts")) return next();
  res.status(403).json({
    error: "Seeing the contacts behind these numbers needs the View contacts permission. Ask an admin to turn it on for your role.",
  });
}

interface DrillRow {
  hlId: string; name: string | null; phone: string | null; tags: string[] | null; source: string | null;
  senderId: string | null; firstOutboundAt: Date | null; touches: number | null; outcome: string | null;
  outcomeAt: Date | null; responseSeconds: number | null; smsOptedOut: boolean | null; deletedInHl: boolean | null;
  lastMessageAt?: Date | null; line?: string | null; wrongNumberAt?: Date | null; wrongNumberTouch?: number | null;
  replyAnsweredSeconds?: number | null; answeredBy?: string | null;
  oppN?: number | null; oppOffer?: boolean | null; oppAccepted?: boolean | null; oppContract?: boolean | null;
  oppClosed?: boolean | null; oppAlive?: number | null;
}
const DRILL_COLUMNS = Prisma.sql`c."name", c."phone", c."tags", c."source",
  coalesce(c."creditedHlUserId", c."assignedToHlUserId") AS "senderId", c."firstOutboundAt", c."touches", c."outcome",
  c."outcomeAt", c."responseSeconds", c."smsOptedOut", c."deletedInHl", c."lastMessageAt", c."line", c."wrongNumberAt",
  c."wrongNumberTouch", c."replyAnsweredSeconds", c."answeredByHlUserId" AS "answeredBy"`;
const FUNNEL_COLUMNS = Prisma.sql`, x.n AS "oppN", x.offer AS "oppOffer", x.accepted AS "oppAccepted", x.contract AS "oppContract",
  x.closed AS "oppClosed", x.alive AS "oppAlive"`;
const DRILL_ORDER = Prisma.sql`ORDER BY coalesce(c."firstOutboundAt", c."outcomeAt", c."lastMessageAt") DESC NULLS LAST`;

function shapeContact(r: DrillRow, users: readonly HlUser[]) {
  const furthest = r.oppN != null
    ? furthestStep({ n: r.oppN, offer: !!r.oppOffer, accepted: !!r.oppAccepted, contract: !!r.oppContract, closed: !!r.oppClosed, alive: r.oppAlive ?? 0 })
    : null;
  return {
    hlId: r.hlId,
    name: r.name,
    phone: r.phone,
    tags: r.tags ?? [],
    source: r.source,
    teamMember: senderName(r.senderId, users),
    firstTextedAt: r.firstOutboundAt,
    textsBeforeReply: r.touches ?? 0,
    outcome: r.outcome,
    outcomeAt: r.outcomeAt,
    responseSeconds: r.responseSeconds,
    optedOutInHl: r.smsOptedOut ?? false,
    deletedInHl: r.deletedInHl ?? false,
    lastTextedAt: r.lastMessageAt ?? null,
    line: r.line ?? null,
    wrongNumberAt: r.wrongNumberAt ?? null,
    wrongNumberTouch: r.wrongNumberTouch ?? null,
    answerSeconds: r.replyAnsweredSeconds ?? null,
    answeredBy: r.replyAnsweredSeconds == null ? null : r.answeredBy ? senderName(r.answeredBy, users) : NO_ANSWERER_LABEL,
    // Funnel lists only: the furthest step this person's opportunities reached.
    furthestStep: furthest?.step ?? null,
    oppDead: furthest?.dead ?? null,
  };
}

const intParam = (v: unknown, def: number, min: number, max: number) => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : def;
  return Math.min(max, Math.max(min, n));
};

/** A table row a drill narrows to (see domain drillRow), as a condition on contact `c`. */
function rowSql(row: { dim: DrillRowDim; key: string } | null, pt: PhoneTagSets): Prisma.Sql {
  if (!row) return Prisma.empty;
  const { dim, key } = row;
  if (dim === "sender") return Prisma.sql`AND coalesce(c."creditedHlUserId", c."assignedToHlUserId", ${NO_SENDER}) = ${key}`;
  if (dim === "source") return Prisma.sql`AND ${sourceKey("c")} = ${key}`;
  if (key === NO_TAG) {
    return dim === "tag" ? Prisma.sql`AND coalesce(cardinality(c."tags"), 0) = 0` : Prisma.sql`AND cardinality(${listTags(pt, "c")}) = 0`;
  }
  return Prisma.sql`AND c."tags" && ${[key]}::text[]`;
}

smsReportsRouter.get(
  "/contacts",
  requireContactAccess,
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const now = new Date();
    const q = req.query as Record<string, unknown>;
    const set = (DRILL_SETS as readonly string[]).includes(String(q.set)) ? (q.set as DrillSet) : null;
    if (!set) throw new HttpError(400, `set must be one of ${DRILL_SETS.join(", ")}`);
    const touch = q.touch == null ? null : intParam(q.touch, 1, 1, TOUCH_BUCKETS + 1);
    const limit = intParam(q.limit, 50, 1, 200);
    const offset = intParam(q.offset, 0, 0, 1_000_000);
    const filters = parseSmsFilters(q);
    const scope = parseReportScope(q.scope);
    const rowPick = drillRow(q);
    // The phone-tag groups, only for the lists that use them.
    const needsTags = set === "wrongNumber" || PHONE_SETS[set] != null || rowPick?.dim === "listTag";
    const [row, { range }, phoneTags] = await Promise.all([
      loadIntegration(org), resolveRange(org, q, now), needsTags ? loadPhoneTags(org) : phoneTagSets([]),
    ]);
    const narrow = rowSql(rowPick, phoneTags);
    const cfg = readHlConfig(row?.config);
    const users = cfg.hlUsers;

    // Text n: "replied after text n" for the replied list (n or later for the
    // last bucket), "got text n" for every other list.
    const touchSql = touch == null ? Prisma.empty
      : set === "responded"
        ? (touch > TOUCH_BUCKETS ? Prisma.sql`AND c."touches" >= ${touch}` : Prisma.sql`AND c."touches" = ${touch}`)
        : Prisma.sql`AND c."touches" >= ${touch}`;

    let count: Prisma.Sql, page: Prisma.Sql;
    if (TEXTED_SETS.includes(set)) {
      // Starts from the messages, so it matches "Contacts texted" even for a
      // message whose contact details haven't been fetched yet. The two
      // business-line lists are about the people OUTSIDE minerals, so they
      // ignore the scope (like the counts they come from).
      const lineSql = set === "unclassified" ? Prisma.sql`AND coalesce(c."line", 'unclassified') NOT IN ('minerals', 'real_estate')`
        : set === "realEstate" ? Prisma.sql`AND c."line" = 'real_estate'` : Prisma.empty;
      const texted = Prisma.sql`SELECT DISTINCT m."hlContactId" AS "hlId"
        ${messagesIn(org, range, filters, set === "texted" ? scope : "all")} AND ${OUTBOUND} AND ${SENT}`;
      const joined = Prisma.sql`FROM (${texted}) x LEFT JOIN "HighLevelContact" c ON c."organizationId" = ${org} AND c."hlId" = x."hlId"
        WHERE TRUE ${touchSql} ${lineSql} ${narrow}`;
      count = Prisma.sql`/* sms:drill-count */ SELECT count(*)::int AS n ${joined}`;
      page = Prisma.sql`/* sms:drill */ SELECT x."hlId" AS "hlId", ${DRILL_COLUMNS} ${joined}
        ${DRILL_ORDER}, x."hlId" LIMIT ${limit} OFFSET ${offset}`;
    } else {
      const funnel = FUNNEL_SETS.includes(set);
      const base = set === "inboundFirst" ? inboundFirstIn(org, range, filters, scope)
        : cohortIn(org, range, filters, scope, funnel ? oppLateral(org, funnelPipelines(cfg, scope)) : Prisma.empty);
      const outcome: Partial<Record<DrillSet, SmsOutcome>> = {
        responded: "RESPONDED", optedOut: "OPTED_OUT", noReply: "NO_REPLY", lateReply: "LATE_REPLY",
      };
      const phone = PHONE_SETS[set];
      const cond = outcome[set] ? Prisma.sql`AND ${outcomeIs(outcome[set]!)}`
        : set === "stillWaiting" ? Prisma.sql`AND ${stillWaitingSql(org, waitingSince(now, cfg.responseWindowDays))}`
        : set === "wrongNumber" ? Prisma.sql`AND ${wrongNumberSql(phoneTags)}`
        : set === "unanswered" ? Prisma.sql`AND ${outcomeIs("RESPONDED")} AND c."replyAnsweredSeconds" IS NULL`
        : funnel ? Prisma.sql`AND ${FUNNEL_COND[set]}`
        : phone ? Prisma.sql`AND ${hasAnyTag(phoneTags[phone])}`
        : Prisma.empty; // reached, inboundFirst
      const where = Prisma.sql`${base} ${cond} ${touchSql} ${narrow}`;
      count = Prisma.sql`/* sms:drill-count */ SELECT count(*)::int AS n ${where}`;
      page = Prisma.sql`/* sms:drill */ SELECT c."hlId" AS "hlId", ${DRILL_COLUMNS} ${funnel ? FUNNEL_COLUMNS : Prisma.empty} ${where}
        ${DRILL_ORDER}, c."hlId" LIMIT ${limit} OFFSET ${offset}`;
    }
    const [totalRows, rows] = await Promise.all([
      prisma.$queryRaw<{ n: number }[]>(count),
      prisma.$queryRaw<DrillRow[]>(page),
    ]);
    res.json({ total: totalRows[0]?.n ?? 0, limit, offset, rows: rows.map((r) => shapeContact(r, users)) });
  }),
);

const MAX_TIMELINE = 1000;

/** One contact's SMS timeline: when, which way, delivery status, who/what sent it. No message wording is stored. */
smsReportsRouter.get(
  "/contacts/:hlId/messages",
  requireContactAccess,
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const hlId = String(req.params.hlId ?? "").slice(0, 200);
    const [row, contact, messages] = await Promise.all([
      loadIntegration(org),
      prisma.highLevelContact.findUnique({ where: { organizationId_hlId: { organizationId: org, hlId } } }),
      // The most recent MAX_TIMELINE texts (shown oldest first).
      prisma.highLevelMessage.findMany({
        where: { organizationId: org, hlContactId: hlId },
        orderBy: { sentAt: "desc" },
        take: MAX_TIMELINE,
        select: { sentAt: true, direction: true, status: true, source: true, hlUserId: true, messageType: true, wrongNumber: true, optOut: true },
      }),
    ]);
    if (!contact && messages.length === 0) throw new HttpError(404, "Contact not found");
    const users = readHlConfig(row?.config).hlUsers;
    res.json({
      contact: shapeContact({
        hlId,
        name: contact?.name ?? null, phone: contact?.phone ?? null, tags: contact?.tags ?? [], source: contact?.source ?? null,
        senderId: contact?.creditedHlUserId ?? contact?.assignedToHlUserId ?? null,
        firstOutboundAt: contact?.firstOutboundAt ?? null, touches: contact?.touches ?? 0, outcome: contact?.outcome ?? null,
        outcomeAt: contact?.outcomeAt ?? null, responseSeconds: contact?.responseSeconds ?? null,
        smsOptedOut: contact?.smsOptedOut ?? false, deletedInHl: contact?.deletedInHl ?? false, lastMessageAt: contact?.lastMessageAt ?? null,
        line: contact?.line ?? null, wrongNumberAt: contact?.wrongNumberAt ?? null, wrongNumberTouch: contact?.wrongNumberTouch ?? null,
        replyAnsweredSeconds: contact?.replyAnsweredSeconds ?? null, answeredBy: contact?.answeredByHlUserId ?? null,
      }, users),
      messages: messages.reverse().map((m) => ({
        sentAt: m.sentAt,
        direction: m.direction,
        status: m.status,
        // How the text counts, per the same helpers the summaries use.
        statusKind: m.direction === "inbound" ? "received"
          : isPendingStatus(m.status) ? "pending"
          : isFailedStatus(m.status) ? "failed"
          : isDeliveredStatus(m.status) ? "delivered" : "unconfirmed",
        source: m.source,
        messageType: m.messageType,
        // The person who sent it; null = sent by an automation (or the contact, for inbound).
        sender: m.hlUserId ? senderName(m.hlUserId, users) : null,
        // Inbound only: how the reply was read (the wording itself is never stored).
        replyKind: m.direction !== "inbound" ? null : m.optOut ? "optOut" : m.wrongNumber ? "wrongNumber" : "reply",
      })),
      truncated: messages.length === MAX_TIMELINE,
    });
  }),
);
