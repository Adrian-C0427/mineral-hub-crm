#!/usr/bin/env python3
"""Extract per-county records from the RRC Wellbore Master (dbf900).

dbf900 is a statewide EBCDIC (cp037) file of fixed 247-byte records with no
newlines, sorted by API. The first two bytes of each record are its type;
type 01 is the wellbore root carrying the API (county 3 + unique 5 at bytes
2:10), and types 02..28 are segments belonging to the preceding root.

Writes one ASCII line per record, prefixed with the owning api8:
  <api8>|<247-byte record, EBCDIC->ASCII, rstripped>

Usage:
  python3 extract_dbf900.py /path/to/dbf900.ebc out.txt --counties 161 289
"""
import argparse
import time

REC = 247

# EBCDIC(cp037) -> ASCII translation table (unmappable -> '?')
TBL = bytes(
    ord(bytes([i]).decode("cp037")) if ord(bytes([i]).decode("cp037")) < 128 else 0x3F
    for i in range(256)
)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", help="path to dbf900.ebc")
    ap.add_argument("out", help="output text file")
    ap.add_argument("--counties", nargs="+", required=True,
                    help="3-digit RRC county codes (e.g. 161 289)")
    args = ap.parse_args()
    want = set(args.counties)
    stop_after = max(want)  # file is API-sorted; exit once solidly past the last county

    t0 = time.time()
    n = kept = seen_after = 0
    cur_api = ""
    cur_keep = False
    done = False
    with open(args.src, "rb") as f, open(args.out, "w") as out:
        while not done:
            chunk = f.read(REC * 65536)
            if not chunk:
                break
            a = chunk.translate(TBL)
            for i in range(0, len(a), REC):
                r = a[i:i + REC]
                if r[0:1] == b"0" and r[1:2] == b"1" and r[2:10].isdigit():
                    cty = r[2:5].decode()
                    cur_api = r[2:10].decode()
                    cur_keep = cty in want
                    if not cur_keep and cty > stop_after:
                        seen_after += 1
                        if seen_after > 50000:
                            done = True
                            break
                if cur_keep:
                    out.write(cur_api + "|" + r.decode("ascii", "replace").rstrip() + "\n")
                    kept += 1
                n += 1
    print(f"records scanned ~{n:,}, kept {kept:,}, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
