import { describe, expect, it } from "vitest";
import { demoBlockReason } from "./demo.js";

const blocked = (m: string, p: string, body?: unknown) => demoBlockReason(m, p, body) !== null;

describe("demo guard policy", () => {
  it("never blocks reads", () => {
    for (const p of ["/api/deals", "/api/research/documents", "/api/org", "/api/integrations", "/api/users"]) {
      expect(blocked("GET", p)).toBe(false);
      expect(blocked("HEAD", p)).toBe(false);
    }
  });

  it("lets demo users work normally: create and edit their own records", () => {
    expect(blocked("POST", "/api/deals")).toBe(false);
    expect(blocked("PATCH", "/api/deals/abc")).toBe(false);
    expect(blocked("POST", "/api/deals/abc/stage")).toBe(false);
    expect(blocked("POST", "/api/offers")).toBe(false);
    expect(blocked("POST", "/api/buyers")).toBe(false);
    expect(blocked("POST", "/api/contacts")).toBe(false);
    expect(blocked("POST", "/api/expenses")).toBe(false);
    expect(blocked("POST", "/api/calendar/events")).toBe(false);
    expect(blocked("POST", "/api/wells/import-rrc")).toBe(false); // map → well analysis
    expect(blocked("POST", "/api/deals/abc/email")).toBe(false); // delivery suppressed in email service
    expect(blocked("PATCH", "/api/files/f1")).toBe(false);
    expect(blocked("POST", "/api/expenses/bulk", { action: "reimburse" })).toBe(false);
    expect(blocked("POST", "/api/research/buyers/preview")).toBe(false);
    expect(blocked("POST", "/api/research/relationships/transactions")).toBe(false);
    expect(blocked("POST", "/api/auth/logout")).toBe(false);
    expect(blocked("PUT", "/api/auth/preferences")).toBe(false);
    expect(blocked("DELETE", "/api/notifications/n1")).toBe(false);
  });

  it("blocks every delete, single or bulk", () => {
    expect(blocked("DELETE", "/api/deals/abc")).toBe(true);
    expect(blocked("DELETE", "/api/buyers/abc")).toBe(true);
    expect(blocked("DELETE", "/api/pipeline/p1")).toBe(true);
    expect(blocked("POST", "/api/deals/bulk-delete")).toBe(true);
    expect(blocked("POST", "/api/buyers/bulk-delete")).toBe(true);
    expect(blocked("POST", "/api/contacts/bulk-delete")).toBe(true);
    expect(blocked("POST", "/api/expenses/bulk", { action: "delete" })).toBe(true);
  });

  it("locks settings, team, integrations, security and AI", () => {
    expect(blocked("POST", "/api/integrations/resend/connect")).toBe(true);
    expect(blocked("PATCH", "/api/org/branding")).toBe(true);
    expect(blocked("POST", "/api/org/invites")).toBe(true);
    expect(blocked("PUT", "/api/org/roles/MEMBER")).toBe(true);
    expect(blocked("POST", "/api/org/team-id/rotate")).toBe(true);
    expect(blocked("POST", "/api/users")).toBe(true);
    expect(blocked("POST", "/api/auth/change-password")).toBe(true);
    expect(blocked("PATCH", "/api/auth/me")).toBe(true);
    expect(blocked("POST", "/api/auth/2fa/setup")).toBe(true);
    expect(blocked("POST", "/api/auth/join")).toBe(true);
    expect(blocked("POST", "/api/ai/deals/abc/summary")).toBe(true);
  });

  it("blocks uploads/imports and writes to shared research/map reference data", () => {
    expect(blocked("POST", "/api/files")).toBe(true);
    expect(blocked("POST", "/api/files/f1/replace")).toBe(true);
    expect(blocked("POST", "/api/files/cloud/onedrive/import")).toBe(true);
    expect(blocked("POST", "/api/import/commit")).toBe(true);
    expect(blocked("POST", "/api/buyers/import/commit")).toBe(true);
    expect(blocked("POST", "/api/contacts/import/commit")).toBe(true);
    expect(blocked("POST", "/api/wells/import/commit")).toBe(true);
    expect(blocked("POST", "/api/research/ingest/commit")).toBe(true);
    expect(blocked("POST", "/api/research/records/bulk")).toBe(true);
    expect(blocked("POST", "/api/research/ingest/runs/delete")).toBe(true);
    expect(blocked("POST", "/api/map/tracts/import")).toBe(true);
  });

  it("is not fooled by trailing slashes or case", () => {
    expect(blocked("post", "/api/org/invites/")).toBe(true);
    expect(blocked("delete", "/api/deals/abc/")).toBe(true);
  });
});
