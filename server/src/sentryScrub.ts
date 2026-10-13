/**
 * What may leave the process in a Sentry event's `request`.
 *
 * The Node SDK captures an incoming request body as a raw STRING (not an
 * object), so a scrubber that only deletes keys from `request.data` objects
 * never ran: a 5xx during a connect/login sent the API key, PIT or password to
 * Sentry verbatim. This handles both shapes, drops bodies on credential routes
 * outright, and redacts credential-looking query parameters (OAuth code/state)
 * from the query string and URL. Pure, so it is unit-tested directly.
 */

/** Routes whose bodies are credentials by nature — never sent, in any shape. */
const DROP_BODY_PATHS = /^\/api\/(auth|integrations|users|org\/invites|portal)(\/|$)/i;

/** Body / query keys redacted wherever they appear (case-insensitive, nested). */
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|^key$|^pit$|^code$|recovery|totp|^otp$|^state$|authorization|cookie|tax[-_]?id|^ssn$/i;

const SENSITIVE_HEADERS = ["authorization", "cookie", "x-api-key", "set-cookie", "proxy-authorization"];

export const REDACTED = "[redacted]";

function redactValue(v: unknown, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(val, depth + 1);
  }
  return out;
}

function redactQuery(qs: string): string {
  const params = new URLSearchParams(qs.replace(/^\?/, ""));
  for (const k of [...params.keys()]) if (SENSITIVE_KEY.test(k)) params.set(k, REDACTED);
  return params.toString();
}

function pathOf(url: string | undefined): string {
  if (!url) return "";
  try { return new URL(url, "http://x").pathname; } catch { return url.split("?")[0]; }
}

type SentryRequest = {
  url?: string;
  data?: unknown;
  query_string?: unknown;
  headers?: Record<string, string>;
  cookies?: unknown;
};

/** Scrub an event's `request` in place (returns it for convenience). */
export function scrubSentryRequest<T extends SentryRequest | undefined>(req: T): T {
  if (!req) return req;
  if (req.headers) {
    for (const h of Object.keys(req.headers)) if (SENSITIVE_HEADERS.includes(h.toLowerCase())) delete req.headers[h];
  }
  delete req.cookies;

  if (req.data !== undefined) {
    if (DROP_BODY_PATHS.test(pathOf(req.url))) {
      req.data = REDACTED;
    } else if (typeof req.data === "string") {
      const raw = req.data;
      try {
        req.data = JSON.stringify(redactValue(JSON.parse(raw)));
      } catch {
        // Not JSON (truncated, form-encoded…): keep nothing that could hold a credential.
        req.data = /=|:/.test(raw) ? REDACTED : raw;
      }
    } else {
      req.data = redactValue(req.data);
    }
  }

  if (typeof req.query_string === "string") req.query_string = redactQuery(req.query_string);
  else if (req.query_string && typeof req.query_string === "object") req.query_string = redactValue(req.query_string);

  if (req.url && req.url.includes("?")) {
    const i = req.url.indexOf("?");
    req.url = `${req.url.slice(0, i)}?${redactQuery(req.url.slice(i + 1))}`;
  }
  return req;
}
