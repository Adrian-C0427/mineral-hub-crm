#!/usr/bin/env python3
"""Parse the RRC Drilling Permit Master (daf802.txt) into FULL permit history
for the requested counties — every permit filing, not just the latest per API
(parse_daf802.py keeps latest-per-api8 for the enrichment waterfall; this one
feeds rrc.permits).

Same line layout as parse_daf802.py:
  01 root    permit/status key 2:14 (last 3 digits = county code),
             leaseName 14:46, district 46:48, operatorNo 48:54,
             permit date 58:66, operatorName 66:98
  02 segment same key at 2:14; wellNo 48:54; api8 = last 8 chars

Output: JSON array of {statusNo, api8, county, leaseName, district,
operatorNo, permitDate, operator, wellNo}, deduped by (statusNo, api8).

Usage:
  python3 parse_daf802_full.py /path/to/daf802.txt out.json --counties 161 289 ...
"""
import argparse
import json
import time


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--counties", nargs="+", required=True)
    args = ap.parse_args()
    want = set(args.counties)

    permits: dict[tuple[str, str], dict] = {}
    root = None

    t0 = time.time()
    with open(args.src, "r", errors="replace") as f:
        for line in f:
            t = line[0:2]
            if t == "01" and len(line) >= 200:
                key, date = line[2:14], line[58:66]
                if not (key.isdigit() and date.isdigit()):
                    root = None
                    continue
                root = (key, line[11:14], line[14:46].strip(), line[46:48],
                        line[48:54], date, line[66:98].strip())
            elif t == "02" and len(line) >= 500:
                if root is None or line[2:14] != root[0] or root[1] not in want:
                    continue
                api8 = line.rstrip("\n")[-8:]
                if not (api8.isdigit() and api8[:3] == root[1]):
                    continue
                permits[(root[0], api8)] = {
                    "statusNo": root[0], "api8": api8, "county": root[1],
                    "leaseName": root[2], "district": root[3], "operatorNo": root[4],
                    "permitDate": root[5], "operator": root[6],
                    "wellNo": line[48:54].strip(),
                }

    out = list(permits.values())
    print(f"full permit history: {len(out):,} filings in {time.time() - t0:.0f}s")
    json.dump(out, open(args.out, "w"))


if __name__ == "__main__":
    main()
