/**
 * Cloud files (OneDrive + Google Drive) against stubbed provider APIs: name
 * and id safety, cursor validation (no SSRF), never-overwrite conflict
 * handling, chunked uploads, Google-native exports, change-feed resets, and a
 * sync that marks vanished files MISSING instead of deleting links.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedAccount } from "@prisma/client";

const db = vi.hoisted(() => {
  const links: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    connectedAccount: {
      findUnique: async () => null,
      update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return data; },
    },
    cloudFileLink: {
      // The sync's re-check asks only for links not confirmed recently (OR on lastCheckedAt).
      findMany: async ({ where }: { where: { OR?: unknown } }) =>
        links.filter((l) => !where.OR || !l.lastCheckedAt).map((l) => ({ providerFileId: l.providerFileId })),
      updateMany: async ({ where, data }: { where: { providerFileId: string }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const l of links) if (l.providerFileId === where.providerFileId) { Object.assign(l, data); count++; }
        return { count };
      },
    },
  };
  return { prisma, links, updates };
});
vi.mock("../../db.js", () => ({ prisma: db.prisma }));

import { sealTokens } from "../connected/oauth.js";
import { safeCloudName, safeItemId, checkUploadType, contentDisposition, driveQ } from "./safety.js";
import { oneDrive } from "./onedrive.js";
import { googleDrive } from "./gdrive.js";
import { syncAccount } from "../connected/sync.js";
import "./index.js";

const realFetch = globalThis.fetch;
let calls: { url: string; method: string; headers: Headers; body: unknown }[] = [];
function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers), body: init.body });
    return handler(url, init);
  }) as typeof fetch;
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });

function acct(provider: "onedrive" | "googledrive"): ConnectedAccount {
  return {
    id: "a1", organizationId: "o1", userId: "u1", provider, providerAccountId: "p1", email: "me@carsa.test", displayName: "Me",
    scopes: [], status: "CONNECTED", tokens: sealTokens({ access_token: "AT", refresh_token: "RT", expires_at: Date.now() + 3_600_000 }),
    syncStatus: "IDLE", syncState: null, lastSyncAt: null, lastSyncAttemptAt: null, lastError: null, autoLinkEmail: true,
    connectedAt: new Date(), disconnectedAt: null, createdAt: new Date(), updatedAt: new Date(),
  } as ConnectedAccount;
}

beforeEach(() => { db.links.length = 0; db.updates.length = 0; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("safety", () => {
  it("names can't climb out of a folder or carry control/reserved characters", () => {
    expect(safeCloudName("../../etc/passwd")).toBe("passwd");
    expect(safeCloudName("C:\\Users\\x\\Deed: Smith?.pdf")).toBe("Deed_ Smith_.pdf");
    expect(safeCloudName("  report\u0007.pdf  ")).toBe("report.pdf");
    expect(() => safeCloudName("CON")).toThrow();
    expect(() => safeCloudName("...")).toThrow();
    expect(safeCloudName("a".repeat(300) + ".pdf").endsWith(".pdf")).toBe(true);
  });
  it("ids are opaque URL-safe tokens only", () => {
    expect(safeItemId("01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K")).toBeTruthy();
    expect(safeItemId("D4648F06C91D9D3D!54927")).toBeTruthy();
    expect(() => safeItemId("x' or '1'='1")).toThrow();
    expect(() => safeItemId("../x")).toThrow();
  });
  it("Drive query literals are escaped", () => {
    expect(driveQ("O'Brien \\ x")).toBe("O\\'Brien \\\\ x");
  });
  it("upload types are sniffed, not trusted", () => {
    expect(checkUploadType(Buffer.from("%PDF-1.7"), "application/pdf", "a.pdf")).toBe("application/pdf");
    expect(() => checkUploadType(Buffer.from("MZ\x90\x00"), "application/pdf", "evil.pdf")).toThrow();
    expect(checkUploadType(Buffer.from([0x50, 0x4b, 0x03, 0x04]), "application/vnd.openxmlformats-officedocument.presentationml.presentation", "deck.pptx")).toContain("presentation");
  });
  it("download names are header-safe", () => {
    expect(contentDisposition('a"b\r\nc.pdf')).toMatch(/^attachment; filename="a_b__c.pdf"; filename\*=UTF-8''a%22b%0D%0Ac.pdf$/);
  });
});

describe("OneDrive", () => {
  it("lists folders first and refuses forged page cursors", async () => {
    stub(() => json({ value: [{ id: "f2", name: "b.pdf", file: { mimeType: "application/pdf" } }, { id: "f1", name: "Deeds", folder: { childCount: 2 } }] }));
    const page = await oneDrive.list(acct("onedrive"), null, null, "mine");
    expect(page.items.map((i) => i.name)).toEqual(["Deeds", "b.pdf"]);
    await expect(oneDrive.list(acct("onedrive"), null, "https://graph.microsoft.com/v1.0/me/messages?$skip=10", "mine")).rejects.toMatchObject({ kind: "invalid" });
    await expect(oneDrive.list(acct("onedrive"), null, "https://evil.test/v1.0/me/drive/x", "mine")).rejects.toMatchObject({ kind: "invalid" });
  });

  it("uploads small files with conflictBehavior=fail (never replace)", async () => {
    stub(() => json({ id: "n1", name: "a.pdf", file: { mimeType: "application/pdf" } }, 201));
    await oneDrive.upload(acct("onedrive"), "fold1", { name: "a b.pdf", mimeType: "application/pdf", sizeBytes: 5, read: async () => Buffer.from("%PDF-") }, "fail");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/me/drive/items/fold1:/a%20b.pdf:/content?@microsoft.graph.conflictBehavior=fail");
  });

  it("uploads large files in 320 KiB-multiple chunks without sending the token to the upload URL", async () => {
    const size = 12 * 1024 * 1024;
    stub((url, init) => {
      if (url.includes("createUploadSession")) return json({ uploadUrl: "https://tenant.sharepoint.com/upload/session1" });
      const range = new Headers(init.headers).get("content-range")!;
      return range.endsWith(`-${size - 1}/${size}`) ? json({ id: "big", name: "big.pdf" }, 201) : json({ nextExpectedRanges: [] }, 202);
    });
    const item = await oneDrive.upload(acct("onedrive"), null, { name: "big.pdf", mimeType: "application/pdf", sizeBytes: size, read: async (_o, l) => Buffer.alloc(l) }, "fail");
    expect(item.id).toBe("big");
    const puts = calls.filter((c) => c.url.startsWith("https://tenant.sharepoint.com"));
    expect(puts.map((c) => c.headers.get("content-range"))).toEqual([`bytes 0-10485759/${size}`, `bytes 10485760-${size - 1}/${size}`]);
    expect(puts.every((c) => !c.headers.get("authorization"))).toBe(true);
    expect((10 * 1024 * 1024) % (320 * 1024)).toBe(0);
  });

  it("an expired delta cursor (410) resets instead of failing", async () => {
    stub(() => json({ error: { code: "resyncRequired" } }, 410));
    const r = await oneDrive.changes(acct("onedrive"), "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=abc");
    expect(r.reset).toBe(true);
  });
});

describe("Google Drive", () => {
  it("exports Docs/Sheets/Slides instead of downloading bytes", async () => {
    stub((url) => url.includes("/export")
      ? new Response("pdfbytes", { status: 200 })
      : json({ id: "d1", name: "Lease", mimeType: "application/vnd.google-apps.document", capabilities: { canDownload: true } }));
    const d = await googleDrive.download(acct("googledrive"), "d1", "docx");
    expect(d.filename).toBe("Lease.docx");
    expect(calls[1].url).toContain("/files/d1/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("refuses to overwrite an existing name, or picks a free one when asked", async () => {
    const q = (url: string) => new URL(url).searchParams.get("q") ?? "";
    stub((url) => (q(url).includes("name = 'a.pdf'") ? json({ files: [{ id: "x", name: "a.pdf" }] }) : json({ files: [] })));
    await expect(googleDrive.createFolder(acct("googledrive"), null, "a.pdf")).rejects.toMatchObject({ kind: "conflict" });
    stub((url, init) => {
      if (init.method === "PUT") return json({ id: "new", name: "a (1).pdf", mimeType: "application/pdf" });
      if (url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { location: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=U1" } });
      return q(url).includes("name = 'a.pdf'") ? json({ files: [{ id: "x" }] }) : json({ files: [] });
    });
    const item = await googleDrive.upload(acct("googledrive"), null, { name: "a.pdf", mimeType: "application/pdf", sizeBytes: 4, read: async () => Buffer.from("%PDF") }, "rename");
    expect(item.name).toBe("a (1).pdf");
    expect(JSON.parse(String(calls.find((c) => c.url.includes("uploadType=resumable"))!.body)).name).toBe("a (1).pdf");
  });

  it("trashes (recoverable) rather than deleting", async () => {
    stub(() => json({}));
    await googleDrive.trash(acct("googledrive"), "d1", null);
    expect(calls[0].method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].body))).toEqual({ trashed: true });
  });
});

describe("drive sync", () => {
  it("updates renamed linked files and marks deleted ones MISSING — never removes links", async () => {
    db.links.push({ providerFileId: "f1", name: "old.pdf", status: "OK" }, { providerFileId: "f2", name: "gone.pdf", status: "OK" });
    (db.prisma as unknown as { user: unknown }).user = { findUnique: async () => ({ organizationId: "o1" }) };
    stub((url) => {
      if (url.includes("/me?$select=")) return json({ mail: "me@carsa.test", displayName: "Me" });
      if (url.includes("/root/delta")) {
        return json({ value: [{ id: "f1", name: "new.pdf", file: { mimeType: "application/pdf" } }, { id: "f2", deleted: {} }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=next" });
      }
      return json({ id: "f1", name: "new.pdf", file: { mimeType: "application/pdf" } });
    });
    const a = { ...acct("onedrive"), syncState: { changes: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=prev" } } as ConnectedAccount;
    const r = await syncAccount(a, { manual: true });
    expect(r.ok).toBe(true);
    expect(db.links.find((l) => l.providerFileId === "f1")).toMatchObject({ name: "new.pdf", status: "OK" });
    expect(db.links.find((l) => l.providerFileId === "f2")).toMatchObject({ status: "MISSING" });
    expect(db.links).toHaveLength(2);
    expect(db.updates.some((u) => (u.syncState as { changes?: string } | undefined)?.changes?.includes("token=next"))).toBe(true);
  });
});
