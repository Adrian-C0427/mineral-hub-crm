#!/usr/bin/env python3
"""Parse RRC daily completion-packet zips ("Completion Information in Data
Format": documents_*/{MM-DD-YYYY}.zip containing
{district}/trackingNo_{n}/packetData_{n}_{status}.dat, '{'-delimited records)
into a flat JSON array for rrc.completions.

Packet structure (observed 2021–2026):
  line 1  : trackingNo{filingType{attachments...        (W-2 = oil, G-1 = gas)
  PACKET{ : [1] trackingNo [3] filedDate [5] operatorNo [6] api8
            [21] completionDate [25] fieldNo [26] wellName/lease
            [27] district [28] countyCode [29] fieldName [30] survey
            [32] wellNo [36] lat [37] lon
Rows failing api8/county validation are counted and skipped. Dedupe by
(trackingNo, api8) — resubmissions keep the LAST status seen (zips are
processed in filename date order).

Usage:
  python3 parse_completions.py out.json --counties 161 289 ... --zip-dirs DIR [DIR...]
"""
import argparse
import glob
import json
import os
import zipfile


def parse_packet(text: str, fname: str):
    lines = text.split("\n")
    filing_type = None
    first = lines[0].split("{") if lines else []
    if len(first) > 1:
        filing_type = first[1].strip() or None
    status = "Submitted"
    if "_" in fname:
        status = fname.rsplit("_", 1)[-1].replace(".dat", "")
    for ln in lines:
        if not ln.startswith("PACKET{"):
            continue
        p = ln.split("{")
        if len(p) < 38:
            return None
        return {
            "trackingNo": p[1].strip(), "filedDate": p[3].strip(),
            "operatorNo": p[5].strip(), "api8": p[6].strip(),
            "completionDate": p[21].strip() or None, "fieldNo": p[25].strip() or None,
            "wellName": p[26].strip() or None, "district": p[27].strip() or None,
            "county": p[28].strip(), "fieldName": p[29].strip() or None,
            "survey": p[30].strip() or None, "wellNo": p[32].strip() or None,
            "lat": p[36].strip() or None, "lon": p[37].strip() or None,
            "filingType": filing_type, "status": status,
        }
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("out")
    ap.add_argument("--counties", nargs="+", required=True)
    ap.add_argument("--zip-dirs", nargs="+", required=True)
    args = ap.parse_args()
    want = set(args.counties)

    # Collect zips across dirs; when the same date file exists in several dirs
    # keep the last dir's copy. Sort chronologically (MM-DD-YYYY -> Y,M,D).
    by_name: dict[str, str] = {}
    for d in args.zip_dirs:
        for z in glob.glob(os.path.join(os.path.expanduser(d), "*.zip")):
            by_name[os.path.basename(z)] = z
    def datekey(n: str):
        m, d, y = n.replace(".zip", "").split("-")
        return (y, m, d)
    zips = [by_name[n] for n in sorted(by_name, key=datekey)]

    rows: dict[tuple[str, str], dict] = {}
    bad = scanned = 0
    for zp in zips:
        try:
            z = zipfile.ZipFile(zp)
        except zipfile.BadZipFile:
            continue
        for n in z.namelist():
            if "packetData" not in n:
                continue
            scanned += 1
            try:
                rec = parse_packet(z.read(n).decode("utf-8", "replace"), os.path.basename(n))
            except Exception:
                bad += 1
                continue
            if rec is None or not (rec["api8"].isdigit() and len(rec["api8"]) == 8):
                bad += 1
                continue
            if rec["county"] not in want or rec["api8"][:3] != rec["county"]:
                continue
            rows[(rec["trackingNo"], rec["api8"])] = rec

    out = list(rows.values())
    print(f"completions: scanned {scanned:,} packets across {len(zips)} zips; "
          f"kept {len(out):,} for {len(want)} counties; {bad:,} unparseable")
    json.dump(out, open(args.out, "w"))


if __name__ == "__main__":
    main()
