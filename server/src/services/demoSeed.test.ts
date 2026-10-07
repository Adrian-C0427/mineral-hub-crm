import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  DEMO_EMAIL_DOMAIN, isDemoEmail, assertDemoEmail, findDemoOrg, assertDemoOrg, validateReferenceOrg,
  resolveReferenceOrg, wipeDemoOrgData, seedDemoOrg, buildPdf,
} from "./demoSeed.js";

type Org = { id: string; name: string; isDemo: boolean; referenceOrgId?: string | null };

/**
 * A fake Prisma client over an in-memory org table. Every OTHER model access
 * is recorded (and returns a no-op), so tests can assert that guarded calls
 * never reached a delete/write.
 */
function fakeDb(orgs: Org[]) {
  const calls: { model: string; op: string; args: unknown }[] = [];
  const matches = (o: Org, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => (o as Record<string, unknown>)[k] === v);
  const organization = {
    findMany: vi.fn(async ({ where, take }: { where?: Record<string, unknown>; take?: number } = {}) => orgs.filter((o) => matches(o, where)).slice(0, take ?? orgs.length)),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => orgs.find((o) => o.id === where.id) ?? null),
  };
  const recorder = (model: string) => new Proxy({}, {
    get: (_t, op: string) => async (args: unknown) => { calls.push({ model, op, args }); return op === "count" ? 0 : op === "findMany" ? [] : { count: 0 }; },
  });
  const db: Record<string, unknown> = new Proxy({ organization }, {
    get: (target, prop: string) => {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (prop === "$transaction") return async (fn: (tx: unknown) => Promise<unknown>) => { calls.push({ model: "$transaction", op: "begin", args: null }); return fn(db); };
      if (prop === "then") return undefined;
      return recorder(prop);
    },
  });
  return { db: db as unknown as PrismaClient, calls, organization };
}

const DEMO: Org = { id: "org_demo", name: "Brazos Ridge Minerals", isDemo: true };
const REAL: Org = { id: "org_real", name: "Carsa Minerals", isDemo: false };

describe("demo email domain", () => {
  it("accepts only addresses on the exact demo domain", () => {
    expect(isDemoEmail(`demo@${DEMO_EMAIL_DOMAIN}`)).toBe(true);
    expect(isDemoEmail("Elena.Navarro@BrazosRidge.Demo")).toBe(true);
    expect(isDemoEmail("demo@gmail.com")).toBe(false);
    expect(isDemoEmail(`demo@${DEMO_EMAIL_DOMAIN}.evil.com`)).toBe(false);
    expect(isDemoEmail(`demo@sub.${DEMO_EMAIL_DOMAIN}`)).toBe(false);
    expect(isDemoEmail(`@${DEMO_EMAIL_DOMAIN}`)).toBe(false);
    expect(isDemoEmail(`a b@${DEMO_EMAIL_DOMAIN}`)).toBe(false);
    expect(() => assertDemoEmail("owner@carsaminerals.com")).toThrow(/@brazosridge\.demo/);
  });
});

describe("findDemoOrg / assertDemoOrg", () => {
  it("returns the single demo org, or null", async () => {
    expect(await findDemoOrg(fakeDb([REAL]).db)).toBeNull();
    expect((await findDemoOrg(fakeDb([REAL, DEMO]).db))?.id).toBe("org_demo");
  });
  it("throws when more than one org is marked demo", async () => {
    await expect(findDemoOrg(fakeDb([DEMO, { ...DEMO, id: "org_demo2" }]).db)).rejects.toThrow(/More than one/);
  });
  it("refuses a non-demo or unknown org", async () => {
    await expect(assertDemoOrg(fakeDb([REAL, DEMO]).db, "org_real")).rejects.toThrow(/not a demo organization/);
    await expect(assertDemoOrg(fakeDb([REAL]).db, "nope")).rejects.toThrow(/not found/);
    await expect(assertDemoOrg(fakeDb([REAL]).db, "")).rejects.toThrow(/required/);
  });
});

describe("wipeDemoOrgData", () => {
  it("refuses a non-demo org before touching any other table", async () => {
    const { db, calls } = fakeDb([REAL, DEMO]);
    await expect(wipeDemoOrgData(db, "org_real")).rejects.toThrow(/not a demo organization/);
    expect(calls).toEqual([]);
  });
  it("refuses when two orgs are marked demo", async () => {
    const { db, calls } = fakeDb([DEMO, { ...DEMO, id: "org_demo2" }]);
    await expect(wipeDemoOrgData(db, "org_demo")).rejects.toThrow(/More than one/);
    expect(calls).toEqual([]);
  });
  it("scopes every delete/update to the demo org id and never deletes the org or users", async () => {
    const { db, calls } = fakeDb([REAL, DEMO]);
    await wipeDemoOrgData(db, "org_demo");
    const writes = calls.filter((c) => c.op === "deleteMany" || c.op === "updateMany" || c.op === "delete");
    expect(writes.length).toBeGreaterThan(30);
    for (const w of writes) {
      const json = JSON.stringify((w.args as { where?: unknown }).where ?? null);
      expect(json, `${w.model}.${w.op}`).toContain('"org_demo"');
      expect(json).not.toContain("org_real");
    }
    expect(writes.some((w) => w.model === "organization")).toBe(false);
    expect(writes.some((w) => w.model === "user")).toBe(false);
    // The only user-adjacent delete is password reset tokens, scoped to demo users.
    const tokens = writes.find((w) => w.model === "passwordResetToken");
    expect(JSON.stringify(tokens?.args)).toContain(`@${DEMO_EMAIL_DOMAIN}`);
  });
});

describe("reference org", () => {
  it("must exist and must not be a demo org", async () => {
    const { db } = fakeDb([REAL, DEMO]);
    expect(await validateReferenceOrg(db, null)).toBeNull();
    expect(await validateReferenceOrg(db, "org_real")).toEqual({ id: "org_real", name: "Carsa Minerals" });
    await expect(validateReferenceOrg(db, "org_demo")).rejects.toThrow(/must not be a demo/);
    await expect(validateReferenceOrg(db, "missing")).rejects.toThrow(/not found/);
    await expect(validateReferenceOrg(db, "org_real", "org_real")).rejects.toThrow(/cannot be the demo/);
  });
  it("resolves by id or exact name and refuses ambiguity and demo orgs", async () => {
    const { db } = fakeDb([REAL, DEMO, { id: "org_dup1", name: "Twin", isDemo: false }, { id: "org_dup2", name: "Twin", isDemo: false }]);
    expect((await resolveReferenceOrg(db, "org_real")).id).toBe("org_real");
    expect((await resolveReferenceOrg(db, "Carsa Minerals")).id).toBe("org_real");
    await expect(resolveReferenceOrg(db, "Twin")).rejects.toThrow(/more than one/);
    await expect(resolveReferenceOrg(db, "Brazos Ridge Minerals")).rejects.toThrow(/must not be a demo/);
    await expect(resolveReferenceOrg(db, "Nobody")).rejects.toThrow(/No organization/);
  });
});

describe("seedDemoOrg guards", () => {
  it("rejects a malformed login email before any database access", async () => {
    const { db, calls, organization } = fakeDb([REAL]);
    await expect(seedDemoOrg(db, { referenceOrgId: "org_real", demoUserEmail: "not-an-email", demoUserPassword: "long-enough-password" })).rejects.toThrow(/Invalid demo login email/);
    expect(calls).toEqual([]);
    expect(organization.findMany).not.toHaveBeenCalled();
  });
  it("rejects a short password before any database access", async () => {
    const { db, calls, organization } = fakeDb([REAL]);
    await expect(seedDemoOrg(db, { referenceOrgId: "org_real", demoUserEmail: `demo@${DEMO_EMAIL_DOMAIN}`, demoUserPassword: "short" })).rejects.toThrow(/at least 12/);
    expect(calls).toEqual([]);
    expect(organization.findMany).not.toHaveBeenCalled();
  });
  it("rejects a demo org as the reference before writing anything", async () => {
    const { db, calls } = fakeDb([REAL, DEMO]);
    await expect(seedDemoOrg(db, { referenceOrgId: "org_demo", demoUserEmail: `demo@${DEMO_EMAIL_DOMAIN}`, demoUserPassword: "long-enough-password" })).rejects.toThrow(/reference organization/);
    expect(calls.filter((c) => c.op !== "findMany" && c.op !== "findUnique" && c.op !== "count")).toEqual([]);
  });
});

describe("buildPdf", () => {
  it("produces a structurally valid single-page PDF with correct xref offsets", () => {
    const buf = buildPdf("Mineral Deed (Leon Co.)", ["Grantee: Brazos Ridge Minerals — test \\ path"]);
    const s = buf.toString("latin1");
    expect(s.startsWith("%PDF-1.4\n")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    const xrefAt = Number(s.match(/startxref\n(\d+)/)![1]);
    expect(s.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const offsets = [...s.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(6);
    offsets.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(s).toContain("\\(Leon Co.\\)");
  });
});
