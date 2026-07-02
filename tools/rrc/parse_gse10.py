#!/usr/bin/env python3
"""Parse the RRC G-10 gas-well test file (gse10.ebc) into a gas-lease ->
operator-number map.

gse10 is EBCDIC (cp037), fixed 130-byte records starting "GT":
  district 2:4, gas RRC id 4:10, operatorNo 104:110

The operator here is CURRENT (validated 100% against PDQ operators on the
initial Leon/Freestone import), which makes it the best statewide source for
a gas well's present operator.

Output JSON: {"<district>|<gasId>": "<operatorNo>", ...}

Usage:
  python3 parse_gse10.py /path/to/gse10.ebc gse10_ops.json
"""
import argparse
import json

REC = 130
TBL = bytes(
    ord(bytes([i]).decode("cp037")) if ord(bytes([i]).decode("cp037")) < 128 else 0x3F
    for i in range(256)
)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", help="path to gse10.ebc")
    ap.add_argument("out", help="output JSON path")
    args = ap.parse_args()

    data = open(args.src, "rb").read().translate(TBL)
    out: dict[str, str] = {}
    for i in range(0, len(data), REC):
        r = data[i:i + REC]
        if r[0:2] != b"GT" or not (r[2:4].isdigit() and r[4:10].isdigit()):
            continue
        op = r[104:110].decode()
        if op.isdigit() and int(op) > 0:
            out[f"{r[2:4].decode()}|{r[4:10].decode()}"] = op
    print("lease->operator entries:", len(out))
    json.dump(out, open(args.out, "w"))
    print("wrote", args.out)


if __name__ == "__main__":
    main()
