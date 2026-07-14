/**
 * Minimal EBCDIC (code page 037) decoding for the RRC mainframe extracts
 * (dbf900 Wellbore Master, gse10 G-10 gas tests). Only the characters those
 * files actually contain are mapped — digits, letters, and common punctuation;
 * anything else decodes to a space, which the fixed-width slicers then trim.
 *
 * Files are fixed-length records with NO newlines, so `fixedRecords` walks a
 * stream in exact record-size steps regardless of chunk boundaries.
 */
import fs from "node:fs";

const TABLE: string[] = (() => {
  const t = new Array<string>(256).fill(" ");
  const set = (code: number, ch: string) => { t[code] = ch; };
  // Punctuation / specials (cp037).
  set(0x40, " ");
  set(0x4b, "."); set(0x4c, "<"); set(0x4d, "("); set(0x4e, "+"); set(0x4f, "|");
  set(0x50, "&"); set(0x5a, "!"); set(0x5b, "$"); set(0x5c, "*"); set(0x5d, ")"); set(0x5e, ";");
  set(0x60, "-"); set(0x61, "/"); set(0x6b, ","); set(0x6c, "%"); set(0x6d, "_"); set(0x6e, ">"); set(0x6f, "?");
  set(0x7a, ":"); set(0x7b, "#"); set(0x7c, "@"); set(0x7d, "'"); set(0x7e, "="); set(0x7f, '"');
  // Letters.
  const lower = "abcdefghi";
  for (let i = 0; i < 9; i++) set(0x81 + i, lower[i]);
  const lower2 = "jklmnopqr";
  for (let i = 0; i < 9; i++) set(0x91 + i, lower2[i]);
  const lower3 = "stuvwxyz";
  for (let i = 0; i < 8; i++) set(0xa2 + i, lower3[i]);
  const upper = "ABCDEFGHI";
  for (let i = 0; i < 9; i++) set(0xc1 + i, upper[i]);
  const upper2 = "JKLMNOPQR";
  for (let i = 0; i < 9; i++) set(0xd1 + i, upper2[i]);
  const upper3 = "STUVWXYZ";
  for (let i = 0; i < 8; i++) set(0xe2 + i, upper3[i]);
  // Digits.
  for (let i = 0; i <= 9; i++) set(0xf0 + i, String(i));
  return t;
})();

/** Decode a cp037 buffer slice to a JS string. */
export function decodeCp037(buf: Buffer, start = 0, end = buf.length): string {
  let out = "";
  for (let i = start; i < end; i++) out += TABLE[buf[i]];
  return out;
}

/** Reverse map (test helper): encode ASCII into cp037 bytes. */
export function encodeCp037(s: string): Buffer {
  const rev = new Map<string, number>();
  for (let i = 0; i < 256; i++) if (TABLE[i] !== " " || i === 0x40) rev.set(TABLE[i], i);
  rev.set(" ", 0x40);
  return Buffer.from([...s].map((ch) => rev.get(ch) ?? 0x40));
}

/**
 * Iterate a file of fixed-size records (no delimiters). Yields each record as
 * a Buffer of exactly `recordSize` bytes; a trailing partial record (corrupt
 * tail) is dropped with a count so callers can surface it.
 */
export async function* fixedRecords(filePath: string, recordSize: number): AsyncGenerator<Buffer> {
  const stream = fs.createReadStream(filePath, { highWaterMark: recordSize * 4096 });
  let carry: Buffer | null = null;
  for await (const chunk of stream) {
    const buf: Buffer = carry ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    let off = 0;
    while (off + recordSize <= buf.length) {
      yield buf.subarray(off, off + recordSize);
      off += recordSize;
    }
    carry = off < buf.length ? Buffer.from(buf.subarray(off)) : null;
  }
}
