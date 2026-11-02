/**
 * The one way the server talks to Microsoft Graph and the Google Drive API on
 * behalf of a connected account:
 *
 *  - Fresh tokens: refreshed shortly before expiry, one refresh at a time per
 *    account (concurrent callers share it), and the rotated bundle is
 *    persisted encrypted. A dead grant (revoked, expired, password reset)
 *    flips the account to NEEDS_RECONNECT instead of failing forever.
 *  - Retries with exponential backoff + jitter for throttling (429, Google's
 *    403 rate-limit reasons), 5xx and network failures — honouring
 *    Retry-After — but only for idempotent requests unless the caller opts in
 *    (a send is retried by its own idempotency logic, never here).
 *  - A 401 forces one refresh and retry.
 *  - Only HTTPS calls to the providers' API hosts (no SSRF through a cursor or
 *    link a client sends back).
 *  - Errors carry a short provider message and a kind the routes map to a
 *    status — never a token, and logs never include query strings or bodies
 *    (which can hold search terms, names or mail content).
 */
import type { ConnectedAccount } from "@prisma/client";
import { prisma } from "../../db.js";
import { ACCOUNT_PROVIDER_DEFS, grantedScopes, isAccountProvider } from "./providers.js";
import { openTokens, refreshAccountTokens, sealTokens, TokenError, type TokenBundle } from "./oauth.js";

export type ProviderErrorKind = "reconnect" | "permission" | "notfound" | "conflict" | "throttled" | "unavailable" | "invalid" | "toolarge" | "other";

export class ProviderError extends Error {
  constructor(message: string, readonly kind: ProviderErrorKind, readonly status = 0, readonly code: string | null = null) {
    super(message);
  }
  /** The HTTP status a route should answer with. */
  get httpStatus(): number {
    return { reconnect: 409, permission: 403, notfound: 404, conflict: 409, throttled: 429, unavailable: 503, invalid: 400, toolarge: 413, other: 502 }[this.kind];
  }
}

const API_HOSTS = new Set(["graph.microsoft.com", "www.googleapis.com", "openidconnect.googleapis.com"]);
const MAX_ATTEMPTS = 4;
const MAX_WAIT_MS = 30_000;
const REFRESH_MARGIN_MS = 2 * 60_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const GOOGLE_RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter: ~0.5s, 1s, 2s, … (capped). */
export function backoffMs(attempt: number): number {
  const base = Math.min(MAX_WAIT_MS, 500 * 2 ** (attempt - 1));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/** Retry-After as milliseconds (seconds or an HTTP date), or null. */
export function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function providerName(a: Pick<ConnectedAccount, "provider">): string {
  return isAccountProvider(a.provider) ? ACCOUNT_PROVIDER_DEFS[a.provider].name : a.provider;
}

/** Mark an account as needing its owner to reconnect (sign-in revoked or permissions missing). */
export async function markReconnect(account: ConnectedAccount, message: string): Promise<void> {
  account.status = "NEEDS_RECONNECT";
  await prisma.connectedAccount.update({
    where: { id: account.id },
    data: { status: "NEEDS_RECONNECT", syncStatus: "ERROR", lastError: message },
  });
}

const refreshing = new Map<string, Promise<TokenBundle>>();

async function refresh(account: ConnectedAccount, refreshToken: string): Promise<TokenBundle> {
  if (!isAccountProvider(account.provider)) throw new ProviderError("Unknown provider.", "invalid");
  try {
    const b = await refreshAccountTokens(account.provider, refreshToken);
    const sealed = sealTokens(b);
    await prisma.connectedAccount.update({
      where: { id: account.id },
      data: { tokens: sealed, ...(b.scope ? { scopes: grantedScopes(b.scope) } : {}) },
    });
    account.tokens = sealed;
    return b;
  } catch (e) {
    if (e instanceof TokenError && e.revoked) {
      const msg = `${providerName(account)} sign-in expired or was revoked. Reconnect the account.`;
      await markReconnect(account, msg);
      throw new ProviderError(msg, "reconnect", 401, e.error);
    }
    throw new ProviderError(`Couldn't renew the ${providerName(account)} sign-in. Try again shortly.`, "unavailable");
  }
}

/** A valid access token for the account, refreshing it when it is about to expire (or when forced). */
export async function accessToken(account: ConnectedAccount, force = false): Promise<string> {
  if (account.status !== "CONNECTED" || !account.tokens) {
    throw new ProviderError(`${providerName(account)} needs to be reconnected.`, "reconnect");
  }
  let bundle = openTokens(account.tokens);
  const isFresh = (b: TokenBundle) => b.expires_at == null || b.expires_at - Date.now() > REFRESH_MARGIN_MS;
  if (!force && isFresh(bundle)) return bundle.access_token;

  // Another request (or the background sync) may already have refreshed it.
  const latest = await prisma.connectedAccount.findUnique({ where: { id: account.id }, select: { tokens: true, status: true } });
  if (!latest || latest.status !== "CONNECTED" || !latest.tokens) {
    throw new ProviderError(`${providerName(account)} needs to be reconnected.`, "reconnect");
  }
  if (latest.tokens !== account.tokens) {
    account.tokens = latest.tokens;
    bundle = openTokens(latest.tokens);
    if (!force && isFresh(bundle)) return bundle.access_token;
  }
  if (!bundle.refresh_token) {
    const msg = `${providerName(account)} sign-in expired. Reconnect the account.`;
    await markReconnect(account, msg);
    throw new ProviderError(msg, "reconnect");
  }
  let p = refreshing.get(account.id);
  if (!p) {
    p = refresh(account, bundle.refresh_token).finally(() => refreshing.delete(account.id));
    refreshing.set(account.id, p);
  }
  return (await p).access_token;
}

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: RequestInit["body"];
  /** Retry this non-idempotent request too (the caller guarantees it is safe). */
  retry?: boolean;
  timeoutMs?: number;
}

interface ErrBody { code: string | null; message: string | null; reason: string | null }

async function readError(res: Response): Promise<ErrBody> {
  const j = (await res.json().catch(() => ({}))) as { error?: { code?: unknown; message?: unknown; errors?: { reason?: unknown }[] } | string; error_description?: unknown };
  const e = typeof j.error === "object" && j.error ? j.error : null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    code: e ? str(e.code) ?? (typeof e.code === "number" ? String(e.code) : null) : str(j.error),
    message: (e ? str(e.message) : str(j.error_description))?.slice(0, 300) ?? null,
    reason: e?.errors?.[0] ? str(e.errors[0].reason) : null,
  };
}

function kindFor(status: number, err: ErrBody): ProviderErrorKind {
  if (status === 401) return "reconnect";
  if (status === 403) return err.reason && GOOGLE_RATE_REASONS.has(err.reason) ? "throttled" : "permission";
  if (status === 404 || status === 410) return "notfound";
  if (status === 409 || status === 412) return "conflict";
  if (status === 413) return "toolarge";
  if (status === 429) return "throttled";
  if (status >= 500) return "unavailable";
  if (status === 400 || status === 422) return "invalid";
  return "other";
}

const MESSAGES: Partial<Record<ProviderErrorKind, string>> = {
  permission: "doesn't allow this (permission missing or access denied)",
  notfound: "couldn't find that item — it may have been moved or deleted",
  conflict: "reported a conflict (an item with that name exists, or it changed meanwhile)",
  throttled: "is limiting requests right now — try again in a minute",
  unavailable: "is temporarily unavailable — try again shortly",
};

function logLine(account: ConnectedAccount, method: string, url: URL, status: number | string, note = ""): void {
  // Path only, and only its first segments: never the query (search terms,
  // filters) or deep paths.
  const path = url.pathname.split("/").slice(0, 4).join("/");
  console.warn(`[connected] ${account.provider} ${method} ${url.hostname}${path} → ${status}${note}`);
}

/**
 * Make an authenticated provider API request. Returns the response for 2xx;
 * throws ProviderError otherwise (after retries where safe).
 */
export async function providerFetch(account: ConnectedAccount, url: string, opts: FetchOpts = {}): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !API_HOSTS.has(u.hostname)) throw new ProviderError("Blocked request to an unexpected host.", "invalid");
  const method = (opts.method ?? "GET").toUpperCase();
  const idempotent = opts.retry || ["GET", "HEAD", "PUT", "DELETE", "PATCH"].includes(method);
  const isGraph = u.hostname === "graph.microsoft.com";
  let refreshedOnce = false;
  let forceRefresh = false;

  for (let attempt = 1; ; attempt++) {
    const token = await accessToken(account, forceRefresh);
    forceRefresh = false;
    let res: Response;
    try {
      res = await fetch(u, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          // Immutable ids: a message keeps its id when it moves folders
          // (draft → Sent Items), so stored ids stay valid.
          ...(isGraph ? { Prefer: 'IdType="ImmutableId"' } : {}),
          ...opts.headers,
        },
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch {
      if (idempotent && attempt < MAX_ATTEMPTS) {
        logLine(account, method, u, "network error", `, retry ${attempt}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new ProviderError(`${providerName(account)} didn't respond. Try again.`, "unavailable");
    }
    if (res.ok) return res;

    if (res.status === 401 && !refreshedOnce) {
      await res.body?.cancel().catch(() => {});
      refreshedOnce = true;
      forceRefresh = true;
      continue;
    }
    const err = await readError(res);
    const kind = kindFor(res.status, err);
    if (kind === "reconnect") {
      const msg = `${providerName(account)} rejected the sign-in. Reconnect the account.`;
      await markReconnect(account, msg);
      throw new ProviderError(msg, "reconnect", res.status, err.code);
    }
    const retryable = RETRYABLE.has(res.status) || kind === "throttled";
    if (retryable && idempotent && attempt < MAX_ATTEMPTS) {
      const wait = retryAfterMs(res) ?? backoffMs(attempt);
      if (wait <= MAX_WAIT_MS) {
        logLine(account, method, u, res.status, `, retry ${attempt} in ${Math.round(wait / 100) / 10}s`);
        await sleep(wait);
        continue;
      }
    }
    logLine(account, method, u, res.status);
    const what = MESSAGES[kind];
    throw new ProviderError(
      what ? `${providerName(account)} ${what}.` : `${providerName(account)} returned an error${err.message ? `: ${err.message}` : ` (HTTP ${res.status})`}.`,
      kind, res.status, err.code,
    );
  }
}

/** providerFetch + JSON body. */
export async function providerJson<T = Record<string, unknown>>(account: ConnectedAccount, url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await providerFetch(account, url, opts);
  if (res.status === 204) return {} as T;
  return (await res.json().catch(() => ({}))) as T;
}
