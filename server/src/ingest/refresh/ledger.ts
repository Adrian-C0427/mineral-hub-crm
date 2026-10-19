/**
 * RRC Oil and Gas Ledgers ("masters", EBCDIC, fixed-length): the proration
 * schedule's per-well monthly records, read here for one thing — the acres
 * RRC currently assigns to each well (gas: MO-ACRE, manual GSA020; oil:
 * WM-ACRE, manual OLA013). That is the well's proration acreage, which can be
 * a share of a larger pooled unit — so it is kept as its own value ("acres
 * assigned"), never passed off as the W-1 unit size.
 *
 *   gas  gsf00Nl.ebc  2,120-byte records; well record id '5' (byte 1);
 *        district 2–3, gas well RRC id 19–24; 14 monthly segments of 116 bytes
 *        from position 317: W-DATE (YYYYMM) +0, MO-ACRE S9(4)V9(3) COMP-3 +75
 *   oil  olf00Nl.ebc  1,200-byte records; well record id '5';
 *        district 2–3, lease 19–23, well no 27–32; 14 monthly segments of 73
 *        bytes from position 179: date +0, WM-ACRE S999V99 COMP-3 +46
 * The newest month that carries acreage wins.
 */
import { decodeCp037 } from "../ebcdic.js";

/** IBM packed decimal (COMP-3): two digits per byte, sign in the last nibble. */
export function comp3(buf: Buffer, start: number, len: number, scale: number): number | null {
  let value = 0;
  for (let i = start; i < start + len; i++) {
    const hi = buf[i] >> 4, lo = buf[i] & 0x0f;
    if (hi > 9) return null;
    value = value * 10 + hi;
    if (i < start + len - 1) {
      if (lo > 9) return null;
      value = value * 10 + lo;
    } else if (lo < 0x0a) {
      return null; // the last nibble must be a sign (C/F +, D/B −) — not packed data
    } else if (lo === 0x0d || lo === 0x0b) {
      value = -value;
    }
  }
  return value / 10 ** scale;
}

export interface AssignedAcres { acres: number; ym: string }

/** Ledger well-number spelling ("2 D") → the Wellbore Query's ("2D"). */
export const ledgerWellNo = (s: string) => s.replace(/\s+/g, "").toUpperCase();
export const gasLedgerKey = (district: string, gasId: string) => `${district.trim().padStart(2, "0")}|${gasId.trim().replace(/^0+(?=\d)/, "")}`;
export const oilLedgerKey = (district: string, lease: string, wellNo: string) =>
  `${district.trim().padStart(2, "0")}|${lease.trim().replace(/^0+(?=\d)/, "")}|${ledgerWellNo(wellNo)}`;

function newestAcres(rec: Buffer, first: number, segLen: number, acreOff: number, acreLen: number, scale: number): AssignedAcres | null {
  let best: AssignedAcres | null = null;
  for (let k = 0; k < 14; k++) {
    const o = first + k * segLen;
    const ym = decodeCp037(rec, o, o + 6);
    const acres = comp3(rec, o + acreOff, acreLen, scale);
    if (/^\d{6}$/.test(ym) && acres && acres > 0 && (!best || ym > best.ym)) best = { acres, ym };
  }
  return best;
}

export function parseGasLedger(buf: Buffer, into = new Map<string, AssignedAcres>()): Map<string, AssignedAcres> {
  const LEN = 2120;
  for (let off = 0; off + LEN <= buf.length; off += LEN) {
    const r = buf.subarray(off, off + LEN);
    if (decodeCp037(r, 0, 1) !== "5") continue;
    const a = newestAcres(r, 316, 116, 75, 4, 3);
    if (a) into.set(gasLedgerKey(decodeCp037(r, 1, 3), decodeCp037(r, 18, 24)), a);
  }
  return into;
}

export function parseOilLedger(buf: Buffer, into = new Map<string, AssignedAcres>()): Map<string, AssignedAcres> {
  const LEN = 1200;
  for (let off = 0; off + LEN <= buf.length; off += LEN) {
    const r = buf.subarray(off, off + LEN);
    if (decodeCp037(r, 0, 1) !== "5") continue;
    const a = newestAcres(r, 178, 73, 46, 3, 2);
    if (a) into.set(oilLedgerKey(decodeCp037(r, 1, 3), decodeCp037(r, 18, 23), decodeCp037(r, 26, 32)), a);
  }
  return into;
}
