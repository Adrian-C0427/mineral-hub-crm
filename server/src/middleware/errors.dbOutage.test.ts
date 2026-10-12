/**
 * Regression tests for Sentry MINERAL-HUB-API-7: a Neon outage made attachUser's
 * user lookup reject. Express 4 doesn't forward a rejected promise from async
 * middleware, so it became an unhandled rejection and the request hung. Now
 * attachUser is mounted through asyncHandler and errorHandler answers transient
 * DB errors with a 503 + Retry-After.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { Prisma } from "@prisma/client";

const db = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("../db.js", () => ({
  prisma: { user: { findUnique: db.findUnique } },
  withDbRetry: <T>(f: () => T) => f(),
}));
vi.mock("../auth/session.js", () => ({
  verifySession: () => ({ userId: "u_1", role: "OWNER", epoch: 0 }),
}));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null) }));

import { attachUser } from "./auth.js";
import { asyncHandler, errorHandler } from "./errors.js";

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code, clientVersion: "test" });
}

async function get(path: string, routeHandler?: express.RequestHandler) {
  const app = express();
  app.use(asyncHandler(attachUser));
  app.get(path, routeHandler ?? ((_req, res) => { res.json({ ok: true }); }));
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { authorization: "Bearer test-token" },
      signal: AbortSignal.timeout(3000),
    });
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body: (await res.json()) as { error?: string; ok?: boolean } };
  } finally {
    server.close();
  }
}

describe("DB outage during attachUser (MINERAL-HUB-API-7)", () => {
  it("answers 503 + Retry-After instead of hanging on an unhandled rejection", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      db.findUnique.mockRejectedValueOnce(prismaError("P1001"));
      const res = await get("/api/notifications");
      expect(res.status).toBe(503);
      expect(res.retryAfter).toBe("5");
      expect(res.body.error).toMatch(/temporarily unavailable/);
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("leaves the happy path unchanged", async () => {
    db.findUnique.mockResolvedValueOnce(null);
    const res = await get("/api/notifications");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("errorHandler — transient DB errors", () => {
  for (const code of ["P1001", "P1017", "P2024"]) {
    it(`maps ${code} to 503`, async () => {
      db.findUnique.mockResolvedValueOnce(null);
      const res = await get("/x", () => { throw prismaError(code); });
      expect(res.status).toBe(503);
    });
  }

  it("keeps a non-connection Prisma error (unique violation) as a 500", async () => {
    db.findUnique.mockResolvedValueOnce(null);
    const res = await get("/x", () => { throw prismaError("P2002"); });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });
});
