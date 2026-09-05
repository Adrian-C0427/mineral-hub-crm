/**
 * Regression tests for the API security audit fixes.
 *
 * Only fixes that changed BEHAVIOUR are pinned here — tightening a gate is
 * covered by the gate itself. From 2026-07-22: the rewritten buyer-import dedup
 * pass, and the magic-byte validation on branding/photo data URLs. From
 * 2026-08-11: the production importer's row cap. From 2026-09-05: the
 * buyer-identity redaction on the research preview (an in-handler check, which
 * no route gate covers).
 */
import { describe, it, expect } from "vitest";
import { classifyParsed, REASON_IN_FILE, REASON_EXISTING, REASON_MISSING_COMPANY } from "./import.js";
import { isDeclaredRaster, LOGO_MIME } from "./org.js";
import { parseCsv as parseProductionCsv, MAX_PRODUCTION_IMPORT_ROWS } from "./wells.js";
import { MAX_INGEST_ROWS } from "../domain/researchIngest.js";
import { MAX_IMPORT_ROWS } from "./import.js";
import { MAX_SELECTABLE_IDS, canViewBuyers } from "./research.js";
import { normalizeCompany } from "../serializers.js";
import { DEFAULT_ROLE_PERMISSIONS, type Permission, type OrgRole } from "../domain/permissions.js";
import { cardSafeText } from "../services/notifyPush.js";
import type { AuthedRequest } from "../middleware/auth.js";

const rows = (...buyers: { companyName: string; email?: string | null }[]) =>
  buyers.map((buyer, index) => ({ index, buyer }));

describe("buyer import dedup", () => {
  it("flags a repeated company inside the same file", () => {
    // The pre-fix code mutated its `seen` sets after an await inside a
    // Promise.all, so every row's membership check ran before any row had been
    // recorded and in-file duplicates were never detected at all.
    const out = classifyParsed(
      rows({ companyName: "Permian Basin Royalties" }, { companyName: "Permian Basin Royalties" }),
      new Set(),
      new Set(),
    );
    expect(out[0].status).toBe("New");
    expect(out[1].status).toBe("Duplicate");
    expect(out[1].reason).toBe(REASON_IN_FILE);
  });

  it("flags a repeated email inside the same file even when companies differ", () => {
    const out = classifyParsed(
      rows(
        { companyName: "Acme Minerals", email: "buyer@example.com" },
        { companyName: "Acme Holdings", email: "buyer@example.com" },
      ),
      new Set(),
      new Set(),
    );
    expect(out[1].status).toBe("Duplicate");
    expect(out[1].reason).toBe(REASON_IN_FILE);
  });

  it("normalizes the company before comparing, so suffix variants collide", () => {
    const out = classifyParsed(
      rows({ companyName: "Acme Minerals LLC" }, { companyName: "Acme Minerals, L.L.C." }),
      new Set(),
      new Set(),
    );
    expect(out[1].status).toBe("Duplicate");
  });

  it("matches an existing org record by normalized company or exact email", () => {
    const out = classifyParsed(
      rows({ companyName: "Acme Minerals" }, { companyName: "Fresh Co", email: "known@example.com" }),
      new Set([normalizeCompany("Acme Minerals")]),
      new Set(["known@example.com"]),
    );
    expect(out.map((r) => r.reason)).toEqual([REASON_EXISTING, REASON_EXISTING]);
  });

  it("reports a missing company name as an error, not a duplicate", () => {
    const out = classifyParsed(rows({ companyName: "" }), new Set(), new Set());
    expect(out[0].status).toBe("Error");
    expect(out[0].reason).toBe(REASON_MISSING_COMPANY);
  });

  it("does not let blank company names collide with each other", () => {
    const out = classifyParsed(rows({ companyName: "" }, { companyName: "" }), new Set(), new Set());
    expect(out.every((r) => r.status === "Error")).toBe(true);
  });

  it("passes clean rows through as New", () => {
    const out = classifyParsed(
      rows({ companyName: "A Co", email: "a@x.com" }, { companyName: "B Co", email: "b@x.com" }),
      new Set(["unrelated"]),
      new Set(["other@x.com"]),
    );
    expect(out.every((r) => r.status === "New")).toBe(true);
  });
});

const dataUrl = (mime: string, bytes: number[]) =>
  `data:image/${mime};base64,${Buffer.from(bytes).toString("base64")}`;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
const WEBP = [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")];
const check = (s: string) => isDeclaredRaster(s, LOGO_MIME, 512 * 1024);

describe("branding data-URL validation", () => {
  it("accepts real PNG, JPEG, and WebP payloads", () => {
    expect(check(dataUrl("png", PNG))).toBe(true);
    expect(check(dataUrl("jpeg", JPEG))).toBe(true);
    // WebP is why this can't reuse services/s3.ts sniffMime — that allow-list
    // has no WebP entry, so routing logos through it would reject every .webp.
    expect(check(dataUrl("webp", WEBP))).toBe(true);
  });

  it("accepts the jpg spelling for JPEG bytes", () => {
    expect(check(dataUrl("jpg", JPEG))).toBe(true);
  });

  it("rejects arbitrary bytes wearing an image label", () => {
    // The whole point of the fix: the prefix is a claim by the uploader, and
    // this content is echoed on the PUBLIC portal.
    expect(check(dataUrl("png", [...Buffer.from("<svg onload=alert(1)>")]))).toBe(false);
    expect(check(dataUrl("png", [...Buffer.from("GIF89a")]))).toBe(false);
  });

  it("rejects a payload whose bytes are a different real image format", () => {
    expect(check(dataUrl("png", JPEG))).toBe(false);
    expect(check(dataUrl("webp", PNG))).toBe(false);
  });

  it("rejects non-image data URLs and empty payloads", () => {
    expect(check("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(check("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(check(dataUrl("png", []))).toBe(false);
    expect(check("not a data url")).toBe(false);
  });

  it("rejects a payload over the size cap without decoding it", () => {
    const huge = `data:image/png;base64,${"A".repeat(1024 * 1024)}`;
    expect(check(huge)).toBe(false);
  });
});

describe("role defaults", () => {
  it("keeps VIEWER free of every write permission on well analysis", () => {
    expect(DEFAULT_ROLE_PERMISSIONS.VIEWER).not.toContain("manageWellAnalysis");
  });

  it("gives MEMBER the write permission its saved-analysis workflow needs", () => {
    // The audit moved POST/PATCH/DELETE /wells/analyses and /wells/import-rrc
    // off the view gate; MEMBER must hold the write gate or the move would have
    // silently broken everyday use.
    expect(DEFAULT_ROLE_PERMISSIONS.MEMBER).toContain("manageWellAnalysis");
    expect(DEFAULT_ROLE_PERMISSIONS.MANAGER).toContain("manageWellAnalysis");
  });
});

describe("Teams card text sanitization", () => {
  // An Adaptive Card TextBlock renders markdown, and portal.ts feeds it strings
  // that came from UNAUTHENTICATED lead/offer submissions. Without this, anyone
  // holding a portal URL could author a clickable link inside the org's own
  // Teams channel — content that arrives wearing the trust of an internal bot.
  const big = 10_000;

  it("defuses a markdown hyperlink", () => {
    const out = cardSafeText("[Verify your account](https://evil.example/login)", big);
    expect(out).not.toContain("](");
    expect(out).toContain("\\[");
  });

  it("strips URL schemes, which Teams autolinks even without markdown", () => {
    // Escaping alone cannot fix this one: a bare https:// URL is linkified by
    // the client with no markdown syntax involved at all.
    expect(cardSafeText("go to https://evil.example now", big)).not.toContain("https://");
    expect(cardSafeText("javascript:alert(1)", big)).not.toContain("javascript:");
    expect(cardSafeText("data:text/html,<b>", big)).not.toContain("data:");
  });

  it("neutralizes emphasis and block syntax", () => {
    // Asserted as an exact string: every marker must come back backslash-escaped
    // so the renderer prints it literally instead of acting on it.
    expect(cardSafeText("**bold** _em_ `code` # head > quote", big))
      .toBe("\\*\\*bold\\*\\* \\_em\\_ \\`code\\` \\# head \\> quote");
  });

  it("caps length so a 4,000-character submission can't flood the channel", () => {
    const out = cardSafeText("a".repeat(5_000), 600);
    expect(out.length).toBe(601); // 600 + the ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("measures the cap against the escaped string, not the input", () => {
    // Escaping can more than double the length; bounding the input instead
    // would let a payload of pure punctuation blow past the cap.
    expect(cardSafeText("[".repeat(500), 100).length).toBe(101);
  });

  it("never leaves a dangling backslash that would escape the ellipsis", () => {
    // Truncating mid-escape-pair is the edge case: "\\" + "…" would render the
    // ellipsis literally and, worse, re-enable the next character.
    expect(cardSafeText(`${"a".repeat(99)}[rest`, 100)).not.toContain("\\…");
  });

  it("keeps a complete escape pair intact when the cut lands right after it", () => {
    // An even run of trailing backslashes is a fully-escaped literal `\`.
    // Dropping one to "be safe" would leave a lone backslash — creating the very
    // dangling escape the odd-run check exists to prevent.
    // 98 a's + a literal backslash escapes to 98 a's + "\\", exactly 100 chars.
    const out = cardSafeText(`${"a".repeat(98)}\\rest`, 100);
    expect(out).toBe(`${"a".repeat(98)}\\\\…`);
  });

  it("leaves ordinary notification text readable", () => {
    expect(cardSafeText("New portal lead", big)).toBe("New portal lead");
  });
});

describe("production import row cap", () => {
  // wells.ts was the one CSV path bounded only by MAX_CSV_CHARS (15M). A
  // production row is ~20 bytes, so that permitted ~750k rows — each held three
  // times over in memory, each DISTINCT well costing its own DB round-trip.
  const csv = (n: number) =>
    ["wellName,month", ...Array.from({ length: n }, (_, i) => `WELL-${i},2024-01`)].join("\n");

  it("rejects a file over the cap instead of parsing it", () => {
    expect(() => parseProductionCsv(csv(MAX_PRODUCTION_IMPORT_ROWS + 1))).toThrow(/too many rows/);
  });

  it("accepts a file exactly at the cap", () => {
    expect(parseProductionCsv(csv(MAX_PRODUCTION_IMPORT_ROWS)).rows).toHaveLength(MAX_PRODUCTION_IMPORT_ROWS);
  });

  it("still parses an ordinary file", () => {
    const { headers, rows } = parseProductionCsv("wellName,month,oilBbl\nSMITH 1H,2024-01,120");
    expect(headers).toEqual(["wellName", "month", "oilBbl"]);
    expect(rows).toEqual([{ wellName: "SMITH 1H", month: "2024-01", oilBbl: "120" }]);
  });

  it("leaves every CSV entry point bounded", () => {
    // The gap this closed was a MISSING bound, not a wrong number — so the
    // invariant worth guarding is that all four importers still have one.
    for (const cap of [MAX_PRODUCTION_IMPORT_ROWS, MAX_IMPORT_ROWS, MAX_INGEST_ROWS]) {
      expect(cap).toBeGreaterThan(0);
      expect(cap).toBeLessThanOrEqual(50_000);
    }
  });
});

describe("whole-dataset selection cap", () => {
  // /research/records/ids ("Select all") returned an UNBOUNDED findMany — the
  // pattern the rest of the API caps. The invariant worth guarding is that the
  // ceiling exists, stays bounded, and stays above the 5000-id bulk-delete cap
  // the client chunks a large selection into, so select-all remains usable.
  it("keeps the id selection bounded and chunk-compatible", () => {
    expect(MAX_SELECTABLE_IDS).toBeGreaterThan(5_000);
    expect(MAX_SELECTABLE_IDS).toBeLessThanOrEqual(500_000);
  });
});

describe("research preview buyer redaction", () => {
  // POST /research/buyers/preview is gated on viewResearch, but its `existing`
  // and `mergePreview` fields describe a CRM BUYER, not research data. The two
  // permissions are independently assignable, so the identity half of that
  // response needs its own check — and because it is an in-handler conditional
  // rather than a route gate, nothing else pins it.
  const req = (orgRole: OrgRole, permissions: Permission[]) =>
    ({ user: { orgRole, permissions } }) as unknown as AuthedRequest;

  it("withholds buyer identity from a research-only role", () => {
    expect(canViewBuyers(req("MEMBER", ["viewResearch"]))).toBe(false);
  });

  it("releases it to a role that also holds viewBuyers", () => {
    expect(canViewBuyers(req("MEMBER", ["viewResearch", "viewBuyers"]))).toBe(true);
  });

  it("lets the owner through on orgRole alone", () => {
    // OWNER holds every permission implicitly, so the role check — not the
    // list — is what must cover it. Mirrors requirePermission.
    expect(canViewBuyers(req("OWNER", []))).toBe(true);
  });

  it("stays inert for every shipped role", () => {
    // The redaction should only ever bite a CUSTOM role. If a default role were
    // given viewResearch without viewBuyers, the Research workspace would start
    // hiding matches for it — a product decision, and not one to make silently.
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      if (perms.includes("viewResearch")) {
        expect(perms, `${role} holds viewResearch`).toContain("viewBuyers");
      }
    }
  });
});

describe("source encoding", () => {
  // routes/research.ts carried two literal NUL bytes (used as a composite-key
  // delimiter in a template literal). Functionally harmless, but `file` reported
  // the 1,686-line source as binary data and grep SILENTLY skipped it — exit
  // code 1, no match, no warning. Every grep-driven control (secret scanning, CI
  // policy greps, "which endpoints lack requirePermission" sweeps) therefore
  // reported that file clean without ever reading it. This guards the class, not
  // the one file — and it earned that scope immediately: written to cover
  // server/src, it caught two more NUL-carrying sources the audit's own greps had
  // silently skipped (domain/researchGraph.ts and client/src/lib/dealSearch.ts).
  // So it walks the whole repo, both packages.
  it("keeps every source free of NUL bytes so grep-based scanning sees them", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    // server/src/routes/ -> repo root
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);
    const SCAN = /\.(ts|tsx|js|jsx|json|prisma|css|md)$/;

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        if (SKIP.has(entry)) return [];
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : SCAN.test(full) ? [full] : [];
      });

    const offenders = walk(repoRoot)
      .filter((f) => readFileSync(f).includes(0x00))
      .map((f) => f.slice(repoRoot.length + 1));
    expect(offenders).toEqual([]);
  });
});
