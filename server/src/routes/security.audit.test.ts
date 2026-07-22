/**
 * Regression tests for the 2026-07-22 API security audit fixes.
 *
 * Two of those fixes changed behaviour rather than just tightening a gate, so
 * they are pinned here: the rewritten buyer-import dedup pass, and the
 * magic-byte validation now applied to branding/photo data URLs.
 */
import { describe, it, expect } from "vitest";
import { classifyParsed, REASON_IN_FILE, REASON_EXISTING, REASON_MISSING_COMPANY } from "./import.js";
import { isDeclaredRaster, LOGO_MIME } from "./org.js";
import { normalizeCompany } from "../serializers.js";
import { DEFAULT_ROLE_PERMISSIONS } from "../domain/permissions.js";

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
