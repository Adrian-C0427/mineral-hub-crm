import { describe, expect, it } from "vitest";
import {
  deriveProfile, deriveWellStatus, deriveWellType, fromSymbolOnly, normalizeStatus, rrcIsoDate, shiftYm, uicKind,
  WELL_STATUSES, type PermitFacts, type StatusInputs, type WellboreQueryRow,
} from "./wellStatus.js";

const row = (o: Partial<WellboreQueryRow> = {}): WellboreQueryRow => ({
  onSchedule: true, wellType: "PRODUCING", oilGas: "G", district: "05", leaseNo: "295907",
  wbShutIn: null, b14b2: false, plugDate: null, completionDate: "20230902", w2g1Date: "20231018", ...o,
});
const permit = (o: Partial<PermitFacts> = {}): PermitFacts => ({
  permitNo: "0918465", issued: "20260911", spud: null, expires: "20280911", cancelled: null, cancelledFlag: "", horizontal: true, ...o,
});
const inputs = (o: Partial<StatusInputs> = {}): StatusInputs => ({
  symbol: 5, hasApi: true, ewa: [row()], permit: null, uic: null,
  lastProdYm: "202607", prodNewestYm: "202607", asOf: "20261018", ...o,
});

describe("deriveWellStatus — RRC's proration schedule", () => {
  it("a scheduled producing completion is Producing", () => {
    const s = deriveWellStatus(inputs());
    expect(s).toMatchObject({ status: "Producing", source: "wellbore-query", adminStatus: "PRODUCING", flag: null });
  });

  it("never infers producing from production alone — and flags a stale producer", () => {
    const s = deriveWellStatus(inputs({ lastProdYm: "202502" }));
    expect(s.status).toBe("Producing");
    expect(s.flag).toBe("no-recent-production");
    expect(s.note).toContain("2025-02");
    expect(deriveWellStatus(inputs({ lastProdYm: null })).flag).toBe("no-recent-production");
    // Within the 12-month window: no flag.
    expect(deriveWellStatus(inputs({ lastProdYm: "202508" })).flag).toBeNull();
  });

  it("a producing completion on an inactive wellbore is Shut-In, with the 14(b)(2) extension kept", () => {
    const s = deriveWellStatus(inputs({ ewa: [row({ wbShutIn: "201901", b14b2: true })] }));
    expect(s).toMatchObject({ status: "Shut-In", adminStatus: "PRODUCING", since: "2019-01-01" });
    expect(s.detail).toBe("Inactive since 2019-01 · 14(b)(2) extension");
  });

  it("keeps RRC's finer shut-in wording (temporarily abandoned, shut in)", () => {
    expect(deriveWellStatus(inputs({ ewa: [row({ wellType: "TEMP ABANDONED" })] })))
      .toMatchObject({ status: "Shut-In", detail: "Temporarily abandoned" });
    expect(deriveWellStatus(inputs({ ewa: [row({ wellType: "SHUT IN", wbShutIn: "201704", b14b2: true })] })).detail)
      .toBe("Shut in since 2017-04 · 14(b)(2) extension");
  });

  it("a multi-completion with one producing zone is Producing", () => {
    const s = deriveWellStatus(inputs({ ewa: [row({ wellType: "SWR-10-WELL" }), row({ wellType: "TEMP ABANDONED" })] }));
    expect(s.status).toBe("Producing");
    expect(s.adminStatus).toBe("SWR-10-WELL, TEMP ABANDONED");
  });

  it("splits injection from disposal with the UIC permit, and flags when none exists", () => {
    const inj = [row({ wellType: "INJECTION" })];
    expect(deriveWellStatus(inputs({ ewa: inj, uic: uicKind("1") }))).toMatchObject({ status: "Disposal", source: "uic" });
    expect(deriveWellStatus(inputs({ ewa: inj, uic: uicKind("3") }))).toMatchObject({ status: "Injection", detail: "Secondary/tertiary recovery" });
    expect(deriveWellStatus(inputs({ ewa: inj, uic: null }))).toMatchObject({ status: "Injection", flag: "unverified" });
  });

  it("water supply / observation wells are Other/Unknown with the type kept", () => {
    expect(deriveWellStatus(inputs({ ewa: [row({ wellType: "WATER SUPPLY" })] }))).toMatchObject({ status: "Other/Unknown", detail: "Water supply well", flag: null });
  });
});

describe("deriveWellStatus — off the schedule", () => {
  it("a W-3 plugging date makes it Plugged (dry holes say so)", () => {
    const s = deriveWellStatus(inputs({ symbol: 3, ewa: [row({ onSchedule: false, wellType: "", plugDate: "20160810" })] }));
    expect(s).toMatchObject({ status: "Plugged", since: "2016-08-10", detail: "Dry hole" });
  });

  it("completed, unscheduled, unplugged: the map's plugged symbol decides, flagged", () => {
    const off = [row({ onSchedule: false, wellType: "", completionDate: "19720101" })];
    expect(deriveWellStatus(inputs({ symbol: 8, ewa: off }))).toMatchObject({ status: "Plugged", flag: "unverified", source: "map-symbol" });
    expect(deriveWellStatus(inputs({ symbol: 5, ewa: off }))).toMatchObject({ status: "Other/Unknown", flag: "needs-investigation" });
  });
});

describe("deriveWellStatus — permit stage", () => {
  const noCompletion = [row({ onSchedule: false, wellType: "", completionDate: null, w2g1Date: null })];

  it("an approved, unexpired permit with no spud is Permitted", () => {
    expect(deriveWellStatus(inputs({ symbol: 2, ewa: noCompletion, permit: permit() }))).toMatchObject({ status: "Permitted", source: "permit", since: "2026-09-11" });
  });

  it("a recent spud with no completion is Drilling", () => {
    const s = deriveWellStatus(inputs({ symbol: 2, ewa: [], permit: permit({ spud: "20260829" }) }));
    expect(s).toMatchObject({ status: "Drilling", since: "2026-08-29" });
  });

  it("an old spud with no completion or plugging report needs investigation", () => {
    const s = deriveWellStatus(inputs({ symbol: 2, ewa: [], permit: permit({ issued: "20230329", spud: "20230419", expires: "20250329" }) }));
    expect(s).toMatchObject({ status: "Other/Unknown", flag: "needs-investigation" });
  });

  it("an expired, undrilled permit is not Permitted (the map symbol lags)", () => {
    const s = deriveWellStatus(inputs({ symbol: 2, ewa: noCompletion, permit: permit({ issued: "20080822", expires: "20100822" }) }));
    expect(s).toMatchObject({ status: "Other/Unknown", detail: "Permit expired 2010-08-22 · not drilled" });
  });

  it("a cancelled permit reads cancelled", () => {
    expect(deriveWellStatus(inputs({ symbol: 9, ewa: [], permit: permit({ cancelledFlag: "P" }) })).detail).toContain("cancelled");
  });
});

describe("map-symbol-only wells", () => {
  it("trusts plugged / shut-in symbols, never an unverifiable active one", () => {
    expect(fromSymbolOnly(7, false)).toMatchObject({ status: "Plugged", flag: "map-only" });
    expect(fromSymbolOnly(20, false)).toMatchObject({ status: "Shut-In", flag: "map-only" });
    const oil = fromSymbolOnly(4, false);
    expect(oil).toMatchObject({ status: "Other/Unknown", flag: "map-only", detail: "Oil (RRC map symbol)" });
    expect(oil.note).toContain("no API number");
    expect(fromSymbolOnly(2, true, true).note).toContain("carries no completion");
    expect(fromSymbolOnly(null, true)).toMatchObject({ status: "Other/Unknown", detail: null });
  });

  it("falls through to the symbol when no record exists", () => {
    expect(deriveWellStatus(inputs({ symbol: 3, hasApi: false, ewa: [] }))).toMatchObject({ status: "Plugged", source: "map-symbol", flag: "map-only" });
  });
});

describe("vocabulary + helpers", () => {
  it("maps every legacy map status onto the normalized set", () => {
    expect(normalizeStatus("Dry Hole")).toBe("Plugged");
    expect(normalizeStatus("Active")).toBe("Injection");
    expect(normalizeStatus("Canceled/Abandoned")).toBe("Other/Unknown");
    expect(normalizeStatus("Surface location")).toBe("Other/Unknown");
    for (const s of WELL_STATUSES) expect(normalizeStatus(s)).toBe(s);
    expect(normalizeStatus("whatever")).toBe("Other/Unknown");
  });

  it("reads RRC dates with partial precision", () => {
    expect(rrcIsoDate("20160810")).toBe("2016-08-10");
    expect(rrcIsoDate("201704")).toBe("2017-04-01");
    expect(rrcIsoDate("19720000")).toBe("1972-01-01");
    expect(rrcIsoDate("20230231")).toBe("2023-02-28");
    expect(rrcIsoDate("00000000")).toBeNull();
    expect(rrcIsoDate("")).toBeNull();
    expect(shiftYm("202607", -11)).toBe("202508");
    expect(shiftYm("202601", -1)).toBe("202512");
  });

  it("derives product type and profile", () => {
    expect(deriveWellType({ status: "Disposal", ewa: [], symbol: 5, completed: true })).toBe("Injection/Disposal");
    expect(deriveWellType({ status: "Producing", ewa: [row({ oilGas: "O" }), row({ oilGas: "G" })], symbol: 5, completed: true })).toBe("Oil/Gas");
    expect(deriveWellType({ status: "Plugged", ewa: [], symbol: 3, completed: false })).toBe("Dry Hole");
    expect(deriveWellType({ status: "Permitted", ewa: [], symbol: null, completed: false })).toBe("Location");
    expect(deriveProfile(86, [], false)).toBe("Horizontal");
    expect(deriveProfile(4, ["D1"], false)).toBe("Directional");
    expect(deriveProfile(2, [], true)).toBe("Horizontal");
    expect(deriveProfile(4, [""], false)).toBe("Vertical");
  });
});
