import { describe, it, expect } from "vitest";
import { valuesPlaceholders, mergeSql, watermarkSql, type MergeSpec } from "./merge.js";
import { sha256Hex } from "./checksum.js";
import { DATASETS, requiredDatasets, datasetById } from "./manifest.js";
import { findLinkHref } from "./download.js";
import { normalizeProductionLine, subtractMonths } from "./loadProduction.js";

describe("merge SQL builders", () => {
  it("builds positional value placeholders", () => {
    expect(valuesPlaceholders(2, 3)).toBe("($1,$2,$3),($4,$5,$6)");
    expect(valuesPlaceholders(0, 3)).toBe("");
    expect(valuesPlaceholders(1, 1)).toBe("($1)");
  });

  const spec: MergeSpec = {
    schema: "rrc", table: "production",
    columns: ["a", "b", "c"],
    conflict: ["a", "b"],
    update: ["c"],
  };

  it("emits ON CONFLICT DO UPDATE for dimension/append with update cols", () => {
    const sql = mergeSql(spec, 2);
    expect(sql).toContain("INSERT INTO rrc.production (a, b, c) VALUES ($1,$2,$3),($4,$5,$6)");
    expect(sql).toContain("ON CONFLICT (a, b) DO UPDATE SET c = EXCLUDED.c");
  });

  it("emits DO NOTHING when no update columns", () => {
    const sql = mergeSql({ ...spec, update: [] }, 1);
    expect(sql).toContain("ON CONFLICT (a, b) DO NOTHING");
    expect(sql).not.toContain("DO UPDATE");
  });

  it("scopes the watermark query by county", () => {
    expect(watermarkSql()).toContain("MAX(cycle_ym)");
    expect(watermarkSql()).toContain("WHERE county = $1");
  });
});

describe("checksum", () => {
  it("hashes deterministically (known vector)", () => {
    // sha256("") is the well-known empty-string digest.
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("manifest", () => {
  it("has unique ids and populated required metadata", () => {
    const ids = DATASETS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of DATASETS) {
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.target.length).toBeGreaterThan(0);
      expect(d.populates.length).toBeGreaterThan(0);
    }
  });

  it("marks PDQ required with a direct URL", () => {
    const pdq = datasetById("production_pdq");
    expect(pdq?.required).toBe(true);
    expect(pdq?.directUrl).toContain("mft.rrc.texas.gov");
  });

  it("required set is exactly the Phase-1 datasets", () => {
    expect(requiredDatasets().every((d) => d.phase === 1 && d.required)).toBe(true);
    expect(requiredDatasets().length).toBeGreaterThanOrEqual(8);
  });
});

describe("catalog link resolution", () => {
  it("finds an anchor href by its visible text", () => {
    const html = `<ul>
      <li><a href="/x/other.zip">Some Other Dataset</a></li>
      <li><a href="https://mft.rrc.texas.gov/link/abc">Full Wellbore (EBCDIC Format)</a></li>
    </ul>`;
    expect(findLinkHref(html, "Full Wellbore")).toBe("https://mft.rrc.texas.gov/link/abc");
    expect(findLinkHref(html, "Nonexistent")).toBeNull();
  });
});

describe("production normalization", () => {
  const county = "Freestone";
  const line = (over: Partial<Record<number, string>>) => {
    const base = ["O", "05", "12345", "202403", "161", "099999", "00012345", "", "10", "0", "0", "0",
      "SOME LEASE", "SOME OPERATOR", "SOME FIELD"];
    for (const [k, v] of Object.entries(over)) base[Number(k)] = v!;
    return base.join("\t");
  };

  it("parses a valid oil line into the column tuple", () => {
    const row = normalizeProductionLine(line({}), county);
    expect(row).not.toBeNull();
    expect(row).toEqual(["O", "05", "12345", 202403, "Freestone", "099999", "00012345", "", 10, 0, 0, 0]);
  });

  it("drops all-zero months", () => {
    expect(normalizeProductionLine(line({ 8: "0", 9: "0", 10: "0", 11: "0" }), county)).toBeNull();
  });

  it("rejects non O/G records and malformed lines", () => {
    expect(normalizeProductionLine(line({ 0: "X" }), county)).toBeNull();
    expect(normalizeProductionLine("too\tfew\tcols", county)).toBeNull();
  });

  it("rejects a missing cycle", () => {
    expect(normalizeProductionLine(line({ 3: "0" }), county)).toBeNull();
  });
});

describe("restatement window math (yyyymm − n months)", () => {
  it("subtracts within a year", () => {
    expect(subtractMonths(202406, 3)).toBe(202403);
  });
  it("wraps across a year boundary", () => {
    expect(subtractMonths(202401, 1)).toBe(202312);
    expect(subtractMonths(202403, 6)).toBe(202309);
  });
  it("handles a zero watermark", () => {
    expect(subtractMonths(0, 6)).toBe(0);
  });
});
