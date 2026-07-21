import { describe, expect, it } from "vitest";
import { sniffMime, isAllowedMime } from "./s3.js";

/**
 * Upload type enforcement. The rule under test: the DECLARED mimetype is only
 * honoured where it can't be checked (signature-less text) or where the
 * signature is ambiguous between allowed formats (zip → OOXML, OLE2 → legacy
 * office). Everything else must fall through to application/octet-stream, which
 * isAllowedMime rejects — otherwise a caller could smuggle arbitrary bytes past
 * the allow-list by simply claiming a permitted type.
 */

const bytes = (hex: string, pad = 16) =>
  Buffer.concat([Buffer.from(hex, "hex"), Buffer.alloc(Math.max(0, pad - hex.length / 2))]);

const PDF = bytes("25504446");
const PNG = bytes("89504e470d0a1a0a");
const JPEG = bytes("ffd8ffe0");
const GIF = bytes("474946383961");
const TIFF_LE = bytes("49492a00");
const ZIP = bytes("504b0304");
const OLE2 = bytes("d0cf11e0a1b11ae1");

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("sniffMime", () => {
  it("detects real signatures regardless of what the client declared", () => {
    // A lying client declaring text/plain must not downgrade the detection.
    expect(sniffMime(PDF, "text/plain")).toBe("application/pdf");
    expect(sniffMime(PNG, "text/plain")).toBe("image/png");
    expect(sniffMime(JPEG, "text/plain")).toBe("image/jpeg");
    expect(sniffMime(GIF, "text/plain")).toBe("image/gif");
    expect(sniffMime(TIFF_LE, "text/plain")).toBe("image/tiff");
  });

  it("accepts a zip container only when the declared type is OOXML", () => {
    expect(sniffMime(ZIP, DOCX)).toBe(DOCX);
    expect(sniffMime(ZIP, XLSX)).toBe(XLSX);
  });

  it("rejects a zip container declaring a non-office type", () => {
    // The classic smuggle: a .zip (or a renamed archive) claiming to be a PDF.
    expect(isAllowedMime(sniffMime(ZIP, "application/pdf"))).toBe(false);
    expect(isAllowedMime(sniffMime(ZIP, "text/csv"))).toBe(false);
    expect(isAllowedMime(sniffMime(ZIP, "image/png"))).toBe(false);
  });

  it("accepts OLE2 only for the legacy office types it can be", () => {
    expect(sniffMime(OLE2, "application/msword")).toBe("application/msword");
    expect(sniffMime(OLE2, "application/vnd.ms-excel")).toBe("application/vnd.ms-excel");
    expect(isAllowedMime(sniffMime(OLE2, "application/pdf"))).toBe(false);
  });

  it("honours the declared type only for signature-less text formats", () => {
    const csv = Buffer.from("name,email\nAcme,a@b.com\n");
    expect(sniffMime(csv, "text/csv")).toBe("text/csv");
    expect(sniffMime(csv, "text/plain")).toBe("text/plain");
  });

  it("treats a text payload declared as Excel as CSV (Windows .csv upload)", () => {
    // Browsers on Windows commonly report .csv as application/vnd.ms-excel. A
    // real .xls carries the OLE2 signature and is matched earlier, so this path
    // only ever sees signature-less text.
    const csv = Buffer.from("company,email\nAcme LLC,a@b.com\n");
    expect(sniffMime(csv, "application/vnd.ms-excel")).toBe("text/csv");
    expect(isAllowedMime(sniffMime(csv, "application/vnd.ms-excel"))).toBe(true);
  });

  it("does not let the Excel fallback smuggle binary content", () => {
    const binary = Buffer.from("504b0304deadbeef00ff00ff", "hex");
    expect(isAllowedMime(sniffMime(binary, "application/vnd.ms-excel"))).toBe(false);
  });

  it("rejects unrecognized bytes that claim an allowed binary type", () => {
    // This is the gap the audit found: arbitrary content declaring image/png (or
    // any other allowed type) used to sail straight through on the client's word.
    const arbitrary = Buffer.from("<html><script>alert(1)</script></html>");
    expect(isAllowedMime(sniffMime(arbitrary, "image/png"))).toBe(false);
    expect(isAllowedMime(sniffMime(arbitrary, "application/pdf"))).toBe(false);
    expect(isAllowedMime(sniffMime(arbitrary, DOCX))).toBe(false);
  });

  it("rejects a payload too short to carry any signature", () => {
    expect(isAllowedMime(sniffMime(Buffer.from("ab"), "application/pdf"))).toBe(false);
  });
});
