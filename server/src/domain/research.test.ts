import { describe, expect, it } from "vitest";
import {
  autoGranularity, bucketKey, bucketRange, classifyDocType, classifyPermitStatus,
  classifyTrajectory, detectHotspot, documentDedupeKey, historyWindows, normalizeEntity,
  normInstrument, rollingAverage, surgeSeverity, trend,
} from "./research.js";
import { CSV_DOCUMENTS, CSV_PERMITS, guessMapping } from "./researchSources.js";

describe("classifyDocType", () => {
  it("classifies the core transaction instruments", () => {
    expect(classifyDocType("Mineral Deed")).toEqual({ docType: "MINERAL_DEED", docClass: "TRANSACTION" });
    expect(classifyDocType("MINERAL DEED W/ VENDOR'S LIEN")).toBeNull(); // lien excluded
    expect(classifyDocType("Royalty Conveyance")).toEqual({ docType: "ROYALTY_DEED", docClass: "TRANSACTION" });
    expect(classifyDocType("Quitclaim Mineral Deed")).toEqual({ docType: "QUITCLAIM_MINERAL_DEED", docClass: "TRANSACTION" });
    expect(classifyDocType("Warranty Deed (Minerals Only)")).toEqual({ docType: "WARRANTY_MINERAL_DEED", docClass: "TRANSACTION" });
    expect(classifyDocType("Mineral Conveyance")).toEqual({ docType: "MINERAL_CONVEYANCE", docClass: "TRANSACTION" });
    expect(classifyDocType("Oil and Gas Conveyance")).toEqual({ docType: "OG_CONVEYANCE", docClass: "TRANSACTION" });
    expect(classifyDocType("Assignment of Overriding Royalty Interest")).toEqual({ docType: "ROYALTY_DEED", docClass: "TRANSACTION" });
    expect(classifyDocType("Assignment of Mineral Interest")).toEqual({ docType: "ASSIGNMENT", docClass: "TRANSACTION" });
    expect(classifyDocType("Reservation of Mineral Rights")).toEqual({ docType: "RESERVATION", docClass: "TRANSACTION" });
    expect(classifyDocType("Mineral Transaction")).toEqual({ docType: "OTHER", docClass: "TRANSACTION" });
  });

  it("classifies the leasing family", () => {
    expect(classifyDocType("Oil & Gas Lease")).toEqual({ docType: "OG_LEASE", docClass: "LEASE" });
    expect(classifyDocType("Memorandum of Oil and Gas Lease")).toEqual({ docType: "LEASE_MEMO", docClass: "LEASE" });
    expect(classifyDocType("Assignment of Oil & Gas Lease")).toEqual({ docType: "LEASE_ASSIGNMENT", docClass: "LEASE" });
    expect(classifyDocType("Release of Oil and Gas Lease")).toEqual({ docType: "LEASE_RELEASE", docClass: "LEASE" });
    expect(classifyDocType("Amendment of Lease")).toEqual({ docType: "LEASE_AMENDMENT", docClass: "LEASE" });
    expect(classifyDocType("Lease Extension Agreement")).toEqual({ docType: "LEASE_EXTENSION", docClass: "LEASE" });
    expect(classifyDocType("Ratification of Oil, Gas and Mineral Lease")).toEqual({ docType: "LEASE_RATIFICATION", docClass: "LEASE" });
  });

  it("rejects non-mineral instruments", () => {
    expect(classifyDocType("Deed of Trust")).toBeNull();
    expect(classifyDocType("Warranty Deed")).toBeNull(); // surface deed, no mineral signal
    expect(classifyDocType("Release of Lien")).toBeNull();
    expect(classifyDocType("Grazing Lease")).toBeNull();
    expect(classifyDocType("Easement")).toBeNull();
    expect(classifyDocType("Plat")).toBeNull();
    expect(classifyDocType("")).toBeNull();
  });

  // Terse abbreviations as emitted by Texas county-clerk index systems
  // (verified against the Leon County publicsearch.us doc-type vocabulary).
  it("handles Texas county-clerk abbreviations", () => {
    expect(classifyDocType("MINERAL CONVEYNC")).toEqual({ docType: "MINERAL_CONVEYANCE", docClass: "TRANSACTION" });
    expect(classifyDocType("O&GL")).toEqual({ docType: "OG_LEASE", docClass: "LEASE" });
    expect(classifyDocType("ASGMT OF LEASE")).toEqual({ docType: "LEASE_ASSIGNMENT", docClass: "LEASE" });
    expect(classifyDocType("REL OIL&GAS LS")).toEqual({ docType: "LEASE_RELEASE", docClass: "LEASE" });
    expect(classifyDocType("P/REL OIL&GAS LS")).toEqual({ docType: "LEASE_RELEASE", docClass: "LEASE" });
    expect(classifyDocType("OIL-GAS LSE")).toEqual({ docType: "OG_LEASE", docClass: "LEASE" });
    expect(classifyDocType("Q/C MINERAL DEED")).toEqual({ docType: "QUITCLAIM_MINERAL_DEED", docClass: "TRANSACTION" });
    expect(classifyDocType("ASG ROYALTY INTR")).toEqual({ docType: "ROYALTY_DEED", docClass: "TRANSACTION" });
    expect(classifyDocType("ASG ORR ROY INTR")).toEqual({ docType: "ROYALTY_DEED", docClass: "TRANSACTION" });
    expect(classifyDocType("MIN & ROYALTY DEED")).toEqual({ docType: "ROYALTY_DEED", docClass: "TRANSACTION" });
    expect(classifyDocType("MINERAL GRANT")).toEqual({ docType: "MINERAL_CONVEYANCE", docClass: "TRANSACTION" });
    expect(classifyDocType("OIL & GAS GRANT")).toEqual({ docType: "OG_CONVEYANCE", docClass: "TRANSACTION" });
    // Non-O&G leases and lien/easement instruments still reject.
    expect(classifyDocType("COAL LEASE")).toBeNull();
    expect(classifyDocType("REL ROYALTY LIEN")).toBeNull(); // lien instrument, excluded
    expect(classifyDocType("ASGMT OF F/S")).toBeNull(); // financing statement
    expect(classifyDocType("CORR R/W EASEMENT")).toBeNull();
  });
});

describe("permit classification", () => {
  it("maps statuses", () => {
    expect(classifyPermitStatus("Approved")).toBe("APPROVED");
    expect(classifyPermitStatus("Well Completed")).toBe("COMPLETED");
    expect(classifyPermitStatus("Spudded")).toBe("SPUDDED");
    expect(classifyPermitStatus("Cancelled")).toBe("CANCELED");
    expect(classifyPermitStatus("Submitted")).toBe("SUBMITTED");
    expect(classifyPermitStatus(null)).toBe("SUBMITTED");
  });
  it("maps trajectories", () => {
    expect(classifyTrajectory("Horizontal")).toBe("HORIZONTAL");
    expect(classifyTrajectory("H")).toBe("HORIZONTAL");
    expect(classifyTrajectory("Directional")).toBe("DIRECTIONAL");
    expect(classifyTrajectory("Vertical")).toBe("VERTICAL");
    expect(classifyTrajectory("")).toBe("UNKNOWN");
  });
});

describe("normalizeEntity", () => {
  it("groups suffix/punctuation variants", () => {
    expect(normalizeEntity("Blackrock Minerals, LLC")).toBe("BLACKROCK MINERALS");
    expect(normalizeEntity("BLACKROCK MINERALS L.L.C.")).toBe("BLACKROCK MINERALS");
    expect(normalizeEntity("Smith, John et ux")).toBe("SMITH JOHN");
    expect(normalizeEntity("Acme Royalty Co., L.P.")).toBe("ACME ROYALTY");
    expect(normalizeEntity(null)).toBeNull();
    expect(normalizeEntity("   ")).toBeNull();
  });
  it("keeps meaningful words like TRUST", () => {
    expect(normalizeEntity("Jones Family Trust")).toBe("JONES FAMILY TRUST");
  });
});

describe("trend", () => {
  it("computes change and direction", () => {
    expect(trend(150, 100)).toMatchObject({ absoluteChange: 50, pctChange: 0.5, direction: "up" });
    expect(trend(80, 100)).toMatchObject({ absoluteChange: -20, pctChange: -0.2, direction: "down" });
    expect(trend(5, 0)).toMatchObject({ pctChange: null, direction: "up" }); // new activity
    expect(trend(0, 0)).toMatchObject({ pctChange: 0, direction: "flat" });
  });
});

describe("rollingAverage", () => {
  it("trails over the window", () => {
    expect(rollingAverage([2, 4, 6, 8], 2)).toEqual([2, 3, 5, 7]);
    expect(rollingAverage([], 3)).toEqual([]);
  });
});

describe("detectHotspot", () => {
  it("flags a statistically significant surge", () => {
    const r = detectHotspot(30, [10, 12, 8, 11, 9, 10]);
    expect(r.isHotspot).toBe(true);
    expect(r.zScore).toBeGreaterThan(2);
  });
  it("does not flag normal variation or tiny volumes", () => {
    expect(detectHotspot(13, [10, 12, 8, 11, 9, 10]).isHotspot).toBe(false);
    expect(detectHotspot(4, [0, 0, 0, 0, 0, 0]).isHotspot).toBe(false); // below minCount
  });
  it("flags brand-new activity when history was flat zero", () => {
    expect(detectHotspot(8, [0, 0, 0, 0, 0, 0]).isHotspot).toBe(true);
  });
  it("needs at least 3 history windows", () => {
    expect(detectHotspot(100, [1, 2]).isHotspot).toBe(false);
  });
});

describe("surgeSeverity", () => {
  it("ranks high-volume surges above tiny ones", () => {
    const big = surgeSeverity(60, 25, 3);
    const small = surgeSeverity(4, 1, 3);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThanOrEqual(100);
  });
});

describe("time bucketing", () => {
  it("auto-picks granularity", () => {
    expect(autoGranularity(new Date("2026-01-01"), new Date("2026-02-15"))).toBe("day");
    expect(autoGranularity(new Date("2025-06-01"), new Date("2026-06-01"))).toBe("week");
    expect(autoGranularity(new Date("2023-01-01"), new Date("2026-01-01"))).toBe("month");
  });
  it("buckets dates stably (weeks start Monday)", () => {
    expect(bucketKey(new Date("2026-06-30"), "month")).toBe("2026-06");
    expect(bucketKey(new Date("2026-06-30"), "day")).toBe("2026-06-30");
    expect(bucketKey(new Date("2026-07-01T10:00:00Z"), "week")).toBe("2026-06-29"); // Wed → Mon
  });
  it("covers the range without gaps", () => {
    const keys = bucketRange(new Date("2026-06-01"), new Date("2026-06-05"), "day");
    expect(keys).toEqual(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]);
    expect(bucketRange(new Date("2026-01-15"), new Date("2026-03-02"), "month")).toEqual(["2026-01", "2026-02", "2026-03"]);
  });
  it("builds equal history windows immediately before the range", () => {
    const w = historyWindows(new Date("2026-06-01"), new Date("2026-06-30"), 3);
    expect(w).toHaveLength(3);
    expect(w[2].to.toISOString().slice(0, 10)).toBe("2026-05-31");
    expect(w[2].from.toISOString().slice(0, 10)).toBe("2026-05-02");
    // Chronological order, oldest first.
    expect(w[0].from.getTime()).toBeLessThan(w[1].from.getTime());
  });
});

describe("guessMapping", () => {
  it("maps RRC W-1 style permit headers", () => {
    const m = guessMapping(CSV_PERMITS, ["Operator Name", "Lease Name", "Well #", "API No.", "County", "Wellbore Profile", "Submitted Date", "Approved Date"]);
    expect(m.operator).toBe("Operator Name");
    expect(m.trajectory).toBe("Wellbore Profile");
    expect(m.filedDate).toBe("Submitted Date");
    expect(m.approvedDate).toBe("Approved Date");
  });
  it("maps Leon County publicsearch.us export headers (documents)", () => {
    const m = guessMapping(CSV_DOCUMENTS, ["Grantor", "Grantee", "Doc Type", "Recorded Date", "Doc Number", "Book/Volume/Page", "Legal Description"]);
    expect(m.docType).toBe("Doc Type");
    expect(m.recordingDate).toBe("Recorded Date");
    expect(m.grantor).toBe("Grantor");
    expect(m.grantee).toBe("Grantee");
    expect(m.instrumentNumber).toBe("Doc Number");
    // Legal Description was removed from the import workflow — even when a file
    // still has that column, it must not be mapped.
    expect(m.legalDescription).toBeUndefined();
  });
  it("maps generic county-clerk headers (documents)", () => {
    const m = guessMapping(CSV_DOCUMENTS, ["Document Type", "File Date", "Grantor", "Grantee", "Instrument Number", "Legal Description"]);
    expect(m.docType).toBe("Document Type");
    expect(m.recordingDate).toBe("File Date");
    expect(m.grantee).toBe("Grantee");
  });
  it("no longer maps removed fields (effectiveDate, trs, acreage, consideration)", () => {
    const m = guessMapping(CSV_DOCUMENTS, ["Doc Type", "Recorded Date", "Effective Date", "Acreage", "Consideration", "Section-Township-Range"]);
    expect(m.effectiveDate).toBeUndefined();
    expect(m.acreage).toBeUndefined();
    expect(m.consideration).toBeUndefined();
    expect(m.trs).toBeUndefined();
  });
});

describe("document duplicate detection", () => {
  const base = {
    state: "TX", county: "Leon", instrumentNumber: "2026-00412",
    recordingDate: new Date("2026-03-12T00:00:00Z"), docType: "MINERAL_DEED",
    grantorNorm: "SMITH JOHN", granteeNorm: "BLACKROCK MINERALS",
  };

  it("normalizes instrument numbers (case + whitespace) before comparison", () => {
    expect(normInstrument(" 2026-00412 ")).toBe("2026-00412");
    expect(normInstrument("abc 123")).toBe("ABC123");
    expect(documentDedupeKey({ ...base, instrumentNumber: "  2026-00412 " }))
      .toBe(documentDedupeKey({ ...base, instrumentNumber: "2026-00412" }));
  });

  it("treats an identical recording signature as the same key (true duplicate)", () => {
    expect(documentDedupeKey(base)).toBe(documentDedupeKey({ ...base }));
  });

  it("does NOT collide when the same instrument number has different parties", () => {
    // County exports repeat one instrument across grantors/grantees — these are
    // distinct rows, not duplicates, so their keys must differ.
    expect(documentDedupeKey(base)).not.toBe(documentDedupeKey({ ...base, granteeNorm: "APEX ENERGY" }));
    expect(documentDedupeKey(base)).not.toBe(documentDedupeKey({ ...base, grantorNorm: "JONES TRUST" }));
  });

  it("does NOT collide when instrument matches but recording date or doc type differ", () => {
    expect(documentDedupeKey(base)).not.toBe(documentDedupeKey({ ...base, recordingDate: new Date("2026-03-13T00:00:00Z") }));
    expect(documentDedupeKey(base)).not.toBe(documentDedupeKey({ ...base, docType: "ROYALTY_DEED" }));
  });

  it("covers every mapped field: volume/page/abstract differences are NOT duplicates", () => {
    const withVol = { ...base, volume: "123", page: "45", abstractId: "289653" };
    expect(documentDedupeKey(withVol)).toBe(documentDedupeKey({ ...withVol, volume: " 123 ", page: "45 " })); // normalization
    expect(documentDedupeKey(withVol)).not.toBe(documentDedupeKey({ ...withVol, volume: "124" }));
    expect(documentDedupeKey(withVol)).not.toBe(documentDedupeKey({ ...withVol, abstractId: "289654" }));
    // Unmapped/absent fields compare as empty on both sides.
    expect(documentDedupeKey(base)).toBe(documentDedupeKey({ ...base, volume: "", page: null }));
  });
});
