/**
 * Outlook mail: HTML safety + Outlook-like assembly, signature import, the
 * send pipeline's idempotency / accurate status / attachments, and webhook
 * verification — against a fake database and a stubbed Graph.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedAccount } from "@prisma/client";

const db = vi.hoisted(() => {
  const messages = new Map<string, Record<string, unknown>>();
  const signatures: Record<string, unknown>[] = [];
  const subs: Record<string, unknown>[] = [];
  let n = 0;
  const prisma = {
    emailMessage: {
      findUnique: async ({ where }: { where: { accountId_clientRequestId?: { clientRequestId: string } } }) =>
        [...messages.values()].find((m) => m.clientRequestId === where.accountId_clientRequestId?.clientRequestId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `m${++n}`, createdAt: new Date(), ...data }; messages.set(row.id, row); return row; },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = { ...messages.get(where.id)!, ...data };
        if (typeof (data.attempts as { increment?: number })?.increment === "number") row.attempts = 1;
        messages.set(where.id, row); return row;
      },
    },
    emailSignature: {
      findFirst: async ({ where }: { where: { id?: string; defaultNew?: boolean } }) => signatures.find((s) => (where.id ? s.id === where.id : where.defaultNew ? s.defaultNew : s.defaultReply)) ?? null,
    },
    providerSubscription: {
      findUnique: async ({ where }: { where: { subscriptionId: string } }) => subs.find((s) => s.subscriptionId === where.subscriptionId) ?? null,
      update: async () => ({}), delete: async () => ({}),
    },
  };
  return { prisma, messages, signatures, subs };
});
vi.mock("../../db.js", () => ({ prisma: db.prisma }));
vi.mock("./links.js", () => ({
  linkEmail: async () => {}, recordTimeline: async () => {}, dealOutreach: async () => {},
  matchAddresses: async () => ({ refs: [], buyerByEmail: new Map() }), teamAddresses: async () => [],
}));
const nudged: string[] = [];
vi.mock("../connected/sync.js", () => ({ requestAccountSync: (id: string) => nudged.push(id), registerAccountSyncer: () => {} }));

import { sealTokens } from "../connected/oauth.js";
import { newMessageBody, replyBody, sanitizeComposed, sanitizeReceived, sanitizeSignature, htmlToText } from "./html.js";
import { prepareSignature } from "./signatures.js";
import { sendEmailNow, type SendInput } from "./send.js";
import { handleNotifications } from "./subscriptions.js";

const realFetch = globalThis.fetch;
let calls: { url: string; method: string; body: string }[] = [];
function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), body: typeof init.body === "string" ? init.body : "" });
    return handler(url, init);
  }) as typeof fetch;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const account = (): ConnectedAccount => ({
  id: "acc1", organizationId: "o1", userId: "u1", provider: "outlook", providerAccountId: "ms1", email: "adrian@carsa.test", displayName: "Adrian Campos",
  scopes: ["mail.readwrite", "mail.send"], status: "CONNECTED", tokens: sealTokens({ access_token: "AT", refresh_token: "RT", expires_at: Date.now() + 3_600_000 }),
  syncStatus: "IDLE", syncState: null, lastSyncAt: null, lastSyncAttemptAt: null, lastError: null, autoLinkEmail: true,
  connectedAt: new Date(), disconnectedAt: null, createdAt: new Date(), updatedAt: new Date(),
} as ConnectedAccount);

const input = (over: Partial<SendInput> = {}): SendInput => ({
  account: account(), userId: "u1", mode: "new", to: [{ name: "Riley", address: "riley@buyer.test" }], cc: [], bcc: [],
  subject: "Leon County minerals", html: "<p>Hi Riley,</p>", attachments: [], links: [], clientRequestId: crypto.randomUUID(), ...over,
});

beforeEach(() => { db.messages.clear(); db.signatures.length = 0; db.subs.length = 0; nudged.length = 0; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("email HTML", () => {
  it("received mail keeps its formatting but loses anything that runs", () => {
    const out = sanitizeReceived(`<table style="color:#123"><tr><td><a href="javascript:alert(1)" onclick="x()">x</a><img src="https://cdn.test/logo.png" onerror="x()"></td></tr></table><script>alert(1)</script><iframe src="https://e.test"></iframe><style>.a{color:red}</style>`);
    expect(out).toContain('style="color:#123"');
    expect(out).toContain("https://cdn.test/logo.png");
    expect(out).toContain("<style>");
    expect(out).not.toMatch(/script|onclick|onerror|javascript:|iframe/i);
  });
  it("a signature pasted into the message text is dropped (the chosen one is added once)", () => {
    expect(sanitizeComposed('<p>Hello</p><div id="Signature"><b>Old sig</b></div>')).toBe("<p>Hello</p>");
  });
  it("new messages: text in Outlook's compose font, then the signature block", () => {
    const html = newMessageBody("<p>Hi</p>", "<b>Adrian</b>");
    expect(html).toMatch(/<body><div class="elementToProof" style="font-family: Aptos[^"]*"><p>Hi<\/p><\/div><div id="Signature"><b>Adrian<\/b><\/div><\/body>/);
    expect(html).not.toMatch(/Mineral Hub|CRM/);
  });
  it("replies go above Microsoft's quoted thread, without doubling a signature", () => {
    const draft = `<html><head></head><body><div id="Signature">old</div><hr><div id="divRplyFwdMsg">From: Riley</div><div>original <div id="Signature">their sig</div></div></body></html>`;
    const out = replyBody("<p>Thanks</p>", "<b>Adrian</b>", draft);
    expect(out.indexOf("Thanks")).toBeLessThan(out.indexOf("divRplyFwdMsg"));
    expect(out.match(/<b>Adrian<\/b>/g)).toHaveLength(1);
    expect(out).not.toContain(">old<");
    expect(out).toContain("their sig"); // the quoted history is untouched
  });
  it("signatures keep Outlook's styling, drop scripts, and only allow https/cid images", () => {
    const out = sanitizeSignature(`<html><head><style>p.MsoNormal{font-family:Aptos;}@import url(x.css);</style></head><body><p class="MsoNormal" style="color:#1F4E79"><a href="https://carsa.test">Carsa</a><img src="http://insecure.test/a.png"><img src="cid:abc"></p><script>x</script></body></html>`);
    expect(out).toContain("p.MsoNormal{font-family:Aptos;}");
    expect(out).not.toContain("@import");
    expect(out).toContain('style="color:#1F4E79"');
    expect(out).toContain('src="cid:abc"');
    expect(out).not.toContain("insecure.test");
    expect(out).not.toContain("<script");
  });
  it("text previews", () => {
    expect(htmlToText("<div>Hi&nbsp;there</div><div>Line 2</div>")).toBe("Hi there\nLine 2");
  });
});

describe("signature import", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  it("embedded images become inline attachments; local files are matched by name or reported", () => {
    const html = `<p>Adrian</p><img src="data:image/png;base64,${png.toString("base64")}"><img src="file:///C:/Users/a/AppData/Roaming/Microsoft/Signatures/Main_files/image002.png"><img src="Main_files/logo.png"><img src="https://carsa.test/badge.png">`;
    const r = prepareSignature(html, [{ filename: "logo.png", mimeType: "image/png", data: png }]);
    expect(r.assets).toHaveLength(2);
    expect(r.assets.every((a) => r.html.includes(`cid:${a.contentId}`))).toBe(true);
    expect(r.missing).toEqual(["image002.png"]);
    expect(r.html).toContain("https://carsa.test/badge.png");
  });
  it("refuses an empty result", () => {
    expect(() => prepareSignature("<script>x</script>", [])).toThrow();
  });
});

describe("sending through Outlook", () => {
  it("draft → attachments (inline signature image first) → send, then SENT", async () => {
    db.signatures.push({ id: "s1", accountId: "acc1", defaultNew: true, defaultReply: false, html: '<b>Adrian</b><img src="cid:logo1">', assets: [{ contentId: "logo1", filename: "logo.png", mimeType: "image/png", data: Buffer.from("png") }] });
    stub((url) => (url.endsWith("/me/messages") ? json({ id: "draft1" }, 201) : url.includes("$select=conversationId") ? json({ conversationId: "c1" }) : json({}, url.endsWith("/send") ? 202 : 201)));
    const sent = await sendEmailNow(input({ attachments: [{ name: "PSA.pdf", contentType: "application/pdf", size: 4, read: async () => Buffer.from("%PDF") }] }));
    expect(sent.sendStatus).toBe("SENT");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`).slice(0, 4)).toEqual([
      "POST /v1.0/me/messages", "POST /v1.0/me/messages/draft1/attachments", "POST /v1.0/me/messages/draft1/attachments", "POST /v1.0/me/messages/draft1/send",
    ]);
    const created = JSON.parse(calls[0].body);
    expect(created.body.content).toContain('<div id="Signature"><b>Adrian</b><img src="cid:logo1"></div>');
    expect(created.toRecipients).toEqual([{ emailAddress: { address: "riley@buyer.test", name: "Riley" } }]);
    const inline = JSON.parse(calls[1].body);
    expect(inline).toMatchObject({ isInline: true, contentId: "logo1", name: "logo.png" });
    expect(JSON.parse(calls[2].body)).toMatchObject({ name: "PSA.pdf", isInline: false });
  });

  it("a retried request never sends twice", async () => {
    stub((url) => (url.endsWith("/me/messages") ? json({ id: "d1" }, 201) : json({}, 202)));
    const i = input();
    await sendEmailNow(i);
    const before = calls.length;
    const again = await sendEmailNow({ ...i });
    expect(again.sendStatus).toBe("SENT");
    expect(calls.length).toBe(before);
  });

  it("if Microsoft rejects the send, it's FAILED and the draft is removed", async () => {
    stub((url, init) => {
      if (url.endsWith("/me/messages")) return json({ id: "d2" }, 201);
      if (url.endsWith("/send")) return json({ error: { code: "ErrorInvalidRecipients", message: "Invalid recipient" } }, 400);
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return json({});
    });
    await expect(sendEmailNow(input())).rejects.toBeTruthy();
    const row = [...db.messages.values()][0];
    expect(row.sendStatus).toBe("FAILED");
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/me/messages/d2"))).toBe(true);
  });

  it("an unknown /send outcome is settled by asking Outlook (no longer a draft → SENT)", async () => {
    stub((url) => {
      if (url.endsWith("/me/messages")) return json({ id: "d3" }, 201);
      if (url.endsWith("/send")) throw new TypeError("fetch failed");
      if (url.includes("$select=isDraft")) return json({ isDraft: false });
      return json({});
    });
    const sent = await sendEmailNow(input());
    expect(sent.sendStatus).toBe("SENT");
  });

  it("replies are created by Microsoft from the original (threading) and keep the quote", async () => {
    stub((url) => {
      if (url.includes("/createReply")) return json({ id: "r1", body: { content: '<html><body><hr><div id="divRplyFwdMsg">From: Riley</div></body></html>' } }, 201);
      return json({}, url.endsWith("/send") ? 202 : 200);
    });
    await sendEmailNow(input({ mode: "reply", sourceMessageId: "orig1", signatureId: null }));
    expect(calls[0].url).toMatch(/\/me\/messages\/orig1\/createReply$/);
    const patch = calls.find((c) => c.method === "PATCH")!;
    const body = JSON.parse(patch.body).body.content as string;
    expect(body.indexOf("Hi Riley")).toBeLessThan(body.indexOf("divRplyFwdMsg"));
    expect(body).not.toContain('id="Signature"'); // "no signature" was chosen
  });
});

describe("Graph change notifications", () => {
  it("act only on a known subscription with the right secret", async () => {
    const secret = "s3cret-value";
    db.subs.push({ id: "p1", subscriptionId: "sub1", accountId: "acc1", clientStateHash: crypto.createHash("sha256").update(secret).digest("hex") });
    expect(await handleNotifications([{ subscriptionId: "sub1", clientState: "wrong" }, { subscriptionId: "nope", clientState: secret }])).toBe(0);
    expect(nudged).toEqual([]);
    expect(await handleNotifications([{ subscriptionId: "sub1", clientState: secret }])).toBe(1);
    expect(nudged).toEqual(["acc1"]);
  });
});
