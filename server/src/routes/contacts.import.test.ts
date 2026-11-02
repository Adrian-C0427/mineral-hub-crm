/**
 * Contacts CSV import preview (POST /contacts/import/preview): how each row is
 * classified against the org's contacts and the rows above it. A name (+ phone)
 * is the same person only when the middle names agree too — blank on either
 * side agrees, two different middle names are two people — so "John A Smith"
 * is never merged into "John B Smith".
 *
 * The router runs against a fake Prisma client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

const db = vi.hoisted(() => {
  const results: Record<string, unknown> = {};
  const prisma = { contact: { findMany: async () => results["contact.findMany"] ?? [] } };
  return { results, prisma };
});

vi.mock("../db.js", () => ({ prisma: db.prisma, withDbRetry: <T>(f: () => T) => f() }));
vi.mock("../services/rolePermCache.js", () => ({ getRoleOverride: vi.fn(async () => null), invalidateRoleCache: vi.fn() }));

import { contactsRouter } from "./contacts.js";
import { errorHandler } from "../middleware/errors.js";
import type { AuthedRequest } from "../middleware/auth.js";

async function preview(csv: string) {
  const app = express();
  app.use(express.json());
  app.use((req: AuthedRequest, _res, next) => {
    req.user = {
      id: "u_m", role: "ASSOCIATE", name: "Test", email: "t@local.test", firstName: null, lastName: null, phone: null,
      organizationId: "org_a", orgRole: "MEMBER", permissions: ["viewContacts", "manageContacts"], mustChangePassword: false, isDemo: false, referenceOrgId: null,
    };
    next();
  });
  app.use("/api/contacts", contactsRouter);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address() as { port: number };
    const mapping = { firstName: "First", middleName: "Middle", lastName: "Last", phone: "Phone", email: "Email" };
    const res = await fetch(`http://127.0.0.1:${port}/api/contacts/import/preview`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ csv, mapping }),
    });
    return { status: res.status, body: await res.json() as { rows: { status: string; reason: string; name: string }[] } };
  } finally {
    server.close();
  }
}

const csv = (...rows: string[]) => ["First,Middle,Last,Phone,Email", ...rows].join("\n");
const existing = (over: Record<string, unknown>) => ({ id: "c1", firstName: "John", middleName: null, lastName: "Smith", email: null, phone: "9035551234", ...over });

beforeEach(() => { delete db.results["contact.findMany"]; });

describe("POST /contacts/import/preview — middle names", () => {
  it("name + phone: a different middle name is a new contact; a blank one on either side still matches", async () => {
    db.results["contact.findMany"] = [existing({ id: "c_b", middleName: "B" })];
    const other = await preview(csv("John,A,Smith,903-555-1234,"));
    expect(other.status).toBe(200);
    expect(other.body.rows[0]).toMatchObject({ status: "New", name: "John A Smith" });

    for (const middle of ["B", ""]) {
      const same = await preview(csv(`John,${middle},Smith,(903) 555-1234,`));
      expect(same.body.rows[0]).toMatchObject({ status: "Duplicate", reason: "Name + phone match an existing contact" });
    }

    // Without a middle name on file, either way matches.
    db.results["contact.findMany"] = [existing({ id: "c_none" })];
    expect((await preview(csv("John,A,Smith,9035551234,"))).body.rows[0].status).toBe("Duplicate");
  });

  it("within the file: two different middle names are two people; a repeat of either is a duplicate", async () => {
    const res = await preview(csv(
      "Mary,Ann,Hernandez,,",
      "Mary,Jo,Hernandez,,",
      "Mary,Ann,Hernandez,,",
    ));
    expect(res.body.rows.map((r) => r.status)).toEqual(["New", "New", "Error"]);
    expect(res.body.rows.map((r) => r.name)).toEqual(["Mary Ann Hernandez", "Mary Jo Hernandez", "Mary Ann Hernandez"]);
  });

  it("an email names one person whatever the middle names say", async () => {
    db.results["contact.findMany"] = [existing({ email: "js@example.com", middleName: "B" })];
    const res = await preview(csv("John,A,Smith,,JS@example.com", "John,C,Smith,,js@example.com"));
    expect(res.body.rows[0]).toMatchObject({ status: "Duplicate", reason: "Email matches an existing contact" });
    expect(res.body.rows[1]).toMatchObject({ status: "Error", reason: "Duplicate row within this file" });
  });
});
