#!/usr/bin/env python3
"""Build raw county wells/wellbores GeoJSON from an RRC "All Layers by County"
shapefile bundle (Shp{code}.zip: well{code}s = surface points, well{code}l =
wellbore lines). Output matches the hand-built Leon/Freestone format so
enrich_wells.py and the importers consume all counties identically.

Geometry sources (verified against the Leon originals):
  wells      dbf LONG83/LAT83 attributes (NAD83) — NOT the shp geometry,
             which is NAD27 (per the bundled .prj).
  wellbores  shp polyline vertices (NAD27), shifted per line by its own
             surface well's (LAT83-LAT27, LONG83-LONG27) delta — the datum
             shift varies over ~50 m statewide, so a per-well constant is
             sub-meter accurate along a lateral. Falls back to the county's
             mean delta when the surface well is unknown.

SYMNUM -> symbol/type/status mapping was recovered empirically from the
enriched Leon+Freestone data (20 codes, unambiguous). Unknown codes map to
symbol "Well", type/status "Unknown" and are counted in the summary.

Usage:
  python3 build_wells.py <ShpNNN.zip> <code> "<County Name>" <out_dir>
  e.g. python3 build_wells.py ~/rrc-data/documents_20260703/Shp365.zip 365 "Panola" work12/data
"""
import json
import os
import struct
import sys
import zipfile

# SYMNUM -> (symbol, type, status)
SYM = {
    2: ("Permitted Location", "Location", "Permitted"),
    3: ("Dry Hole", "Dry Hole", "Dry Hole"),
    4: ("Oil", "Oil", "Producing"),
    5: ("Gas", "Gas", "Producing"),
    6: ("Oil/Gas", "Oil/Gas", "Producing"),
    7: ("Plugged Oil", "Oil", "Plugged"),
    8: ("Plugged Gas", "Gas", "Plugged"),
    9: ("Canceled/Abandoned Location", "Location", "Canceled/Abandoned"),
    10: ("Plugged Oil/Gas", "Oil/Gas", "Plugged"),
    11: ("Injection/Disposal", "Injection/Disposal", "Active"),
    19: ("Shut-In (Oil)", "Oil", "Shut-In"),
    20: ("Shut-In (Gas)", "Gas", "Shut-In"),
    21: ("Injection/Disposal from Oil", "Injection/Disposal", "Active"),
    22: ("Well", "Location", "Surface location"),
    23: ("Injection/Disposal from Oil/Gas", "Injection/Disposal", "Active"),
    74: ("Water Supply", "Water Supply", "Active"),
    75: ("Water Supply from Oil", "Water Supply", "Active"),
    76: ("Water Supply from Gas", "Water Supply", "Active"),
    86: ("Horizontal Well (Surface Loc.)", "Horizontal", "Surface location"),
    87: ("Directional/Sidetrack (Surface Loc.)", "Directional", "Surface location"),
}
CATEGORY = {
    "Producing": "producing", "Permitted": "permitted", "Plugged": "plugged",
    "Dry Hole": "dry", "Shut-In": "shutin", "Canceled/Abandoned": "canceled",
    "Surface location": "location", "Unknown": "other",
}


def dbf_records(data: bytes):
    hdrlen = struct.unpack("<H", data[8:10])[0]
    reclen = struct.unpack("<H", data[10:12])[0]
    nrec = struct.unpack("<I", data[4:8])[0]
    nf = (hdrlen - 33) // 32
    fields = []
    for i in range(nf):
        off = 32 + i * 32
        fields.append((data[off:off + 11].split(b"\x00")[0].decode(), data[off + 16]))
    pos = hdrlen
    for _ in range(nrec):
        rec = data[pos:pos + reclen]
        pos += reclen
        vals, o = {}, 1
        for nm, ln in fields:
            vals[nm] = rec[o:o + ln].decode("ascii", "replace").strip()
            o += ln
        yield vals


def shp_polylines(data: bytes):
    """Yield lists of (x, y) vertex lists (one per part) per polyline record."""
    pos = 100
    while pos < len(data):
        clen = struct.unpack(">i", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + clen * 2]
        pos += 8 + clen * 2
        st = struct.unpack("<i", body[0:4])[0]
        if st != 3:  # null / non-polyline
            yield []
            continue
        nparts, npts = struct.unpack("<ii", body[36:44])
        parts = list(struct.unpack(f"<{nparts}i", body[44:44 + 4 * nparts]))
        pts_off = 44 + 4 * nparts
        pts = [struct.unpack("<dd", body[pts_off + i * 16:pts_off + i * 16 + 16]) for i in range(npts)]
        parts.append(npts)
        yield [pts[parts[i]:parts[i + 1]] for i in range(nparts)]


def main() -> None:
    if len(sys.argv) != 5:
        print(__doc__)
        sys.exit(1)
    zip_path, code, county, out_dir = sys.argv[1:5]
    z = zipfile.ZipFile(zip_path)
    os.makedirs(out_dir, exist_ok=True)

    # --- wells (surface points from dbf NAD83 attrs) ---
    delta_by_sid: dict[str, tuple[float, float]] = {}
    deltas: list[tuple[float, float]] = []
    feats, unknown_syms = [], {}
    for v in dbf_records(z.read(f"well{code}s.dbf")):
        try:
            lon83, lat83 = float(v["LONG83"]), float(v["LAT83"])
            lon27, lat27 = float(v["LONG27"]), float(v["LAT27"])
        except ValueError:
            continue
        d = (lon83 - lon27, lat83 - lat27)
        delta_by_sid[v["SURFACE_ID"]] = d
        deltas.append(d)
        sym = int(v["SYMNUM"] or 0)
        symbol, typ, status = SYM.get(sym, ("Well", "Unknown", "Unknown"))
        if sym not in SYM:
            unknown_syms[sym] = unknown_syms.get(sym, 0) + 1
        fid = int(v["SURFACE_ID"])
        api8 = v["API"]
        feats.append({
            "type": "Feature", "id": fid,
            "properties": {
                "fid": fid, "api8": api8, "api": ("42" + api8) if api8 else "",
                "wellId": v.get("WELLID", ""), "symbol": symbol, "type": typ,
                "status": status, "category": CATEGORY.get(status, "other"),
                "county": county,
            },
            "geometry": {"type": "Point", "coordinates": [round(lon83, 6), round(lat83, 6)]},
        })
    mean_d = (sum(d[0] for d in deltas) / len(deltas), sum(d[1] for d in deltas) / len(deltas)) if deltas else (0.0, 0.0)

    # --- wellbores (shp NAD27 lines + per-well datum shift) ---
    bores = []
    lrecs = list(dbf_records(z.read(f"well{code}l.dbf")))
    for v, parts in zip(lrecs, shp_polylines(z.read(f"well{code}l.shp"))):
        if not parts:
            continue
        sid = v["SURFACE_ID"]
        dx, dy = delta_by_sid.get(sid, mean_d)
        st = v.get("STCODE", "")
        wtype = "Horizontal" if st.startswith("H") else "Directional" if st.startswith("D") else "Horizontal"
        coords = [[round(x + dx, 6), round(y + dy, 6)] for part in parts for (x, y) in part]
        # A surface well can have several laterals; BOTTOM_ID is the unique key.
        bid = v.get("BOTTOM_ID", "")
        fid = int(bid) if bid.isdigit() else (int(sid) if sid.isdigit() else 0)
        bores.append({
            "type": "Feature", "id": fid,
            "properties": {"fid": fid, "surfaceId": int(sid) if sid.isdigit() else 0, "api": v.get("API10") or v.get("API", ""), "wellboreType": wtype, "stcode": st},
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    key = county.lower().replace(" ", "")
    wp = os.path.join(out_dir, f"{key}-wells.geojson")
    bp = os.path.join(out_dir, f"{key}-wellbores.geojson")
    with open(wp, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh, separators=(",", ":"))
    with open(bp, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": bores}, fh, separators=(",", ":"))
    print(f"{county} ({code}): {len(feats)} wells, {len(bores)} wellbores"
          + (f", UNKNOWN SYMNUMs {unknown_syms}" if unknown_syms else ""))


if __name__ == "__main__":
    main()
