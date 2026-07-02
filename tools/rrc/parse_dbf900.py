#!/usr/bin/env python3
"""Parse a dbf900 county extract (from extract_dbf900.py) into per-API
enrichment JSON: api8 -> {oilGas, district, leaseNo, wellNo, leaseName12,
survey12, formations[], plugDate, plugContractor, rootDate, rootOpNo,
w10Year, w10OpNo, w10FieldNo}.

Record-type layout (offsets within the 247-char record):
  01 root       api8 2:10, spud/permit date 20:28, historic operatorNo 88:94
  02 completion oil: district 3:5, lease 5:10, wellNo 10:16
                gas: lease 3:9, district 16:18, wellNo 18:24
                a well may have several 02s (recompletions); the LAST one is
                the most current lease
  09 formation  name 5:37 (one record per formation)
  12 location   leaseName 2:34, survey 34:82
  14 plugging   plug date 2:10, plugging contractor 15:47 (not the operator)
  23 W-10 (oil) operatorNo 11:17, year 17:21, fieldNo 25:33 (latest year wins)

Optionally validates lease/district/oilGas/operatorNo/fieldNo agreement
against an already-enriched wells geojson (--validate).

Usage:
  python3 parse_dbf900.py extract.txt dbf900_parsed.json \
      [--validate ../client/public/data/freestone-wells.geojson]
"""
import argparse
import json


def parse(extract_path: str) -> dict:
    wells: dict[str, dict] = {}
    with open(extract_path, "rb") as f:
        for raw in f:
            line = raw.decode("ascii", "replace").rstrip("\n")
            api, _, r = line.partition("|")
            if not r:
                continue
            t = r[0:2]
            w = wells.setdefault(api, {"api8": api})
            if t == "01":
                w["rootDate"] = r[20:28]
                w["rootOpNo"] = r[88:94]
            elif t == "02":
                og = r[2:3]
                if og == "G":
                    w["oilGas"] = "Gas"
                    w["leaseNo"] = r[3:9].strip()
                    w["district"] = r[16:18]
                    w["wellNo"] = r[18:24].strip()
                elif og == "O":
                    w["oilGas"] = "Oil"
                    w["district"] = r[3:5]
                    w["leaseNo"] = r[5:10].strip()
                    w["wellNo"] = r[10:16].strip()
            elif t == "12":
                w["leaseName12"] = r[2:34].strip()
                w["survey12"] = r[34:82].strip()
            elif t == "09":
                nm = r[5:37].strip()
                if nm:
                    w.setdefault("formations", [])
                    if nm not in w["formations"]:
                        w["formations"].append(nm)
            elif t == "14":
                w["plugDate"] = r[2:10]
                w["plugContractor"] = r[15:47].strip()
            elif t == "23":
                yr, opno, fldno = r[17:21], r[11:17], r[25:33]
                if yr.isdigit() and opno.isdigit() and int(opno) > 0:
                    if yr > w.get("w10Year", "0000"):
                        w["w10Year"], w["w10OpNo"], w["w10FieldNo"] = yr, opno, fldno
    return wells


def validate(wells: dict, geojson_path: str) -> None:
    fc = json.load(open(geojson_path))
    truth = {f["properties"]["api8"]: f["properties"] for f in fc["features"]
             if f["properties"].get("leaseNo") and f["properties"].get("operator")}
    tot = lease = og = 0
    op_tot = op_hit = fld_tot = fld_hit = 0
    for api, tp in truth.items():
        d = wells.get(api)
        if not d or "leaseNo" not in d:
            continue
        tot += 1
        if d["leaseNo"].lstrip("0") == (tp["leaseNo"] or "").lstrip("0"):
            lease += 1
        if d.get("oilGas") == tp.get("oilGas"):
            og += 1
        if tp.get("operatorNo") and d.get("w10OpNo"):
            op_tot += 1
            op_hit += d["w10OpNo"].lstrip("0") == tp["operatorNo"].lstrip("0")
        if tp.get("fieldNo") and d.get("w10FieldNo"):
            fld_tot += 1
            fld_hit += d["w10FieldNo"].lstrip("0") == tp["fieldNo"].lstrip("0")
    print(f"{geojson_path}: {tot} truth wells; lease agreement {lease/max(tot,1):.1%} "
          f"(disagreements are usually recompletions where dbf900 is newer), "
          f"oilGas {og/max(tot,1):.1%}, w10 operatorNo {op_hit}/{op_tot}, fieldNo {fld_hit}/{fld_tot}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("extract", help="output of extract_dbf900.py")
    ap.add_argument("out", help="output JSON path")
    ap.add_argument("--validate", nargs="*", default=[],
                    help="enriched wells geojson(s) to check offsets against")
    args = ap.parse_args()

    wells = parse(args.extract)
    print("dbf900 wells parsed:", len(wells))
    for g in args.validate:
        validate(wells, g)
    json.dump(wells, open(args.out, "w"))
    print("wrote", args.out)


if __name__ == "__main__":
    main()
