import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { withDbRetry, runtimeDatabaseUrl } from "./db.js";

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("boom", {
    code,
    clientVersion: "test",
  });
}

describe("withDbRetry", () => {
  it("runs the op once and returns its result on success", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    await expect(withDbRetry(op, 2, 0)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries a transient connection error (P1001) and then succeeds", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(prismaError("P1001"))
      .mockResolvedValue("ok");
    await expect(withDbRetry(op, 2, 0)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("retries P1017 (server closed the connection)", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(prismaError("P1017"))
      .mockResolvedValue("ok");
    await expect(withDbRetry(op, 2, 0)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("retries P2024 (timed out fetching a connection from the pool)", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(prismaError("P2024"))
      .mockResolvedValue("ok");
    await expect(withDbRetry(op, 2, 0)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries and rethrows the last error", async () => {
    const err = prismaError("P1001");
    const op = vi.fn().mockRejectedValue(err);
    await expect(withDbRetry(op, 2, 0)).rejects.toBe(err);
    // initial attempt + 2 retries
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-connection Prisma error (e.g. unique violation)", async () => {
    const err = prismaError("P2002");
    const op = vi.fn().mockRejectedValue(err);
    await expect(withDbRetry(op, 2, 0)).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("does not retry a generic (non-Prisma) error", async () => {
    const err = new Error("something else");
    const op = vi.fn().mockRejectedValue(err);
    await expect(withDbRetry(op, 2, 0)).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe("runtimeDatabaseUrl", () => {
  const direct =
    "postgresql://u:p%40ss@ep-holy-meadow-ajsj9a8c.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require";

  it("moves a Neon direct endpoint onto its -pooler host, keeping creds/db/params", () => {
    const out = new URL(runtimeDatabaseUrl(direct)!);
    expect(out.hostname).toBe("ep-holy-meadow-ajsj9a8c-pooler.c-3.us-east-2.aws.neon.tech");
    expect(out.username).toBe("u");
    expect(out.password).toBe("p%40ss");
    expect(out.pathname).toBe("/neondb");
    expect(out.searchParams.get("sslmode")).toBe("require");
  });

  it("leaves an already-pooled Neon URL unchanged", () => {
    const pooled = direct.replace("ajsj9a8c.", "ajsj9a8c-pooler.");
    expect(runtimeDatabaseUrl(pooled)).toBe(pooled);
  });

  it("leaves non-Neon, unparseable, and missing URLs unchanged", () => {
    expect(runtimeDatabaseUrl("postgresql://localhost:5432/mineralhub")).toBe(
      "postgresql://localhost:5432/mineralhub",
    );
    expect(runtimeDatabaseUrl("not a url")).toBe("not a url");
    expect(runtimeDatabaseUrl(undefined)).toBeUndefined();
  });

  it("respects the DB_DISABLE_POOLER_REWRITE opt-out", () => {
    vi.stubEnv("DB_DISABLE_POOLER_REWRITE", "1");
    try {
      expect(runtimeDatabaseUrl(direct)).toBe(direct);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
