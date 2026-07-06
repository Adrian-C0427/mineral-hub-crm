import { describe, expect, it } from "vitest";
import { anchorPolygon, parseBearing, parseDistance, parseTract, polygonAcres, quadrantToAzimuth, tractFromAiExtraction, type AiExtraction } from "./tractParser.js";

// A clean 1000×1000 ft square: 1,000,000 sq ft ≈ 22.957 acres.
const SQUARE = `
BEING a 22.96 acre tract of land situated in the JOHN DOE SURVEY, Abstract No. 123,
Leon County, Texas, and being more particularly described as follows:
BEGINNING at a 1/2 inch iron rod found at the southwest corner of said survey;
THENCE N 00°00'00" E, a distance of 1000.00 feet to a point for corner;
THENCE N 90°00'00" E, a distance of 1000.00 feet to a point for corner;
THENCE S 00°00'00" E, a distance of 1000.00 feet to a point for corner;
THENCE S 90°00'00" W, a distance of 1000.00 feet to the POINT OF BEGINNING,
containing 22.96 acres of land, more or less.`;

describe("parseBearing", () => {
  it("reads DMS quadrant bearings into azimuths", () => {
    expect(parseBearing("N 45°30'00\" E")!.azimuth).toBeCloseTo(45.5);
    expect(parseBearing("S 30° E")!.azimuth).toBeCloseTo(150);
    expect(parseBearing("S 45°15' W")!.azimuth).toBeCloseTo(225.25);
    expect(parseBearing("N 10°30' W")!.azimuth).toBeCloseTo(349.5);
  });
  it("reads worded bearings and cardinal-only calls", () => {
    expect(parseBearing("South 89 deg. 30 min. West, 200 feet")!.azimuth).toBeCloseTo(269.5);
    expect(parseBearing("thence North 100 feet")!.azimuth).toBe(0);
  });
  it("rejects quadrant angles over 90°", () => {
    expect(parseBearing("N 120° E")).toBeNull();
  });
});

describe("parseDistance", () => {
  it("converts varas, chains and rods to feet", () => {
    expect(parseDistance("a distance of 360 varas")!.feet).toBeCloseTo(1000, 0);
    expect(parseDistance("10 chains to a stake")!.feet).toBeCloseTo(660);
    expect(parseDistance("4 rods")!.feet).toBeCloseTo(66);
    expect(parseDistance("1,234.5 feet")!.feet).toBeCloseTo(1234.5);
  });
  it("returns null when no distance is present", () => {
    expect(parseDistance("to a point for corner")).toBeNull();
  });
});

describe("parseTract (TX metes and bounds)", () => {
  it("parses a closing square and computes acreage", () => {
    const p = parseTract(SQUARE);
    expect(p.ok).toBe(true);
    expect(p.calls).toHaveLength(4);
    expect(p.calls.every((c) => c.issue === null)).toBe(true);
    expect(p.closure!.closes).toBe(true);
    expect(p.computedAcres).toBeCloseTo(22.957, 1);
    expect(p.pobText).toMatch(/BEGINNING at a 1\/2 inch iron rod/i);
  });

  it("extracts abstract, survey, county and stated acreage references", () => {
    const p = parseTract(SQUARE);
    expect(p.refs.abstracts).toContain("A-123");
    expect(p.refs.surveys.some((s) => s.includes("JOHN DOE"))).toBe(true);
    expect(p.refs.county).toBe("Leon");
    expect(p.refs.statedAcres).toBeCloseTo(22.96);
  });

  it("flags a non-closing boundary instead of failing silently", () => {
    const open = SQUARE.replace("S 90°00'00\" W, a distance of 1000.00 feet", "S 90°00'00\" W, a distance of 500.00 feet");
    const p = parseTract(open);
    expect(p.ok).toBe(true);
    expect(p.closure!.closes).toBe(false);
    expect(p.closure!.gapFt).toBeCloseTo(500, 0);
    expect(p.warnings.some((w) => /does not close/i.test(w))).toBe(true);
  });

  it("flags unreadable calls as unresolved and keeps going", () => {
    const messy = SQUARE.replace("THENCE N 90°00'00\" E, a distance of 1000.00 feet to a point for corner;",
      "THENCE easterly along the meanders of the creek to a point for corner;");
    const p = parseTract(messy);
    expect(p.unresolved.length).toBeGreaterThan(0);
    expect(p.calls.find((c) => c.issue)!.issue).toMatch(/could not be read|No bearing/i);
  });

  it("approximates curves by their long chord", () => {
    const curved = SQUARE.replace("THENCE N 90°00'00\" E, a distance of 1000.00 feet to a point for corner;",
      "THENCE with a curve to the right whose long chord bears N 90°00'00\" E, 1000.00 feet;");
    const p = parseTract(curved);
    const c = p.calls.find((x) => x.curve)!;
    expect(c.issue).toMatch(/long chord/i);
    expect(c.azimuth).toBeCloseTo(90);
    expect(p.computedAcres).toBeCloseTo(22.957, 1);
  });

  it("recognizes lot/block descriptions as unmappable and says so", () => {
    const p = parseTract("Being Lot 4, Block B, of the Oakwood Addition, City of Centerville, Leon County, Texas.");
    expect(p.ok).toBe(false);
    expect(p.refs.lots).toContain("4");
    expect(p.refs.blocks).toContain("B");
    expect(p.warnings.some((w) => /lot\/block/i.test(w))).toBe(true);
  });

  it("routes unknown states through the TX grammar with a notice", () => {
    const p = parseTract(SQUARE, "OK");
    expect(p.ok).toBe(true);
    expect(p.warnings[0]).toMatch(/No OK-specific parser/);
    expect(p.refs.state).toBe("OK");
  });
});

describe("tractFromAiExtraction", () => {
  const square: AiExtraction = {
    pobText: "BEGINNING at an iron rod",
    calls: [
      { raw: "THENCE N 0 E 1000 ft", bearing: { ns: "N", deg: 0, ew: "E" }, distance: { value: 1000, unit: "feet" } },
      { raw: "THENCE N 90 E 360 varas", bearing: { ns: "N", deg: 90, ew: "E" }, distance: { value: 360, unit: "varas" } },
      { raw: "THENCE S 0 E 1000 ft", bearing: { ns: "S", deg: 0, ew: "E" }, distance: { value: 1000, unit: "feet" } },
      { raw: "THENCE S 90 W 1000 ft", bearing: { ns: "S", deg: 90, ew: "W" }, distance: { value: 1000, unit: "feet" } },
    ],
    refs: { statedAcres: 22.96 },
    assumptions: ["Read 'vrs' as Texas varas."],
    ambiguities: [{ text: "the meanders of the creek", issue: "East line follows a creek; straight chord assumed" }],
    confidence: 84,
  };

  it("assembles geometry deterministically from an AI extraction", () => {
    const p = tractFromAiExtraction(square, "TX", "Abstract No. 123, Leon County, Texas");
    expect(p.ok).toBe(true);
    expect(p.source).toBe("ai");
    expect(p.confidence).toBe(84);
    expect(p.computedAcres).toBeCloseTo(22.957, 1); // 360 varas = 1000 ft
    expect(p.closure!.closes).toBe(true);
    expect(p.assumptions).toHaveLength(1);
    expect(p.warnings.some((w) => /creek/.test(w))).toBe(true);
  });

  it("backfills refs from the deterministic regex pass over the original text", () => {
    const p = tractFromAiExtraction(square, "TX", "Abstract No. 123, Leon County, Texas");
    expect(p.refs.abstracts).toContain("A-123");
    expect(p.refs.county).toBe("Leon");
    expect(p.refs.statedAcres).toBeCloseTo(22.96);
  });

  it("flags calls the model could not resolve instead of guessing", () => {
    const p = tractFromAiExtraction({
      pobText: null,
      calls: [
        { raw: "curve without chord", curve: true, bearing: null, distance: null, note: "Arc of 312 ft, no chord given" },
        { raw: "N 45 E 100 ft", bearing: { ns: "N", deg: 45, ew: "E" }, distance: { value: 100, unit: "feet" } },
      ],
    }, "TX", "some text");
    expect(p.ok).toBe(false);
    expect(p.unresolved.length).toBe(1);
    expect(p.calls[0].issue).toMatch(/Arc of 312/);
  });

  it("clamps confidence and rejects out-of-quadrant bearings", () => {
    expect(quadrantToAzimuth({ ns: "N", deg: 120, ew: "E" })).toBeNull();
    expect(quadrantToAzimuth({ ns: "S", deg: 45, min: 30, ew: "W" })!.azimuth).toBeCloseTo(225.5);
    const p = tractFromAiExtraction({ pobText: null, calls: [], confidence: 300 }, "TX", "x");
    expect(p.confidence).toBe(100);
  });
});

describe("geometry helpers", () => {
  it("polygonAcres matches the square", () => {
    expect(polygonAcres([[0, 0], [0, 1000], [1000, 1000], [1000, 0]])).toBeCloseTo(22.957, 2);
  });
  it("anchorPolygon produces a closed lon/lat ring around the POB", () => {
    const poly = anchorPolygon([[0, 0], [0, 1000], [1000, 1000], [1000, 0]], { lon: -96, lat: 31 });
    const ring = poly.coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(ring[0][0]).toBeCloseTo(-96);
    // 1000 ft ≈ 304.8 m ≈ 0.0027385° of latitude.
    expect(ring[1][1] - ring[0][1]).toBeCloseTo(304.8 / 111320, 6);
  });
});
