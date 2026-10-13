/**
 * Reports → SMS performance (read-only). Aggregates the HighLevel mirror
 * tables (HighLevelMessage / HighLevelContact, filled by the HighLevel sync)
 * in Postgres. Nothing here writes: the sync owns those rows and the
 * Integration row.
 *
 *  - Volume figures (texts sent / delivered / failed, replies, contacts
 *    texted, the trend) are dated by each message's sentAt.
 *  - Response figures (reached, replied, opt-outs, time to first reply, the
 *    by-text-number chart) come from the per-contact summaries computed by
 *    domain/smsMetrics.ts summarizeContact(), dated by the contact's first
 *    reached text (firstOutboundAt) — the response cohort.
 *  - Team member of a message = its sender, else the contact's assignee;
 *    of a contact's response = whoever sent their first reached text, else
 *    the assignee. Null = "Automated / unassigned".
 *
 * Status SQL is built from the status lists exported by smsMetrics.ts, so a
 * status means the same thing here as in the summaries. Every query is scoped
 * to the caller's org and leans on the (organizationId, sentAt) and
 * (organizationId, firstOutboundAt) indexes.
 */
import { Router, type NextFunction, type Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, hasPermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import {
  DELIVERED_STATUSES, FAILED_STATUSES, PENDING_STATUSES, TOUCH_BUCKETS, touchRates,
  isDeliveredStatus, isFailedStatus, isPendingStatus, type SmsOutcome, type TouchOutcomeCount,
} from "../domain/smsMetrics.js";
import {
  DELTA_KIND, DRILL_SETS, NO_SENDER, NO_SOURCE, NO_TAG, UNASSIGNED_LABEL,
  allRange, cohortCounts, computeKpis, fillTrend, mergeBreakdown, parseSmsFilters, rangeJson, readHlConfig,
  requestedPeriod, senderName, smsDeltas, trendBucket,
  type CohortGroup, type DayRange, type DrillSet, type HlUser, type SmsFilters, type SmsKpis, type TrendBucket,
  type TrendPoint, type VolumeGroup,
} from "../domain/smsReport.js";

export const smsReportsRouter = Router();
smsReportsRouter.use(requireAuth, requireOrg, requirePermission("viewReports"));

const PROVIDER = "highlevel";

// --- SQL building blocks -----------------------------------------------------

const OUTBOUND = Prisma.sql`m."direction" = 'outbound'`;
const INBOUND = Prisma.sql`m."direction" = 'inbound'`;
/** The status column normalized like smsMetrics' norm(). */
const STATUS = Prisma.sql`lower(btrim(coalesce(m."status", '')))`;
const SENT = Prisma.sql`NOT (${STATUS} = ANY(${[...PENDING_STATUSES]}::text[]))`;
const DELIVERED = Prisma.sql`${STATUS} = ANY(${[...DELIVERED_STATUSES]}::text[])`;
const FAILED = Prisma.sql`${STATUS} = ANY(${[...FAILED_STATUSES]}::text[])`;
const outcomeIs = (o: SmsOutcome, alias = "c") => Prisma.sql`${Prisma.raw(`${alias}."outcome"`)} = ${o}`;

/** A UTC instant as a timestamp literal (the columns are timestamp without time zone, stored in UTC). */
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

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

/** Messages `m` of the org sent in the range, matching the filters. Joins
 *  their contact `c` when a filter (or `withContact`) needs it. */
function messagesIn(org: string, r: DayRange, f: SmsFilters, withContact = false): Prisma.Sql {
  const join = withContact || hasFilters(f)
    ? Prisma.sql`LEFT JOIN "HighLevelContact" c ON c."organizationId" = m."organizationId" AND c."hlId" = m."hlContactId"`
    : Prisma.empty;
  return Prisma.sql`FROM "HighLevelMessage" m ${join}
    WHERE m."organizationId" = ${org} AND m."sentAt" >= ${ts(r.from)} AND m."sentAt" < ${ts(r.toExclusive)}
    ${hasFilters(f) ? filterSql(f, messageSender) : Prisma.empty}`;
}

/** The response cohort: contacts `c` of the org first reached in the range, matching the filters. */
function cohortIn(org: string, r: DayRange, f: SmsFilters): Prisma.Sql {
  return Prisma.sql`FROM "HighLevelContact" c
    WHERE c."organizationId" = ${org} AND c."firstOutboundAt" >= ${ts(r.from)} AND c."firstOutboundAt" < ${ts(r.toExclusive)}
    ${filterSql(f, contactSender)}`;
}

/** Contacts `c` who texted first, dated by that first inbound text. */
function inboundFirstIn(org: string, r: DayRange, f: SmsFilters): Prisma.Sql {
  return Prisma.sql`FROM "HighLevelContact" c
    WHERE c."organizationId" = ${org} AND ${outcomeIs("INBOUND_FIRST")}
      AND c."outcomeAt" >= ${ts(r.from)} AND c."outcomeAt" < ${ts(r.toExclusive)}
    ${filterSql(f, contactSender)}`;
}

/** A contact's tags as rows (DISTINCT: a tag listed twice counts once); none → "(no tag)". */
const tagRows = (alias: string) =>
  Prisma.sql`CROSS JOIN LATERAL (SELECT DISTINCT unnest(CASE WHEN coalesce(cardinality(${Prisma.raw(`${alias}."tags"`)}), 0) = 0
    THEN ARRAY[${NO_TAG}]::text[] ELSE ${Prisma.raw(`${alias}."tags"`)} END) AS tag) t`;
const sourceKey = (alias: string) => Prisma.sql`coalesce(nullif(btrim(${Prisma.raw(`${alias}."source"`)}), ''), ${NO_SOURCE})`;

// --- Queries ------------------------------------------------------------------

interface VolumeRow { sent: number; delivered: number; failed: number; inbound: number; contactsTexted: number }

async function volumeTotals(org: string, r: DayRange, f: SmsFilters): Promise<VolumeRow> {
  const rows = await prisma.$queryRaw<VolumeRow[]>(Prisma.sql`/* sms:volume */
    SELECT count(*) FILTER (WHERE ${OUTBOUND} AND ${SENT})::int AS sent,
      count(*) FILTER (WHERE ${OUTBOUND} AND ${DELIVERED})::int AS delivered,
      count(*) FILTER (WHERE ${OUTBOUND} AND ${FAILED})::int AS failed,
      count(*) FILTER (WHERE ${INBOUND})::int AS inbound,
      count(DISTINCT m."hlContactId") FILTER (WHERE ${OUTBOUND} AND ${SENT})::int AS "contactsTexted"
    ${messagesIn(org, r, f)}`);
  return rows[0] ?? { sent: 0, delivered: 0, failed: 0, inbound: 0, contactsTexted: 0 };
}

async function trendPoints(org: string, r: DayRange, f: SmsFilters, bucket: TrendBucket): Promise<TrendPoint[]> {
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
      ${messagesIn(org, r, f)}
      GROUP BY 1
    ) b`);
  return fillTrend(r, bucket, rows);
}

interface CohortRow extends TouchOutcomeCount { unconfirmed: number; texts: number }

async function cohortRows(org: string, r: DayRange, f: SmsFilters): Promise<CohortRow[]> {
  return prisma.$queryRaw<CohortRow[]>(Prisma.sql`/* sms:cohort */
    SELECT c."touches" AS touches, c."outcome" AS outcome, count(*)::int AS count,
      coalesce(sum(c."unconfirmedTouches"), 0)::int AS unconfirmed, coalesce(sum(c."touches"), 0)::int AS texts
    ${cohortIn(org, r, f)}
    GROUP BY 1, 2`);
}

async function responseTimes(org: string, r: DayRange, f: SmsFilters): Promise<{ avg: number | null; median: number | null }> {
  const rows = await prisma.$queryRaw<{ avg: number | null; median: number | null }[]>(Prisma.sql`/* sms:times */
    SELECT avg(c."responseSeconds")::float8 AS avg,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY c."responseSeconds")::float8 AS median
    ${cohortIn(org, r, f)} AND ${outcomeIs("RESPONDED")} AND c."responseSeconds" IS NOT NULL`);
  return rows[0] ?? { avg: null, median: null };
}

async function inboundFirstCount(org: string, r: DayRange, f: SmsFilters): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>(Prisma.sql`/* sms:inbound-first */
    SELECT count(*)::int AS n ${inboundFirstIn(org, r, f)}`);
  return rows[0]?.n ?? 0;
}

/** KPIs for one period, plus the cohort rows they came from. */
async function periodKpis(org: string, r: DayRange, f: SmsFilters): Promise<{ kpis: SmsKpis; rows: CohortRow[] }> {
  const [v, rows, times] = await Promise.all([volumeTotals(org, r, f), cohortRows(org, r, f), responseTimes(org, r, f)]);
  const c = cohortCounts(rows);
  const kpis = computeKpis(v, {
    reached: c.reached, responded: c.responded, optedOut: c.optedOut,
    avgSeconds: times.avg == null ? null : Math.round(times.avg),
    medianSeconds: times.median == null ? null : Math.round(times.median),
  });
  return { kpis, rows };
}

type Dim = "sender" | "tag" | "source";

async function breakdownGroups(org: string, r: DayRange, f: SmsFilters) {
  const agg = Prisma.sql`count(*)::int AS reached,
    count(*) FILTER (WHERE ${outcomeIs("RESPONDED", "k")})::int AS responded,
    count(*) FILTER (WHERE ${outcomeIs("OPTED_OUT", "k")})::int AS "optedOut",
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY k."responseSeconds") FILTER (WHERE ${outcomeIs("RESPONDED", "k")}))::float8 AS median`;
  const cohort = prisma.$queryRaw<(CohortGroup & { dim: Dim })[]>(Prisma.sql`/* sms:bd-cohort */
    WITH k AS (
      SELECT c."creditedHlUserId", c."assignedToHlUserId", c."tags", c."source", c."outcome", c."responseSeconds"
      ${cohortIn(org, r, f)}
    )
    SELECT 'sender' AS dim, coalesce(k."creditedHlUserId", k."assignedToHlUserId", ${NO_SENDER}) AS key, ${agg} FROM k GROUP BY 2
    UNION ALL
    SELECT 'tag' AS dim, t.tag AS key, ${agg} FROM k ${tagRows("k")} GROUP BY 2
    UNION ALL
    SELECT 'source' AS dim, ${sourceKey("k")} AS key, ${agg} FROM k GROUP BY 2`);
  // Texts sent: aggregated first on (team member, tag list, source) — a few
  // hundred combinations, not one row per contact — then rolled up per
  // dimension. Tags are unnested only on those few rows.
  const volume = prisma.$queryRaw<(VolumeGroup & { dim: Dim })[]>(Prisma.sql`/* sms:bd-volume */
    WITH g AS (
      SELECT ${messageSender} AS sender, c."tags", c."source", count(*)::int AS sent
      ${messagesIn(org, r, f, true)} AND ${OUTBOUND} AND ${SENT}
      GROUP BY 1, 2, 3
    )
    SELECT 'sender' AS dim, coalesce(g.sender, ${NO_SENDER}) AS key, sum(g.sent)::int AS "textsSent" FROM g GROUP BY 2
    UNION ALL
    SELECT 'tag' AS dim, t.tag AS key, sum(g.sent)::int AS "textsSent" FROM g ${tagRows("g")} GROUP BY 2
    UNION ALL
    SELECT 'source' AS dim, ${sourceKey("g")} AS key, sum(g.sent)::int AS "textsSent" FROM g GROUP BY 2`);
  return Promise.all([cohort, volume]);
}

async function loadIntegration(org: string) {
  return prisma.integration.findUnique({
    where: { organizationId_provider: { organizationId: org, provider: PROVIDER } },
    select: { status: true, config: true, lastSyncAt: true, lastError: true },
  });
}

// --- Routes ---------------------------------------------------------------------

/** Connection state for the SMS view's banners. */
smsReportsRouter.get(
  "/status",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const [row, anyMessage] = await Promise.all([
      loadIntegration(org),
      prisma.highLevelMessage.findFirst({ where: { organizationId: org }, select: { id: true } }),
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
    });
  }),
);

/** Choices for the SMS filters: team members (incl. Automated / unassigned), tags, sources. */
smsReportsRouter.get(
  "/filters",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const [row, tags, sources, senders, blanks] = await Promise.all([
      loadIntegration(org),
      prisma.$queryRaw<{ v: string }[]>(Prisma.sql`/* sms:filter-tags */
        SELECT DISTINCT unnest(c."tags") AS v FROM "HighLevelContact" c WHERE c."organizationId" = ${org} LIMIT 2000`),
      prisma.$queryRaw<{ v: string }[]>(Prisma.sql`/* sms:filter-sources */
        SELECT DISTINCT btrim(c."source") AS v FROM "HighLevelContact" c
        WHERE c."organizationId" = ${org} AND coalesce(btrim(c."source"), '') <> '' LIMIT 2000`),
      prisma.$queryRaw<{ v: string }[]>(Prisma.sql`/* sms:filter-senders */
        SELECT DISTINCT v FROM (
          SELECT c."creditedHlUserId" AS v FROM "HighLevelContact" c WHERE c."organizationId" = ${org}
          UNION SELECT c."assignedToHlUserId" FROM "HighLevelContact" c WHERE c."organizationId" = ${org}
        ) s WHERE v IS NOT NULL LIMIT 500`),
      prisma.$queryRaw<{ noTag: boolean | null; noSource: boolean | null }[]>(Prisma.sql`/* sms:filter-blanks */
        SELECT bool_or(coalesce(cardinality(c."tags"), 0) = 0) AS "noTag", bool_or(coalesce(btrim(c."source"), '') = '') AS "noSource"
        FROM "HighLevelContact" c WHERE c."organizationId" = ${org}`),
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

/** The SMS performance report. */
smsReportsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = orgId(req);
    const now = new Date();
    const filters = parseSmsFilters(req.query);
    const asked = requestedPeriod(req.query, now);
    const [row, span] = await Promise.all([
      loadIntegration(org),
      asked.all
        ? prisma.highLevelMessage.aggregate({ where: { organizationId: org }, _min: { sentAt: true }, _max: { sentAt: true } })
        : null,
    ]);
    const cfg = readHlConfig(row?.config);
    const range = asked.all ? allRange(span?._min.sentAt ?? null, span?._max.sentAt ?? null, now) : asked.range;
    // Nothing precedes "All", so it never compares.
    const compare = asked.all ? null : asked.compare;
    const bucket = trendBucket(range);

    const [cur, prev, trend, [bdCohort, bdVolume], inboundFirst, summariesPending] = await Promise.all([
      periodKpis(org, range, filters),
      compare ? periodKpis(org, compare, filters) : null,
      trendPoints(org, range, filters, bucket),
      breakdownGroups(org, range, filters),
      inboundFirstCount(org, range, filters),
      prisma.highLevelContact.count({ where: { organizationId: org, summaryDirty: true } }),
    ]);

    const counts = cohortCounts(cur.rows);
    const pick = <T extends { dim: Dim }>(rows: T[], dim: Dim) => rows.filter((x) => x.dim === dim);
    const users = cfg.hlUsers;
    const plain = (key: string) => key;

    res.json({
      range: rangeJson(range),
      compare: compare ? rangeJson(compare) : null,
      windowDays: cfg.responseWindowDays,
      kpis: cur.kpis,
      previous: prev?.kpis ?? null,
      deltas: prev ? smsDeltas(cur.kpis, prev.kpis) : null,
      deltaKind: DELTA_KIND,
      byTouch: touchRates(cur.rows, TOUCH_BUCKETS),
      trend: { bucket, points: trend },
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
}
const DRILL_COLUMNS = Prisma.sql`c."name", c."phone", c."tags", c."source",
  coalesce(c."creditedHlUserId", c."assignedToHlUserId") AS "senderId", c."firstOutboundAt", c."touches", c."outcome",
  c."outcomeAt", c."responseSeconds", c."smsOptedOut", c."deletedInHl"`;
const DRILL_ORDER = Prisma.sql`ORDER BY coalesce(c."firstOutboundAt", c."outcomeAt", c."lastMessageAt") DESC NULLS LAST`;

function shapeContact(r: DrillRow, users: readonly HlUser[]) {
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
  };
}

const intParam = (v: unknown, def: number, min: number, max: number) => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : def;
  return Math.min(max, Math.max(min, n));
};

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
    const asked = requestedPeriod(q, now);
    const [row, span] = await Promise.all([
      loadIntegration(org),
      asked.all
        ? prisma.highLevelMessage.aggregate({ where: { organizationId: org }, _min: { sentAt: true }, _max: { sentAt: true } })
        : null,
    ]);
    const users = readHlConfig(row?.config).hlUsers;
    const range = asked.all ? allRange(span?._min.sentAt ?? null, span?._max.sentAt ?? null, now) : asked.range;

    // Text n: "replied after text n" for the replied list (n or later for the
    // last bucket), "got text n" for every other list.
    const touchSql = touch == null ? Prisma.empty
      : set === "responded"
        ? (touch > TOUCH_BUCKETS ? Prisma.sql`AND c."touches" >= ${touch}` : Prisma.sql`AND c."touches" = ${touch}`)
        : Prisma.sql`AND c."touches" >= ${touch}`;

    let count: Prisma.Sql, page: Prisma.Sql;
    if (set === "texted") {
      // Starts from the messages, so it matches "Contacts texted" even for a
      // message whose contact details haven't been fetched yet.
      const texted = Prisma.sql`SELECT DISTINCT m."hlContactId" AS "hlId" ${messagesIn(org, range, filters)} AND ${OUTBOUND} AND ${SENT}`;
      const joined = Prisma.sql`FROM (${texted}) x LEFT JOIN "HighLevelContact" c ON c."organizationId" = ${org} AND c."hlId" = x."hlId"
        WHERE TRUE ${touch == null ? Prisma.empty : touchSql}`;
      count = Prisma.sql`/* sms:drill-count */ SELECT count(*)::int AS n ${joined}`;
      page = Prisma.sql`/* sms:drill */ SELECT x."hlId" AS "hlId", ${DRILL_COLUMNS} ${joined}
        ${DRILL_ORDER}, x."hlId" LIMIT ${limit} OFFSET ${offset}`;
    } else {
      const base = set === "inboundFirst" ? inboundFirstIn(org, range, filters) : cohortIn(org, range, filters);
      const outcome: Record<Exclude<DrillSet, "texted" | "reached" | "inboundFirst">, SmsOutcome> = {
        responded: "RESPONDED", optedOut: "OPTED_OUT", noReply: "NO_REPLY", lateReply: "LATE_REPLY",
      };
      const outcomeSql = set === "reached" || set === "inboundFirst" ? Prisma.empty : Prisma.sql`AND ${outcomeIs(outcome[set])}`;
      count = Prisma.sql`/* sms:drill-count */ SELECT count(*)::int AS n ${base} ${outcomeSql} ${touchSql}`;
      page = Prisma.sql`/* sms:drill */ SELECT c."hlId" AS "hlId", ${DRILL_COLUMNS} ${base} ${outcomeSql} ${touchSql}
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
        select: { sentAt: true, direction: true, status: true, source: true, hlUserId: true, messageType: true },
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
        smsOptedOut: contact?.smsOptedOut ?? false, deletedInHl: contact?.deletedInHl ?? false,
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
      })),
      truncated: messages.length === MAX_TIMELINE,
    });
  }),
);
