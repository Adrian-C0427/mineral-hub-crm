/**
 * HighLevel (LeadConnector) API client. Reads (GET) everything the sync
 * needs; the ONLY writes are adding / removing tags on a contact
 * (addContactTags / removeContactTags), used solely for Mineral Hub's own
 * SMS / Acquisition tags when the owner turns that on (domain/smsTags.ts).
 * Both are idempotent in HighLevel, so retrying them is safe.
 *
 * Built for long unattended syncs against a rate-limited API:
 *  - Version header per endpoint family (conversations 2021-04-15, the rest
 *    2021-07-28), 30 s timeout per request.
 *  - Client-side throttle well under HighLevel's 100 requests / 10 s burst
 *    limit, plus a pause whenever X-RateLimit-Remaining runs low.
 *  - 429 → wait (Retry-After, else the advertised interval) and retry;
 *    5xx / network / timeout → exponential backoff; at most 4 attempts.
 *  - Daily budget awareness: X-RateLimit-Daily-Remaining is tracked so the
 *    sync can stop before it starves the account's 200,000 / day allowance.
 *  - Failures surface as HighLevelError with a `kind` and a message that is
 *    safe to show a user. The token is only ever placed in the Authorization
 *    header — it is never logged or included in an error.
 *
 * fetch / sleep / now are injectable so retry and throttle behavior is unit
 * tested without a network or real waits (client.test.ts).
 */
import { env } from "../../config.js";

export const HIGHLEVEL_DEFAULT_BASE = "https://services.leadconnectorhq.com";
const VERSION_CONVERSATIONS = "2021-04-15";
const VERSION_DEFAULT = "2021-07-28";

/**
 * The API base. HIGHLEVEL_API_BASE (a local mock) is honored only outside
 * production, so a stray env var can never send an org's key to another host.
 */
export function resolveHighLevelBase(nodeEnv: string, override: string | null | undefined): string {
  const o = (override ?? "").trim().replace(/\/+$/, "");
  if (nodeEnv === "production" || !o) return HIGHLEVEL_DEFAULT_BASE;
  return o;
}

export type HighLevelErrorKind = "auth" | "notFound" | "rateLimit" | "server" | "network" | "badRequest";

/** Shown on the card and stored as lastError when HighLevel refuses the key. */
export const HL_AUTH_MESSAGE = "HighLevel rejected the key — it may have been rotated or deleted. Reconnect with a new key.";

const USER_MESSAGES: Record<HighLevelErrorKind, string> = {
  auth: HL_AUTH_MESSAGE,
  notFound: "HighLevel couldn't find that record.",
  rateLimit: "HighLevel is limiting how fast we can read right now. The sync will pick up again automatically.",
  server: "HighLevel is having trouble right now. The sync will try again automatically.",
  network: "Couldn't reach HighLevel. The sync will try again automatically.",
  badRequest: "HighLevel refused the request.",
};

export class HighLevelError extends Error {
  readonly kind: HighLevelErrorKind;
  /** HTTP status, or null for network failures / timeouts. */
  readonly status: number | null;
  /** HighLevel's own error text (for logs and message mapping) — never contains the token. */
  readonly detail: string | null;
  /** For rateLimit: how long HighLevel asked us to wait. */
  readonly retryAfterMs: number | null;
  constructor(kind: HighLevelErrorKind, opts: { status?: number | null; detail?: string | null; retryAfterMs?: number | null } = {}) {
    super(USER_MESSAGES[kind]);
    this.name = "HighLevelError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.detail = opts.detail ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

// --- Response shapes (only the fields the sync reads) -------------------------

export interface HlLocation { id: string; name?: string | null; timezone?: string | null }
export interface HlUser {
  id: string; name?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null; deleted?: boolean;
}
export interface HlMessage {
  id: string;
  contactId?: string | null;
  conversationId?: string | null;
  dateAdded?: string | null;
  direction?: string | null;
  status?: string | null;
  messageType?: string | null;
  source?: string | null;
  userId?: string | null;
  /** Read only to detect opt-out replies; never stored. */
  body?: string | null;
}
export interface HlExportPage { messages: HlMessage[]; nextCursor: string | null; total: number }
export interface HlContact {
  id: string;
  name?: string | null; firstName?: string | null; lastName?: string | null; contactName?: string | null;
  phone?: string | null; email?: string | null; source?: string | null; tags?: string[] | null;
  assignedTo?: string | null; dnd?: boolean | null;
  dndSettings?: { SMS?: { status?: string | null } | null } | null;
  dateAdded?: string | null; dateUpdated?: string | null;
}

export interface HlOpportunity {
  id: string;
  name?: string | null;
  monetaryValue?: number | null;
  pipelineId?: string | null;
  pipelineStageId?: string | null;
  assignedTo?: string | null;
  status?: string | null;
  source?: string | null;
  lastStatusChangeAt?: string | null;
  lastStageChangeAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  contactId?: string | null;
  contact?: { id?: string | null } | null;
}
export interface HlOpportunityPage {
  opportunities: HlOpportunity[];
  meta: { total: number | null; startAfter: number | null; startAfterId: string | null; nextPage: number | null };
}
export interface HlPipeline { id: string; name?: string | null; stages?: { id?: string | null; name?: string | null; position?: number | null }[] | null }
export interface HlTag { id?: string | null; name?: string | null }

export interface ExportParams {
  locationId: string;
  channel?: "SMS";
  limit?: number;
  cursor?: string;
  sortBy?: "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
  startDate?: string;
  endDate?: string;
}

export interface HighLevelClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  /** Total tries per request (first try + retries). */
  maxAttempts?: number;
  /** Throttle: at most windowMax requests per windowMs (HighLevel allows 100 / 10 s). */
  windowMax?: number;
  windowMs?: number;
  /** Longest 429 wait taken inside a request; longer asks surface as a rateLimit error. */
  maxRetryWaitMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DEFAULT_INTERVAL_MS = 10_000;
/** Pause when HighLevel says this few burst requests remain in its window. */
const LOW_BURST_REMAINING = 5;
/** Below this many requests left today, the sync stops and leaves room for everyone else. */
export const DAILY_RESERVE = 2_000;

const num = (v: string | null): number | null => {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export class HighLevelClient {
  private readonly token: string;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly windowMax: number;
  private readonly windowMs: number;
  private readonly maxRetryWaitMs: number;
  private stamps: number[] = [];
  private pauseUntil = 0;
  /** Requests HighLevel says remain today (null until a response reports it). */
  dailyRemaining: number | null = null;
  /** Requests sent (including retries), for run statistics and tests. */
  requests = 0;

  constructor(opts: HighLevelClientOptions) {
    this.token = opts.token;
    this.base = (opts.baseUrl ?? resolveHighLevelBase(env.NODE_ENV, env.HIGHLEVEL_API_BASE)).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.windowMax = opts.windowMax ?? 50;
    this.windowMs = opts.windowMs ?? DEFAULT_INTERVAL_MS;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 60_000;
  }

  /** True when today's remaining request budget is nearly spent. */
  get dailyBudgetLow(): boolean {
    return this.dailyRemaining != null && this.dailyRemaining < DAILY_RESERVE;
  }

  // --- Endpoints -----------------------------------------------------------

  async getLocation(locationId: string): Promise<HlLocation> {
    const r = await this.get<{ location?: HlLocation }>(`/locations/${encodeURIComponent(locationId)}`, {}, VERSION_DEFAULT);
    if (!r.location?.id) throw new HighLevelError("notFound", { status: 200, detail: "location missing from response" });
    return r.location;
  }

  async listUsers(locationId: string): Promise<HlUser[]> {
    const r = await this.get<{ users?: HlUser[] }>("/users/", { locationId }, VERSION_DEFAULT);
    return Array.isArray(r.users) ? r.users : [];
  }

  async exportMessages(p: ExportParams): Promise<HlExportPage> {
    const r = await this.get<{ messages?: HlMessage[]; nextCursor?: string | null; total?: number }>(
      "/conversations/messages/export",
      {
        locationId: p.locationId, channel: p.channel, limit: p.limit, cursor: p.cursor,
        sortBy: p.sortBy, sortOrder: p.sortOrder, startDate: p.startDate, endDate: p.endDate,
      },
      VERSION_CONVERSATIONS,
    );
    const messages = Array.isArray(r.messages) ? r.messages : [];
    return { messages, nextCursor: r.nextCursor || null, total: typeof r.total === "number" ? r.total : messages.length };
  }

  /**
   * One page of opportunities, every status. Paged by HighLevel's
   * startAfter + startAfterId cursor (a createdAt timestamp and an id, so —
   * unlike the message export cursor — it is safe to keep between runs).
   */
  async searchOpportunities(p: { locationId: string; limit: number; startAfter?: number | null; startAfterId?: string | null }): Promise<HlOpportunityPage> {
    const r = await this.get<{ opportunities?: HlOpportunity[]; meta?: Record<string, unknown> }>(
      "/opportunities/search",
      {
        location_id: p.locationId, status: "all", limit: p.limit,
        startAfter: p.startAfter ?? undefined, startAfterId: p.startAfterId ?? undefined,
      },
      VERSION_DEFAULT,
    );
    const m = r.meta ?? {};
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      opportunities: Array.isArray(r.opportunities) ? r.opportunities : [],
      meta: {
        total: n(m.total),
        startAfter: n(m.startAfter),
        startAfterId: typeof m.startAfterId === "string" && m.startAfterId ? m.startAfterId : null,
        nextPage: n(m.nextPage),
      },
    };
  }

  async listPipelines(locationId: string): Promise<HlPipeline[]> {
    const r = await this.get<{ pipelines?: HlPipeline[] }>("/opportunities/pipelines", { locationId }, VERSION_DEFAULT);
    return Array.isArray(r.pipelines) ? r.pipelines : [];
  }

  async listTags(locationId: string): Promise<HlTag[]> {
    const r = await this.get<{ tags?: HlTag[] }>(`/locations/${encodeURIComponent(locationId)}/tags`, {}, VERSION_DEFAULT);
    return Array.isArray(r.tags) ? r.tags : [];
  }

  /** Add tags to a contact (needs contacts.write). Adding a tag it already has is a no-op. */
  async addContactTags(contactId: string, tags: readonly string[]): Promise<void> {
    if (!tags.length) return;
    await this.request("POST", `/contacts/${encodeURIComponent(contactId)}/tags`, {}, VERSION_DEFAULT, { tags });
  }

  /** Remove tags from a contact (needs contacts.write). Removing one it doesn't have is a no-op. */
  async removeContactTags(contactId: string, tags: readonly string[]): Promise<void> {
    if (!tags.length) return;
    await this.request("DELETE", `/contacts/${encodeURIComponent(contactId)}/tags`, {}, VERSION_DEFAULT, { tags });
  }

  /** A contact; HighLevel's 404 (or a 400 saying "not found") is a notFound error. */
  async getContact(contactId: string): Promise<HlContact> {
    try {
      const r = await this.get<{ contact?: HlContact }>(`/contacts/${encodeURIComponent(contactId)}`, {}, VERSION_DEFAULT);
      if (!r.contact?.id) throw new HighLevelError("notFound", { status: 200, detail: "contact missing from response" });
      return r.contact;
    } catch (e) {
      if (e instanceof HighLevelError && e.kind === "badRequest" && /not\s*found/i.test(e.detail ?? "")) {
        throw new HighLevelError("notFound", { status: e.status, detail: e.detail });
      }
      throw e;
    }
  }

  // --- Transport -----------------------------------------------------------

  private get<T>(path: string, query: Record<string, string | number | undefined>, version: string): Promise<T> {
    return this.request<T>("GET", path, query, version);
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, query: Record<string, string | number | undefined>,
    version: string, body?: unknown): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const q = qs.toString();
    const url = `${this.base}${path}${q ? `?${q}` : ""}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Version: version, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const payload = body === undefined ? undefined : JSON.stringify(body);

    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      this.requests++;
      let res: Response;
      try {
        res = await this.fetchWithTimeout(url, method, headers, payload);
      } catch (e) {
        const detail = e instanceof Error && e.name === "AbortError" ? `timed out after ${this.timeoutMs} ms` : e instanceof Error ? e.message : "network error";
        if (attempt >= this.maxAttempts) throw new HighLevelError("network", { detail });
        await this.sleep(backoffMs(attempt));
        continue;
      }
      this.readRateHeaders(res);
      if (res.ok) {
        if (method !== "GET") return (await res.text().then((t) => (t ? JSON.parse(t) : {})).catch(() => ({}))) as T;
        try {
          return (await res.json()) as T;
        } catch {
          if (attempt >= this.maxAttempts) throw new HighLevelError("server", { status: res.status, detail: "unreadable JSON body" });
          await this.sleep(backoffMs(attempt));
          continue;
        }
      }
      const detail = await errorDetail(res);
      if (res.status === 401 || res.status === 403) throw new HighLevelError("auth", { status: res.status, detail });
      if (res.status === 404) throw new HighLevelError("notFound", { status: 404, detail });
      if (res.status === 429) {
        const wait = retryAfterMs(res) ?? num(res.headers.get("x-ratelimit-interval-milliseconds")) ?? DEFAULT_INTERVAL_MS;
        if (attempt >= this.maxAttempts || wait > this.maxRetryWaitMs) {
          throw new HighLevelError("rateLimit", { status: 429, detail, retryAfterMs: wait });
        }
        await this.sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= this.maxAttempts) throw new HighLevelError("server", { status: res.status, detail });
        await this.sleep(backoffMs(attempt));
        continue;
      }
      throw new HighLevelError("badRequest", { status: res.status, detail });
    }
  }

  private async fetchWithTimeout(url: string, method: string, headers: Record<string, string>, body?: string): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.doFetch(url, { method, headers, body, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /** Sliding-window throttle plus any pause the rate-limit headers asked for. */
  private async throttle(): Promise<void> {
    for (;;) {
      const now = this.now();
      if (this.pauseUntil > now) { await this.sleep(this.pauseUntil - now); continue; }
      while (this.stamps.length && now - this.stamps[0] >= this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.windowMax) { this.stamps.push(now); return; }
      await this.sleep(this.windowMs - (now - this.stamps[0]) + 1);
    }
  }

  private readRateHeaders(res: Response): void {
    const daily = num(res.headers.get("x-ratelimit-daily-remaining"));
    if (daily != null) this.dailyRemaining = daily;
    const remaining = num(res.headers.get("x-ratelimit-remaining"));
    if (remaining != null && remaining <= LOW_BURST_REMAINING) {
      const interval = num(res.headers.get("x-ratelimit-interval-milliseconds")) ?? DEFAULT_INTERVAL_MS;
      this.pauseUntil = Math.max(this.pauseUntil, this.now() + interval);
    }
  }
}

/** 1 s, 2 s, 4 s, … between retries of a failed request. */
export const backoffMs = (attempt: number) => 1000 * 2 ** (attempt - 1);

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** HighLevel's error text ({ message } or plain text), trimmed for logs. */
async function errorDetail(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    try {
      const j = JSON.parse(text) as { message?: unknown; error?: unknown };
      const m = Array.isArray(j.message) ? j.message.join("; ") : j.message ?? j.error;
      if (typeof m === "string") return m.slice(0, 300);
    } catch { /* not JSON */ }
    return text.slice(0, 300);
  } catch {
    return null;
  }
}
