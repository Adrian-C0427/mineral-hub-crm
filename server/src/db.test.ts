import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { withDbRetry } from "./db.js";

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
