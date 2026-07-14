import { describe, it, expect } from "vitest";
import { decodeCp037, encodeCp037 } from "./ebcdic.js";
import { pdqLineToTsv } from "./pdqExtract.js";
import { parsePermitRoot, parsePermitApi, PERMITS_SPEC } from "./loaders/permits.js";
import { parseOperatorLine, parseFieldLine } from "./loaders/refData.js";
import { parseGse10Record, GSE10_RECORD_SIZE, WELL_STATUS_SPEC } from "./loaders/gasWellStatus.js";
import { foldRecord, DBF900_RECORD_SIZE, type WellboreFacts } from "./loaders/wellbore.js";
import { completionRow, mdyToIso, COMPLETIONS_SPEC } from "./loaders/completions.js";
import { yyyymmddToIso } from "./loaders/util.js";
import { mergeSql } from "./merge.js";

const COUNTIES = new Map([["161", "Freestone"], ["289", "Leon"]]);

describe("EBCDIC cp037", () => {
  it("round-trips the character set the RRC files use", () => {
    const s = "GT05 123456 SMITH #1 OIL-GAS/2026.5%";
    expect(decodeCp037(encodeCp037(s))).toBe(s);
  });
  it("decodes digits and letters at the documented code points", () => {
    expect(decodeCp037(Buffer.from([0xf1, 0xf6, 0xf1]))).toBe("161");
    expect(decodeCp037(Buffer.from([0xc7, 0xe3]))).toBe("GT");
  });
});

describe("PDQ county extraction", () => {
  const line = [
    "G", "06", "298445", "2026", "01", "161", "101477", "07558666", "202601", "CA",
    "   8", "N", "12", "0", "0", "3400", "0", "0", "5", "0", "0", "7", "0", "0",
  ].join("}");

  it("maps an in-scope lease-cycle line to the 12-column TSV", () => {
    const row = pdqLineToTsv(line, new Set(["161"]));
    expect(row).not.toBeNull();
    expect(row!.countyCode).toBe("161");
    const c = row!.tsv.split("\t");
    expect(c).toEqual(["G", "06", "298445", "202601", "161", "101477", "07558666", "8", "12", "3400", "5", "7"]);
  });
  it("drops headers, other counties, and malformed lines", () => {
    expect(pdqLineToTsv("OIL_GAS_CODE}DISTRICT_NO", new Set(["161"]))).toBeNull();
    expect(pdqLineToTsv(line, new Set(["289"]))).toBeNull();
    expect(pdqLineToTsv("G}06}too-short", new Set(["161"]))).toBeNull();
  });
});

describe("drilling permits (daf802)", () => {
  const root =
    "01" + "000878900" + "161" +                       // key 2:14 — county code is its last 3 chars (line 11:14)
    "SMITH RANCH UNIT".padEnd(32) +                    // lease name 14:46
    "05" +                                             // district 46:48
    "123456" +                                         // operator no 48:54
    "XXXX" +                                           // filler 54:58
    "20260315" +                                       // permit date 58:66
    "WILDFIRE ENERGY LLC".padEnd(32) +                 // operator name 66:98
    " ".repeat(115);

  it("parses a type-01 root", () => {
    const r = parsePermitRoot(root)!;
    expect(r.key).toBe("000878900161");
    expect(r.countyCode).toBe("161");
    expect(r.leaseName).toBe("SMITH RANCH UNIT");
    expect(r.district).toBe("05");
    expect(r.operatorNo).toBe("123456");
    expect(r.permitDate).toBe("2026-03-15");
    expect(r.operatorName).toBe("WILDFIRE ENERGY LLC");
  });

  it("parses a type-02 trailer's api8 from the line tail", () => {
    const t = parsePermitApi("02" + "000878900161" + " ".repeat(480) + "16134567")!;
    expect(t.key).toBe("000878900161");
    expect(t.api8).toBe("16134567");
  });

  it("rejects other record types and short lines", () => {
    expect(parsePermitRoot("03" + " ".repeat(120))).toBeNull();
    expect(parsePermitApi("02" + "000878900161" + "  end-not-api")).toBeNull();
  });

  it("upserts on (status_no, api8)", () => {
    expect(mergeSql(PERMITS_SPEC, 1)).toContain("ON CONFLICT (status_no, api8) DO UPDATE SET");
  });
});

describe("reference data", () => {
  it("parses P5 organization master lines", () => {
    expect(parseOperatorLine("A " + "123456" + "WILDFIRE ENERGY LLC".padEnd(32) + "rest")).toEqual([
      "123456", "WILDFIRE ENERGY LLC",
    ]);
    expect(parseOperatorLine("B " + "123456" + "X".padEnd(32))).toBeNull();
    expect(parseOperatorLine("A " + "12E456" + "X".padEnd(32))).toBeNull();
  });

  it("parses field name lines at the fixed offsets", () => {
    const line = "05 " + "07558666" + "001" + " " + "GAS  " + "CARTHAGE (COTTON VALLEY)".padEnd(32);
    expect(parseFieldLine(line)).toEqual(["05", "07558666", "001", "GAS", "CARTHAGE (COTTON VALLEY)"]);
  });
});

describe("G-10 gas status (gse10)", () => {
  const rec = (over: Partial<{ head: string; district: string; id: string; op: string }> = {}) => {
    const buf = Buffer.alloc(GSE10_RECORD_SIZE, 0x40); // cp037 spaces
    encodeCp037(over.head ?? "GT").copy(buf, 0);
    encodeCp037(over.district ?? "05").copy(buf, 2);
    encodeCp037(over.id ?? "123456").copy(buf, 4);
    encodeCp037(over.op ?? "654321").copy(buf, 104);
    return buf;
  };

  it("decodes a GT record", () => {
    expect(parseGse10Record(rec())).toEqual({ district: "05", rrcId: "123456", operatorNo: "654321" });
  });
  it("rejects non-GT records", () => {
    expect(parseGse10Record(rec({ head: "XX" }))).toBeNull();
  });
  it("well_status upserts on (og_code, district, rrc_id)", () => {
    expect(mergeSql(WELL_STATUS_SPEC, 1)).toContain("ON CONFLICT (og_code, district, rrc_id) DO UPDATE SET");
  });
});

describe("Full Wellbore fold (dbf900)", () => {
  const rec = (type: string, body: (buf: Buffer) => void) => {
    const buf = Buffer.alloc(DBF900_RECORD_SIZE, 0x40);
    encodeCp037(type).copy(buf, 0);
    body(buf);
    return buf;
  };

  it("accumulates formations, lease/survey, plug date and latest oil W-10", () => {
    let facts: WellboreFacts | null = null;
    const root = rec("01", (b) => encodeCp037("16112345").copy(b, 2));
    ({ facts } = foldRecord(root, facts));
    expect(facts!.api8).toBe("16112345");

    foldRecord(rec("09", (b) => encodeCp037("COTTON VALLEY").copy(b, 5)), facts);
    foldRecord(rec("09", (b) => encodeCp037("TRAVIS PEAK").copy(b, 5)), facts);
    foldRecord(rec("12", (b) => { encodeCp037("SMITH UNIT").copy(b, 2); encodeCp037("J PONCE SVY A-123").copy(b, 34); }), facts);
    foldRecord(rec("14", (b) => encodeCp037("20191104").copy(b, 2)), facts);
    // Two W-10s — the later year wins.
    foldRecord(rec("23", (b) => { encodeCp037("111111").copy(b, 11); encodeCp037("2019").copy(b, 17); encodeCp037("05").copy(b, 23); encodeCp037("00123456").copy(b, 25); }), facts);
    foldRecord(rec("23", (b) => { encodeCp037("222222").copy(b, 11); encodeCp037("2024").copy(b, 17); encodeCp037("05").copy(b, 23); encodeCp037("00123456").copy(b, 25); }), facts);

    expect(facts!.formations).toEqual(["COTTON VALLEY", "TRAVIS PEAK"]);
    expect(facts!.leaseName).toBe("SMITH UNIT");
    expect(facts!.survey).toBe("J PONCE SVY A-123");
    expect(facts!.plugDate).toBe("2019-11-04");
    expect(facts!.oilOperatorNo).toBe("222222");
    expect(facts!.oilStatusYear).toBe(2024);
  });

  it("a new root closes the previous well group", () => {
    const first = foldRecord(rec("01", (b) => encodeCp037("16100001").copy(b, 2)), null);
    const second = foldRecord(rec("01", (b) => encodeCp037("28900002").copy(b, 2)), first.facts);
    expect(second.isRoot).toBe(true);
    expect(second.facts!.api8).toBe("28900002");
  });
});

describe("completions mapping", () => {
  it("maps parser output to the merge tuple with county name resolution", () => {
    const row = completionRow(
      { trackingNo: "123", api8: "16155555", filingType: "W-2", status: "Approved", county: "161", district: "05", filedDate: "01/08/2021", completionDate: "01/06/2021" },
      COUNTIES,
    )!;
    expect(row[0]).toBe("123");
    expect(row[1]).toBe("16155555");
    expect(row[4]).toBe("2021-01-08"); // packet MM/DD/YYYY normalized for ::date
    expect(row[5]).toBe("2021-01-06");
    expect(row[6]).toBe("Freestone");
    expect(mdyToIso("not-a-date")).toBeNull();
  });
  it("rejects rows without a plausible api8", () => {
    expect(completionRow({ trackingNo: "1", api8: "nope" }, COUNTIES)).toBeNull();
  });
  it("upserts on (tracking_no, api8)", () => {
    expect(mergeSql(COMPLETIONS_SPEC, 1)).toContain("ON CONFLICT (tracking_no, api8) DO UPDATE SET");
  });
});

describe("date helper", () => {
  it("converts yyyymmdd and rejects sentinels", () => {
    expect(yyyymmddToIso("20260315")).toBe("2026-03-15");
    expect(yyyymmddToIso("00000000")).toBeNull();
    expect(yyyymmddToIso("18000101")).toBeNull();
  });
});
