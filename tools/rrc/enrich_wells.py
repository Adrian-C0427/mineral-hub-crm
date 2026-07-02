#!/usr/bin/env python3
"""Fill enrichment gaps in the county wells geojsons from parsed RRC bulk
data (parse_dbf900.py, parse_daf802.py, parse_gse10.py outputs).

Fill-only: existing values are never overwritten, with one exception — wells
whose dbf900 completion history points at a *newer* lease that has strictly
more recent production than the currently joined lease get re-pointed
("lease-currency fix": the well was recompleted and the old join is stale).
Their lease-level cums are cleared because those belonged to the old lease.

Operator waterfall for wells missing one (best source first):
  1. sibling well on the same lease that already has PDQ enrichment (current)
  2. gse10 operator number for the gas lease (current)
  3. dbf900 record-23 W-10 operator number (oil; as of the dbf900 snapshot)
  4. daf802 permit operator (historic — right answer for permitted locations)
  5. dbf900 root historic operator number
Operator numbers resolve to names via the PDQ-enriched wells first, then the
statewide daf802 operator dictionary.

Also fills: leaseNo/district/oilGas (dbf900 record 02), leaseName (record 12
or permit), field (record-23 fieldNo via the PDQ field dictionary),
formations (record 09), and lastProd (from the production series).

Runs passes until a fixed point: wells enriched in one pass join the sibling
dictionary for the next, so operator names propagate across shared leases.
Idempotent — re-running against already-enriched files is a no-op.

Usage (from tools/rrc, after running the three parsers into work/):
  python3 enrich_wells.py --data-dir ../../client/public/data \
      --work-dir work --counties leon freestone
"""
import argparse
import collections
import json
import os


def last_nonzero(series):
    mx = None
    for m, o, g in series:
        if o + g > 0 and (mx is None or m > mx):
            mx = m
    return mx


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", required=True, help="client/public/data")
    ap.add_argument("--work-dir", required=True,
                    help="directory with dbf900_parsed.json, daf802_permits.json, "
                         "daf802_operators.json, gse10_ops.json")
    ap.add_argument("--counties", nargs="+", required=True,
                    help="county keys with {key}-wells.geojson + {key}-production.json")
    args = ap.parse_args()

    W = args.work_dir
    db = json.load(open(os.path.join(W, "dbf900_parsed.json")))
    permits = json.load(open(os.path.join(W, "daf802_permits.json")))
    daf_ops = json.load(open(os.path.join(W, "daf802_operators.json")))
    gse_ops = json.load(open(os.path.join(W, "gse10_ops.json")))

    wells_by_county = {}
    prod = {}
    for cty in args.counties:
        wells_by_county[cty] = json.load(open(os.path.join(args.data_dir, f"{cty}-wells.geojson")))
        prod.update(json.load(open(os.path.join(args.data_dir, f"{cty}-production.json"))))

    # Passes repeat until nothing changes: each pass rebuilds the sibling
    # dictionary, so wells enriched in pass N seed lease-mates in pass N+1.
    passno = 0
    while run_pass(args, db, permits, daf_ops, gse_ops, wells_by_county, prod, passno):
        passno += 1

    for cty in args.counties:
        path = os.path.join(args.data_dir, f"{cty}-wells.geojson")
        with open(path, "w") as f:
            json.dump(wells_by_county[cty], f, separators=(",", ":"))
        print("wrote", path)


def run_pass(args, db, permits, daf_ops, gse_ops, wells_by_county, prod, passno) -> bool:
    """One fill pass over every county; returns True if anything changed."""
    # dictionaries from already-enriched wells (all counties pooled)
    sibling = {}      # og|dist|lease -> {operator, operatorNo, leaseName, field, fieldNo}
    op_names = {}     # opNo (stripped) -> name
    field_names = {}  # fieldNo (stripped) -> name
    for fc in wells_by_county.values():
        for f in fc["features"]:
            p = f["properties"]
            if p.get("operator") and p.get("leaseNo") and p.get("oilGas"):
                k = f"{'G' if p['oilGas'] == 'Gas' else 'O'}|{p.get('district') or '05'}|{p['leaseNo']}"
                sibling.setdefault(k, {kk: p.get(kk) for kk in
                                       ("operator", "operatorNo", "leaseName", "field", "fieldNo")})
            if p.get("operatorNo") and p.get("operator"):
                op_names.setdefault(p["operatorNo"].lstrip("0"), p["operator"])
            if p.get("fieldNo") and p.get("field"):
                field_names.setdefault(p["fieldNo"].lstrip("0"), p["field"])

    def op_name(no):
        if not no or not no.strip("0"):
            return None
        return op_names.get(no.lstrip("0")) or daf_ops.get(no.zfill(6))

    changed = False
    for cty, fc in wells_by_county.items():
        st = collections.Counter()
        n = len(fc["features"])
        before_op = sum(1 for f in fc["features"] if f["properties"].get("operator"))

        for f in fc["features"]:
            p = f["properties"]
            d = db.get(p.get("api8") or "", {})
            pm = permits.get(p.get("api8") or "")

            def prodkey():
                if not p.get("leaseNo") or not p.get("oilGas"):
                    return None
                return f"{'G' if p['oilGas'] == 'Gas' else 'O'}|{p.get('district') or '05'}|{p['leaseNo']}"

            # lease-currency fix
            if p.get("leaseNo") and d.get("leaseNo") and d.get("oilGas"):
                d_lease = d["leaseNo"].zfill(6 if d["oilGas"] == "Gas" else 5)
                if d_lease.lstrip("0") != p["leaseNo"].lstrip("0"):
                    newk = f"{'G' if d['oilGas'] == 'Gas' else 'O'}|{d['district']}|{d_lease}"
                    new_last = last_nonzero(prod.get(newk, []))
                    old_last = last_nonzero(prod.get(prodkey() or "", []))
                    if new_last is not None and (old_last is None or new_last > old_last):
                        p["leaseNo"], p["oilGas"], p["district"] = d_lease, d["oilGas"], d["district"]
                        sib = sibling.get(newk)
                        if sib:
                            for kk in ("operator", "operatorNo", "leaseName", "field", "fieldNo"):
                                if sib.get(kk):
                                    p[kk] = sib[kk]
                        elif d.get("leaseName12"):
                            p["leaseName"] = d["leaseName12"]
                        if p["oilGas"] == "Gas":
                            no = gse_ops.get(f"{d['district']}|{d_lease}")
                            nm = op_name(no)
                            if nm:
                                p["operator"], p["operatorNo"] = nm, no
                        p["cumOil"] = p["cumGas"] = None
                        p["lastProd"] = f"{str(new_last)[:4]}-{str(new_last)[4:]}"
                        st["lease_currency_fixed"] += 1

            # leaseNo/district/oilGas fill
            if not p.get("leaseNo") and d.get("leaseNo") and d.get("oilGas") and d.get("district", "").strip():
                p["leaseNo"] = d["leaseNo"].zfill(6 if d["oilGas"] == "Gas" else 5)
                p["oilGas"] = p.get("oilGas") or d["oilGas"]
                p["district"] = p.get("district") or d["district"]
                st["lease_filled"] += 1

            # operator waterfall
            if not p.get("operator"):
                k = prodkey()
                sib = sibling.get(k) if k else None
                gse_no = (gse_ops.get(f"{p.get('district') or '05'}|{p['leaseNo']}")
                          if p.get("oilGas") == "Gas" and p.get("leaseNo") else None)
                if sib and sib.get("operator"):
                    p["operator"] = sib["operator"]
                    p["operatorNo"] = p.get("operatorNo") or sib.get("operatorNo")
                    if not p.get("leaseName"):
                        p["leaseName"] = sib.get("leaseName")
                    if not p.get("field"):
                        p["field"], p["fieldNo"] = sib.get("field"), sib.get("fieldNo")
                    st["op_from_sibling"] += 1
                elif gse_no and op_name(gse_no):
                    p["operator"], p["operatorNo"] = op_name(gse_no), gse_no
                    st["op_from_gse10"] += 1
                elif d.get("w10OpNo") and op_name(d["w10OpNo"]):
                    p["operator"], p["operatorNo"] = op_name(d["w10OpNo"]), d["w10OpNo"]
                    if d.get("w10FieldNo") and not p.get("field"):
                        fn = field_names.get(d["w10FieldNo"].lstrip("0"))
                        if fn:
                            p["field"], p["fieldNo"] = fn, d["w10FieldNo"]
                    st["op_from_w10"] += 1
                elif pm and pm.get("operator"):
                    p["operator"] = pm["operator"]
                    p["operatorNo"] = p.get("operatorNo") or pm.get("operatorNo")
                    if not p.get("leaseName"):
                        p["leaseName"] = pm.get("leaseName")
                    st["op_from_permit"] += 1
                elif d.get("rootOpNo") and op_name(d["rootOpNo"]):
                    p["operator"], p["operatorNo"] = op_name(d["rootOpNo"]), d["rootOpNo"]
                    st["op_from_root"] += 1

            # leaseName / field / formations fills
            if not p.get("leaseName"):
                if d.get("leaseName12"):
                    p["leaseName"] = d["leaseName12"]
                    st["leaseName_filled"] += 1
                elif pm and pm.get("leaseName"):
                    p["leaseName"] = pm["leaseName"]
                    st["leaseName_filled"] += 1
            if not p.get("field") and d.get("w10FieldNo"):
                fn = field_names.get(d["w10FieldNo"].lstrip("0"))
                if fn:
                    p["field"], p["fieldNo"] = fn, d["w10FieldNo"]
                    st["field_filled"] += 1
            if not p.get("formations") and d.get("formations"):
                p["formations"] = d["formations"]
                st["formations_filled"] += 1

            # lastProd from the production series
            k = prodkey()
            if k and k in prod and not p.get("lastProd"):
                ln = last_nonzero(prod[k])
                if ln:
                    p["lastProd"] = f"{str(ln)[:4]}-{str(ln)[4:]}"
                    st["lastProd_filled"] += 1

        after_op = sum(1 for f in fc["features"] if f["properties"].get("operator"))
        print(f"pass {passno} {cty}: operator {before_op} -> {after_op} of {n} "
              f"({before_op/n:.0%} -> {after_op/n:.0%}); {dict(st)}")
        if st:
            changed = True
    return changed


if __name__ == "__main__":
    main()
