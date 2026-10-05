/**
 * Invite codes that carry a role and expire.
 *
 * The join rules live in resolveJoinToken — the one gate every redeem path
 * (POST /auth/register, the SSO sign-up callback, POST /auth/join) goes through
 * before it writes `orgRole: join.role` — so they are exercised here against a
 * fake client; no database needed. The create rules are the request schema plus
 * assertCanGrantRole, the same check PATCH /org/members/:userId applies.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../services/rolePermCache.js", () => ({
  getRoleOverride: vi.fn(async () => null),
  invalidateRoleCache: vi.fn(),
}));

import {
  resolveJoinToken, assertCanGrantRole, canGrantRole, inviteExpiryFrom, INVITE_TTL_DAYS,
} from "../services/org.js";
import { createInviteSchema } from "./org.js";
import { HttpError } from "../middleware/errors.js";

const NOW = new Date("2026-10-04T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

type InviteRow = {
  id: string; organizationId: string; code: string; reusable: boolean; active: boolean;
  maxUses: number | null; uses: number; role: string | null; expiresAt: Date | null;
};

function invite(over: Partial<InviteRow> = {}): InviteRow {
  return {
    id: "inv_1", organizationId: "org_a", code: "INV-ABCDEFGH", reusable: false, active: true,
    maxUses: 1, uses: 0, role: null, expiresAt: null, ...over,
  };
}

/** Fake client: one org reachable by Team ID, plus whatever invite rows are given. */
function fakeDb(rows: InviteRow[]) {
  return {
    organization: {
      findUnique: vi.fn(async ({ where }: { where: { teamId: string } }) =>
        where.teamId === "TEAM-AAAAAA" ? { id: "org_a" } : null),
    },
    inviteCode: {
      findUnique: vi.fn(async ({ where }: { where: { code: string } }) =>
        rows.find((r) => r.code === where.code) ?? null),
    },
  } as never;
}

async function rejection(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

describe("joining with an invite code", () => {
  it("refuses an expired code", async () => {
    const db = fakeDb([invite({ role: "MEMBER", expiresAt: new Date(NOW.getTime() - 1000) })]);
    const err = await rejection(resolveJoinToken("INV-ABCDEFGH", db, NOW));
    expect(err.status).toBe(400);
    expect(err.message).toBe("That invite code has expired");
  });

  it("refuses a code at the exact moment it expires", async () => {
    const db = fakeDb([invite({ expiresAt: NOW })]);
    await rejection(resolveJoinToken("INV-ABCDEFGH", db, NOW));
  });

  it("accepts a code that has not expired yet", async () => {
    const db = fakeDb([invite({ role: "VIEWER", expiresAt: new Date(NOW.getTime() + 1000) })]);
    await expect(resolveJoinToken("INV-ABCDEFGH", db, NOW)).resolves.toEqual({
      organizationId: "org_a", inviteCodeId: "inv_1", role: "VIEWER",
    });
  });

  it("gives the joiner the code's role", async () => {
    for (const role of ["ADMIN", "MEMBER", "VIEWER"]) {
      const db = fakeDb([invite({ role, expiresAt: new Date(NOW.getTime() + DAY) })]);
      expect((await resolveJoinToken("INV-ABCDEFGH", db, NOW)).role).toBe(role);
    }
  });

  it("joins a legacy code (no role, no expiry) as MEMBER, however old it is", async () => {
    const db = fakeDb([invite()]);
    const far = new Date(NOW.getTime() + 3650 * DAY);
    await expect(resolveJoinToken("INV-ABCDEFGH", db, far)).resolves.toEqual({
      organizationId: "org_a", inviteCodeId: "inv_1", role: "MEMBER",
    });
  });

  it("joins by Team ID as MEMBER", async () => {
    await expect(resolveJoinToken("TEAM-AAAAAA", fakeDb([]), NOW)).resolves.toEqual({
      organizationId: "org_a", inviteCodeId: null, role: "MEMBER",
    });
  });

  it("never hands out OWNER (or the retired MANAGER) even if a row carries it", async () => {
    for (const role of ["OWNER", "MANAGER"]) {
      const db = fakeDb([invite({ role })]);
      const err = await rejection(resolveJoinToken("INV-ABCDEFGH", db, NOW));
      expect(err.status).toBe(400);
    }
  });

  it("still refuses disabled and used-up codes", async () => {
    const future = new Date(NOW.getTime() + DAY);
    const off = await rejection(resolveJoinToken("INV-ABCDEFGH", fakeDb([invite({ active: false, expiresAt: future })]), NOW));
    expect(off.message).toBe("That invite code has been disabled");
    const used = await rejection(resolveJoinToken("INV-ABCDEFGH", fakeDb([invite({ uses: 1, expiresAt: future })]), NOW));
    expect(used.message).toBe("That invite code has already been used");
  });
});

describe("creating an invite code", () => {
  it("defaults the role to MEMBER when none is sent", () => {
    expect(createInviteSchema.parse({}).role).toBe("MEMBER");
    expect(createInviteSchema.parse({ reusable: true }).role).toBe("MEMBER");
  });

  it("refuses OWNER (and anything that is not an assignable role)", () => {
    for (const role of ["OWNER", "MANAGER", "owner", "", null, 1]) {
      expect(createInviteSchema.safeParse({ role }).success).toBe(false);
    }
    // And the grant rule refuses it for every caller, the owner included.
    for (const caller of ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const) {
      expect(() => assertCanGrantRole(caller, "OWNER")).toThrow(HttpError);
      expect(canGrantRole(caller, "OWNER")).toBe(false);
    }
  });

  it("refuses granting above the creator's level: only the owner can issue ADMIN codes", () => {
    for (const caller of ["ADMIN", "MANAGER", "MEMBER", "VIEWER", null] as const) {
      let err: unknown;
      try { assertCanGrantRole(caller, "ADMIN"); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
      expect(canGrantRole(caller, "ADMIN")).toBe(false);
    }
    expect(() => assertCanGrantRole("OWNER", "ADMIN")).not.toThrow();
    expect(canGrantRole("OWNER", "ADMIN")).toBe(true);
  });

  it("lets a non-owner creator grant the standard and read-only roles", () => {
    for (const role of ["MEMBER", "VIEWER"] as const) {
      expect(() => assertCanGrantRole("ADMIN", role)).not.toThrow();
      expect(canGrantRole("ADMIN", role)).toBe(true);
    }
  });

  it("expires a new code 7 days after creation", () => {
    expect(INVITE_TTL_DAYS).toBe(7);
    expect(inviteExpiryFrom(NOW).getTime() - NOW.getTime()).toBe(7 * DAY);
  });
});
