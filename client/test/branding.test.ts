/**
 * Org logo selection (client/src/lib/branding.ts): which logo each branding
 * slot renders, and when it falls back to the default Mineral Hub mark.
 *
 * Kept outside src/ so the client build's typecheck never needs vitest.
 * Run: cd client && ../node_modules/.bin/vitest run
 */
import { describe, it, expect } from "vitest";
import { LEGACY_BRANDING_KEY, pickLogo, purgeLegacyBrandingCache, usableLogo } from "../src/lib/branding";

const FULL = "data:image/png;base64,iVBORw0KGgoFULL";
const MARK = "data:image/webp;base64,UklGRMARK";

describe("usableLogo", () => {
  it("accepts image data URLs and http(s)/root-relative URLs", () => {
    expect(usableLogo(FULL)).toBe(FULL);
    expect(usableLogo("data:image/svg+xml;base64,PHN2Zz4=")).toBe("data:image/svg+xml;base64,PHN2Zz4=");
    expect(usableLogo("https://cdn.example.com/logo.png")).toBe("https://cdn.example.com/logo.png");
    expect(usableLogo("/api/org/logo")).toBe("/api/org/logo");
  });

  it("treats missing, empty, and non-image values as no logo", () => {
    for (const v of [null, undefined, "", "   ", "data:text/html;base64,PGI+", "javascript:alert(1)", "logo.png"]) {
      expect(usableLogo(v), String(v)).toBeNull();
    }
  });

  it("skips a source that already failed to decode", () => {
    expect(usableLogo(FULL, new Set([FULL]))).toBeNull();
    expect(usableLogo(FULL, new Set([MARK]))).toBe(FULL);
  });
});

describe("pickLogo — slot fallback", () => {
  const both = { fullLogo: FULL, compactLogo: MARK };

  it("each slot prefers its own upload", () => {
    expect(pickLogo(both, "full")).toBe(FULL);
    expect(pickLogo(both, "compact")).toBe(MARK);
  });

  it("an org with ONE logo shows it in both sidebar states", () => {
    expect(pickLogo({ fullLogo: FULL, compactLogo: null }, "compact")).toBe(FULL);
    expect(pickLogo({ fullLogo: null, compactLogo: MARK }, "full")).toBe(MARK);
  });

  it("an empty-string logo falls through instead of blanking the slot", () => {
    // `??` treated "" as a logo, leaving the expanded row empty.
    expect(pickLogo({ fullLogo: "", compactLogo: MARK }, "full")).toBe(MARK);
  });

  it("a broken logo falls back to the other one, then to the default mark", () => {
    expect(pickLogo(both, "full", new Set([FULL]))).toBe(MARK);
    expect(pickLogo(both, "compact", new Set([MARK]))).toBe(FULL);
    expect(pickLogo(both, "full", new Set([FULL, MARK]))).toBeNull();
  });

  it("no org / no logos → default branding", () => {
    expect(pickLogo(null, "full")).toBeNull();
    expect(pickLogo(undefined, "compact")).toBeNull();
    expect(pickLogo({ fullLogo: null, compactLogo: null }, "full")).toBeNull();
  });

  it("a replacement upload is tried even after the old one failed", () => {
    const failed = new Set([FULL]);
    const replaced = "data:image/png;base64,iVBORw0KGgoNEW";
    expect(pickLogo({ fullLogo: replaced, compactLogo: null }, "full", failed)).toBe(replaced);
  });
});

describe("purgeLegacyBrandingCache", () => {
  it("removes the old localStorage mirror of the org logos", () => {
    const removed: string[] = [];
    purgeLegacyBrandingCache({ removeItem: (k: string) => { removed.push(k); } });
    expect(removed).toEqual([LEGACY_BRANDING_KEY]);
    expect(LEGACY_BRANDING_KEY).toBe("mh-org-branding:v1");
  });

  it("never throws when storage is blocked or absent", () => {
    expect(() => purgeLegacyBrandingCache({ removeItem: () => { throw new Error("SecurityError"); } })).not.toThrow();
    expect(() => purgeLegacyBrandingCache(null)).not.toThrow();
    expect(() => purgeLegacyBrandingCache()).not.toThrow(); // node: no localStorage at all
  });
});
