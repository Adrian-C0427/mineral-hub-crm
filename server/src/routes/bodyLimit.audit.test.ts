/**
 * Regression tests for the 2026-08-12 audit finding: the global JSON body limit.
 *
 * `express.json` is mounted BEFORE attachUser and before every router's rate
 * limiter, so the limit is the only control that applies to an unauthenticated
 * request's payload. A blanket 25mb therefore let anyone with the URL make the
 * process buffer and parse 25 MB per request on the public routes; the limiters
 * there run after parsing and cannot help.
 *
 * These pin both halves of the fix: ordinary routes reject an oversized body,
 * and the four CSV importers still accept one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../app.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** POST a JSON body of roughly `bytes` and return the status code. */
async function postJson(path: string, bytes: number): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // One long string value — the shape a CSV import actually posts.
    body: JSON.stringify({ csv: "a".repeat(bytes) }),
  });
  return res.status;
}

const MB = 1024 * 1024;

describe("JSON body limit", () => {
  it("rejects an oversized body on a public unauthenticated route", async () => {
    // The exploit path: no session needed, and portal/auth limiters run too late.
    expect(await postJson("/api/auth/login", 3 * MB)).toBe(413);
    expect(await postJson("/api/portal/any-slug/leads", 3 * MB)).toBe(413);
  });

  it("still accepts a body large enough for two branding logos", async () => {
    // PATCH /api/org/branding carries up to 2 x ~700 KB of base64 (LOGO_MAX_BYTES),
    // the biggest legitimate non-CSV payload. It must not be caught by the cap —
    // anything other than 413 means the body was parsed and the request reached
    // the router (401 here, since the test sends no session).
    expect(await postJson("/api/auth/login", 1.5 * MB)).not.toBe(413);
  });

  it("still accepts a multi-megabyte CSV on every importer path", async () => {
    // 3 MB is over the general 2mb ceiling and well under the importers' 25mb, so
    // a 413 on any of these would mean the path-scoped parser stopped applying.
    for (const path of [
      "/api/buyers/import/analyze",
      "/api/contacts/import/analyze",
      "/api/research/ingest/analyze",
      "/api/wells/import/analyze",
    ]) {
      expect(await postJson(path, 3 * MB), path).not.toBe(413);
    }
  });

  it("gates the CSV paths on auth rather than leaving them open", async () => {
    // The large limit is scoped to paths that are themselves authenticated — the
    // reason a 25mb body is acceptable there at all.
    expect(await postJson("/api/research/ingest/analyze", 1024)).toBe(401);
  });
});
