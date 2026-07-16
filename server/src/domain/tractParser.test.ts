import { describe, expect, it } from "vitest";
import { anchorPolygon, applyTieLine, parseBearing, parseDistance, parseTract, polygonAcres, scoreConfidence } from "./tractParser.js";

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

describe("parseTexas — interpretive reads", () => {
  it("excludes commencement tie-line calls from the boundary walk", () => {
    const commenced = `
COMMENCING at the northeast corner of the JOHN DOE SURVEY, Abstract No. 123, Leon County, Texas;
THENCE S 45°00'00" W, a distance of 500.00 feet to a 1/2 inch iron rod and the POINT OF BEGINNING;
THENCE N 00°00'00" E, a distance of 1000.00 feet to a point for corner;
THENCE N 90°00'00" E, a distance of 1000.00 feet to a point for corner;
THENCE S 00°00'00" E, a distance of 1000.00 feet to a point for corner;
THENCE S 90°00'00" W, a distance of 1000.00 feet to the POINT OF BEGINNING, containing 22.96 acres of land.`;
    const p = parseTract(commenced);
    expect(p.ok).toBe(true);
    expect(p.calls).toHaveLength(4); // the S45W tie call is excluded
    expect(p.computedAcres).toBeCloseTo(22.957, 1);
    expect(p.closure!.closes).toBe(true);
    expect(p.assumptions.some((a) => /tie-line/i.test(a))).toBe(true);
  });

  it("repeats the prior bearing for 'same course' / 'continuing' calls", () => {
    const cont = SQUARE.replace(
      "THENCE N 90°00'00\" E, a distance of 1000.00 feet to a point for corner;",
      "THENCE N 90°00'00\" E, a distance of 600.00 feet to a point; THENCE continuing on the same course, a distance of 400.00 feet to a point for corner;");
    const p = parseTract(cont);
    expect(p.ok).toBe(true);
    expect(p.calls).toHaveLength(5);
    expect(p.calls[2].azimuth).toBeCloseTo(90); // reused N90E
    expect(p.closure!.closes).toBe(true);
    expect(p.computedAcres).toBeCloseTo(22.957, 1);
    expect(p.assumptions.some((a) => /same course/i.test(a))).toBe(true);
  });
});

describe("POB corner + tie-line anchoring inputs", () => {
  it("extracts the named corner from the POB clause", () => {
    const p = parseTract(SQUARE.replace("BEGINNING at a 1/2 inch iron rod found at the southwest corner of said survey",
      "BEGINNING at a 1/2 inch iron rod found at the northeast corner of said survey"));
    expect(p.pobCorner).toBe("NE");
    expect(parseTract(SQUARE).pobCorner).toBe("SW");
  });

  it("keeps commencement tie calls with resolved bearings/distances", () => {
    const commenced = `COMMENCING at the northeast corner of the JOHN DOE SURVEY, Abstract No. 123, Leon County, Texas;
THENCE S 45°00'00" W, a distance of 500.00 feet to the POINT OF BEGINNING;
THENCE N 00 E, 1000.00 feet; THENCE N 90 E, 1000.00 feet; THENCE S 00 E, 1000.00 feet; THENCE S 90 W, 1000.00 feet to the POINT OF BEGINNING.`;
    const p = parseTract(commenced);
    expect(p.pobCorner).toBe("NE");
    expect(p.tieCalls).toHaveLength(1);
    expect(p.tieCalls![0].azimuth).toBeCloseTo(225);
    expect(p.tieCalls![0].distanceFt).toBeCloseTo(500);
  });

  it("applyTieLine offsets the origin by the tie vector (and refuses partial ties)", () => {
    // S 45 W, 500 ft from origin: dx = -353.55 ft, dy = -353.55 ft.
    const pob = applyTieLine({ lon: -96, lat: 31 }, [{ azimuth: 225, distanceFt: 500 }])!;
    const dLatFt = (pob.lat - 31) * 111_320 / 0.3048;
    expect(dLatFt).toBeCloseTo(-353.55, 0);
    expect(pob.lon).toBeLessThan(-96);
    expect(applyTieLine({ lon: -96, lat: 31 }, [{ azimuth: null, distanceFt: 500 }])).toBeNull();
  });
});

describe("parseTexas — multi-course THENCE + witness monuments", () => {
  it("splits an 'as follows:' clause into one call per course and ignores WHENCE witness trees", () => {
    const deed = `Beginning at a stone found at the occupied southerly corner of said 61 acre tract for this southerly corner. WHENCE a 26" Post Oak tree, found, bears NORTH 66 degrees 27 minutes WEST 11.5 feet, and a 22" Post Oak tree bears SOUTH 14 degrees 17 minutes EAST 15.4 feet;
THENCE in a northwesterly direction, as follows:
NORTH 44 degrees 28 minutes 58 seconds WEST 134.81 feet to an 18" Post Oak tree for a bend,
NORTH 40 degrees 15 minutes 57 seconds WEST 112.64 feet to a double Elm tree for a bend,
NORTH 42 degrees 26 minutes 31 seconds WEST 76.32 feet;
THENCE NORTH 37 degrees 25 minutes 05 seconds EAST 693.70 feet, to a point, whence a 1/2" iron rod bears SOUTH 37 degrees 25 minutes 05 seconds WEST 13.75 feet;
THENCE SOUTH 45 degrees 00 minutes EAST 400.00 feet to the point of beginning.`;
    const p = parseTract(deed);
    // 3 courses from the multi-course clause + 2 single calls; witness bearings excluded.
    expect(p.calls).toHaveLength(5);
    expect(p.unresolved).toHaveLength(0);
    expect(p.calls[0].bearing).toBe('N 44°28\'58" W');
    expect(p.calls[2].distanceRaw).toBe("76.32 feet");
    // The N37E call must be the boundary course, not the 13.75 ft witness tie.
    expect(p.calls[3].distanceFt).toBeCloseTo(693.7);
  });
});

describe("confidence scoring (deterministic)", () => {
  it("scores a clean closing tract high", () => {
    const p = parseTract(SQUARE);
    expect(p.source).toBe("rules");
    expect(p.confidence).toBeGreaterThanOrEqual(90);
  });

  it("drops confidence for unresolved calls and open boundaries", () => {
    const messy = SQUARE.replace("THENCE N 90°00'00\" E, a distance of 1000.00 feet to a point for corner;",
      "THENCE easterly along the meanders of the creek to a point for corner;");
    const p = parseTract(messy);
    expect(p.confidence).not.toBeNull();
    expect(p.confidence!).toBeLessThan(parseTract(SQUARE).confidence!);
  });

  it("caps unmappable descriptions at a low score", () => {
    const p = parseTract("Being Lot 4, Block B, of the Oakwood Addition, Leon County, Texas.");
    expect(p.confidence!).toBeLessThanOrEqual(20);
  });

  it("penalizes assumptions and acreage mismatch", () => {
    const base = { ok: true, pobText: "BEGINNING at", calls: [], closure: { closes: true, gapFt: 0, precision: 100000 }, computedAcres: 10, refs: { statedAcres: 10 } as never, assumptions: [], unresolved: [] };
    const clean = scoreConfidence(base as never);
    const assumed = scoreConfidence({ ...base, assumptions: ["a", "b"] } as never);
    const mismatched = scoreConfidence({ ...base, computedAcres: 15 } as never);
    expect(assumed).toBeLessThan(clean);
    expect(mismatched).toBeLessThan(clean);
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
