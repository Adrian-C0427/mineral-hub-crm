import { describe, it, expect } from "vitest";
import {
  HighLevelClient, HighLevelError, HL_AUTH_MESSAGE, HIGHLEVEL_DEFAULT_BASE, resolveHighLevelBase, DAILY_RESERVE,
} from "./client.js";

const TOKEN = "pit-secret-token-1234";

/** A fake clock + fetch: every sleep advances time instead of waiting. */
function harness(responses: (Response | Error)[], opts: { windowMax?: number } = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const queue = [...responses];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    const next = queue.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const client = new HighLevelClient({
    token: TOKEN, baseUrl: "https://hl.test", fetch: fetchFn,
    sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t,
    windowMax: opts.windowMax,
  });
  return { client, sleeps, calls, advance: (ms: number) => { t += ms; } };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const page = { messages: [], nextCursor: null, total: 0 };

describe("resolveHighLevelBase", () => {
  it("honors HIGHLEVEL_API_BASE outside production only", () => {
    expect(resolveHighLevelBase("development", "http://127.0.0.1:4299/")).toBe("http://127.0.0.1:4299");
    expect(resolveHighLevelBase("test", "http://mock")).toBe("http://mock");
    expect(resolveHighLevelBase("production", "http://evil.example")).toBe(HIGHLEVEL_DEFAULT_BASE);
    expect(resolveHighLevelBase("development", "")).toBe(HIGHLEVEL_DEFAULT_BASE);
    expect(resolveHighLevelBase("development", undefined)).toBe(HIGHLEVEL_DEFAULT_BASE);
  });
});

describe("HighLevelClient requests", () => {
  it("sends the bearer token and the right Version header per endpoint family", async () => {
    const h = harness([json(page), json({ contact: { id: "c1" } }), json({ location: { id: "L1", name: "Loc" } })]);
    await h.client.exportMessages({ locationId: "L1", channel: "SMS", limit: 10, sortBy: "createdAt", sortOrder: "asc", startDate: "2026-01-01T00:00:00.000Z" });
    await h.client.getContact("c1");
    await h.client.getLocation("L1");
    expect(h.calls[0].url).toBe("https://hl.test/conversations/messages/export?locationId=L1&channel=SMS&limit=10&sortBy=createdAt&sortOrder=asc&startDate=2026-01-01T00%3A00%3A00.000Z");
    expect(h.calls[0].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, Version: "2021-04-15" });
    expect(h.calls[1].headers.Version).toBe("2021-07-28");
    expect(h.calls[2].url).toBe("https://hl.test/locations/L1");
  });

  it("retries 5xx with exponential backoff and returns the eventual success", async () => {
    const h = harness([json({}, 502), json({}, 503), json({ location: { id: "L1" } })]);
    await expect(h.client.getLocation("L1")).resolves.toMatchObject({ id: "L1" });
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it("gives up after 4 attempts with a server error", async () => {
    const h = harness([json({}, 500), json({}, 500), json({}, 500), json({ message: "boom" }, 500)]);
    const err = await h.client.getLocation("L1").catch((e) => e);
    expect(err).toBeInstanceOf(HighLevelError);
    expect(err).toMatchObject({ kind: "server", status: 500, detail: "boom" });
    expect(h.calls).toHaveLength(4);
    expect(h.sleeps).toEqual([1000, 2000, 4000]);
  });

  it("treats network failures and timeouts like 5xx", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const h = harness([new Error("ECONNRESET"), abort, json({ users: [{ id: "u1" }] })]);
    await expect(h.client.listUsers("L1")).resolves.toEqual([{ id: "u1" }]);
    const h2 = harness([abort, abort, abort, abort]);
    await expect(h2.client.listUsers("L1")).rejects.toMatchObject({ kind: "network", detail: "timed out after 30000 ms" });
  });

  it("waits out a 429 (Retry-After, else the advertised interval) and retries", async () => {
    const h = harness([
      json({ message: "Too many requests" }, 429, { "retry-after": "2" }),
      json({ message: "Too many requests" }, 429, { "x-ratelimit-interval-milliseconds": "10000" }),
      json(page),
    ]);
    await h.client.exportMessages({ locationId: "L1" });
    expect(h.sleeps).toEqual([2000, 10000]);
  });

  it("surfaces a long 429 wait as a rateLimit error instead of blocking", async () => {
    const h = harness([json({}, 429, { "retry-after": "600" })]);
    await expect(h.client.exportMessages({ locationId: "L1" })).rejects.toMatchObject({ kind: "rateLimit", retryAfterMs: 600_000 });
    expect(h.calls).toHaveLength(1);
  });

  it("stops at once on 401/403 with the reconnect message", async () => {
    for (const status of [401, 403]) {
      const h = harness([json({ message: "Invalid JWT" }, status)]);
      const err = await h.client.getLocation("L1").catch((e) => e);
      expect(err).toMatchObject({ kind: "auth", status, detail: "Invalid JWT" });
      expect(err.message).toBe(HL_AUTH_MESSAGE);
      expect(h.calls).toHaveLength(1);
    }
  });

  it("maps a deleted contact (404, or 400 'not found') to notFound, other 400s to badRequest", async () => {
    const h = harness([
      json({ message: "Contact not found" }, 404),
      json({ message: "Contact with id c2 not found" }, 400),
      json({ message: ["limit must not be greater than 500"] }, 422),
    ]);
    await expect(h.client.getContact("c1")).rejects.toMatchObject({ kind: "notFound" });
    await expect(h.client.getContact("c2")).rejects.toMatchObject({ kind: "notFound", status: 400 });
    await expect(h.client.exportMessages({ locationId: "L1", limit: 900 })).rejects.toMatchObject({ kind: "badRequest", status: 422, detail: "limit must not be greater than 500" });
  });

  it("never puts the token in an error", async () => {
    const h = harness([json({ message: "Invalid JWT" }, 401)]);
    const err = (await h.client.getLocation("L1").catch((e) => e)) as HighLevelError;
    expect(JSON.stringify({ m: err.message, d: err.detail, s: String(err) })).not.toContain(TOKEN);
  });
});

describe("HighLevelClient rate limiting", () => {
  it("throttles to windowMax requests per 10 s window", async () => {
    const h = harness([json(page), json(page), json(page), json(page)], { windowMax: 3 });
    for (let i = 0; i < 4; i++) await h.client.exportMessages({ locationId: "L1" });
    expect(h.sleeps).toEqual([10_001]); // the 4th waits for the first to leave the window
  });

  it("pauses for the interval when HighLevel says the burst budget is nearly spent", async () => {
    const h = harness([
      json(page, 200, { "x-ratelimit-remaining": "3", "x-ratelimit-interval-milliseconds": "10000" }),
      json(page),
    ]);
    await h.client.exportMessages({ locationId: "L1" });
    await h.client.exportMessages({ locationId: "L1" });
    expect(h.sleeps).toEqual([10_000]);
  });

  it("tracks the daily budget", async () => {
    const h = harness([json(page, 200, { "x-ratelimit-daily-remaining": "150000" }), json(page, 200, { "x-ratelimit-daily-remaining": String(DAILY_RESERVE - 1) })]);
    expect(h.client.dailyBudgetLow).toBe(false);
    await h.client.exportMessages({ locationId: "L1" });
    expect(h.client.dailyRemaining).toBe(150_000);
    expect(h.client.dailyBudgetLow).toBe(false);
    await h.client.exportMessages({ locationId: "L1" });
    expect(h.client.dailyBudgetLow).toBe(true);
  });
});
