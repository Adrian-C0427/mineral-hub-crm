#!/usr/bin/env python3
"""Parse the RRC Drilling Permit Master (daf802.txt, ASCII line records).

Line types used (offsets within the line):
  01 root (~213c)   permit key 2:14 (county code at 11:14), leaseName 14:46,
                    district 46:48, operatorNo 48:54, permit date 58:66,
                    operatorName 66:98
  02 segment (~511c) same permit key at 2:14; api8 = last 8 chars

Outputs two JSON files:
  <out_prefix>_permits.json    api8 -> {leaseName, district, operatorNo,
                               permitDate, operator, wellNo} for the requested
                               counties (latest permit per api8 wins). The
                               operator is the operator AT PERMIT TIME.
  <out_prefix>_operators.json  operatorNo -> latest operator name (statewide
                               dictionary, useful to resolve numbers from
                               dbf900 record 23 / gse10)

Usage:
  python3 parse_daf802.py /path/to/daf802.txt out/daf802 --counties 161 289
"""
import argparse
import json
import time


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", help="path to daf802.txt")
    ap.add_argument("out_prefix", help="output prefix (writes _permits.json and _operators.json)")
    ap.add_argument("--counties", nargs="+", required=True,
                    help="3-digit RRC county codes (e.g. 161 289)")
    args = ap.parse_args()
    want = set(args.counties)

    permits: dict[str, dict] = {}
    ops: dict[str, tuple[str, str]] = {}  # opNo -> (permitDate, name)
    root = None  # (permitKey, county, leaseName, district, opNo, date, opName)

    t0 = time.time()
    with open(args.src, "r", errors="replace") as f:
        for line in f:
            t = line[0:2]
            if t == "01" and len(line) >= 200:
                key, date = line[2:14], line[58:66]
                if not (key.isdigit() and date.isdigit()):
                    root = None
                    continue
                op_no, op_name = line[48:54], line[66:98].strip()
                root = (key, line[11:14], line[14:46].strip(), line[46:48], op_no, date, op_name)
                if op_name and op_no.isdigit() and int(op_no) > 0:
                    prev = ops.get(op_no)
                    if prev is None or date > prev[0]:
                        ops[op_no] = (date, op_name)
            elif t == "02" and len(line) >= 500:
                if root is None or line[2:14] != root[0] or root[1] not in want:
                    continue
                api8 = line.rstrip("\n")[-8:]
                if not (api8.isdigit() and api8[:3] == root[1]):
                    continue
                info = {"leaseName": root[2], "district": root[3], "operatorNo": root[4],
                        "permitDate": root[5], "operator": root[6], "wellNo": line[48:54].strip()}
                prev = permits.get(api8)
                if prev is None or info["permitDate"] > prev["permitDate"]:
                    permits[api8] = info

    print(f"permits kept {len(permits):,}, operator dictionary {len(ops):,} in {time.time() - t0:.0f}s")
    json.dump(permits, open(args.out_prefix + "_permits.json", "w"))
    json.dump({k: v[1] for k, v in ops.items()}, open(args.out_prefix + "_operators.json", "w"))
    print("wrote", args.out_prefix + "_permits.json", "and", args.out_prefix + "_operators.json")


if __name__ == "__main__":
    main()
