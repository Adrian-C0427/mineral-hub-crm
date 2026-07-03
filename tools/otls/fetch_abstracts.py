#!/usr/bin/env python3
"""
Fetch and normalize Original Texas Land Survey abstract parcels for a county
from the UT BEG public OTLS ArcGIS service, producing the two static assets the
map consumes:

  client/public/data/{key}-abstracts.geojson    (polygons + id/county/abstract/survey/area)
  client/public/data/{key}-abstracts-index.json  (search index, no geometry)

Source: maps.texnet.beg.utexas.edu/arcgis/rest/services/otls/MapServer/0
Field ABSTRACT_N = zero-padded 3-digit county FIPS + abstract number, so
`ABSTRACT_N LIKE '<fips>%'` isolates exactly one county's abstracts. LEVEL1_SUR
is the survey name; ABSTRACT_L is the label (e.g. "A-653").

Usage:
  python3 tools/otls/fetch_abstracts.py <key> "<County Name>" <fips3> [out_dir]
  e.g. python3 tools/otls/fetch_abstracts.py anderson "Anderson" 001 ~/rrc-data/otls
  (out_dir defaults to client/public/data; use ~/rrc-data/otls to keep bulk
  output outside the iCloud-synced repo)

Matches the format of the hand-verified Leon/Freestone assets (coords rounded to
6 dp; id = "TX-" + ABSTRACT_N).
"""
import json, math, sys, urllib.parse, urllib.request, time, os

SERVICE = "https://maps.texnet.beg.utexas.edu/arcgis/rest/services/otls/MapServer/0/query"
PAGE = 2000
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "client", "public", "data")


def fetch_page(fips: str, offset: int):
    params = {
        "where": f"ABSTRACT_N LIKE '{fips}%'",
        "outFields": "ABSTRACT_N,ABSTRACT_L,LEVEL1_SUR",
        "returnGeometry": "true",
        "outSR": "4326",
        "orderByFields": "ABSTRACT_N",
        "resultRecordCount": str(PAGE),
        "resultOffset": str(offset),
        "f": "geojson",
    }
    url = f"{SERVICE}?{urllib.parse.urlencode(params)}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 — transient network; retry
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    return None


def ring_area_m2(ring):
    """Planar area (m^2) via equirectangular projection at the ring's mean lat.
    Only used as a monotonic label-priority sort key, so approximation is fine."""
    if len(ring) < 4:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    k = math.cos(math.radians(lat0))
    s = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0] * 111320.0 * k, ring[i][1] * 110540.0
        x2, y2 = ring[i + 1][0] * 111320.0 * k, ring[i + 1][1] * 110540.0
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def geom_area_m2(geom):
    t = geom["type"]
    if t == "Polygon":
        rings = geom["coordinates"]
        return ring_area_m2(rings[0]) - sum(ring_area_m2(r) for r in rings[1:])
    if t == "MultiPolygon":
        tot = 0.0
        for poly in geom["coordinates"]:
            tot += ring_area_m2(poly[0]) - sum(ring_area_m2(r) for r in poly[1:])
        return tot
    return 0.0


def round_coords(node):
    if isinstance(node, list):
        if node and isinstance(node[0], (int, float)):
            return [round(node[0], 6), round(node[1], 6)]
        return [round_coords(c) for c in node]
    return node


def main():
    if len(sys.argv) not in (4, 5):
        print(__doc__)
        sys.exit(1)
    key, name, fips = sys.argv[1], sys.argv[2], sys.argv[3]
    out_dir = os.path.expanduser(sys.argv[4]) if len(sys.argv) == 5 else OUT_DIR
    assert len(fips) == 3 and fips.isdigit(), "fips must be a 3-digit string"

    features, index, seen = [], [], set()
    offset = 0
    while True:
        fc = fetch_page(fips, offset)
        rows = fc.get("features", [])
        if not rows:
            break
        for f in rows:
            an = str(f["properties"].get("ABSTRACT_N", "")).strip()
            if not an or not f.get("geometry"):
                continue
            fid = f"TX-{an}"
            if fid in seen:
                continue
            seen.add(fid)
            survey = (f["properties"].get("LEVEL1_SUR") or "").strip() or None
            abstract = (f["properties"].get("ABSTRACT_L") or "").strip() or None
            geom = f["geometry"]
            geom["coordinates"] = round_coords(geom["coordinates"])
            props = {
                "id": fid, "county": name, "countyFips": fips,
                "abstract": abstract, "survey": survey,
                "area": round(geom_area_m2(geom), 2),
            }
            features.append({"type": "Feature", "properties": props, "geometry": geom})
            index.append({"id": fid, "abstract": abstract, "survey": survey, "county": name, "countyFips": fips})
        if not fc.get("exceededTransferLimit") and len(rows) < PAGE:
            break
        offset += len(rows)
        print(f"  …{key}: {len(features)} fetched", flush=True)

    def absnum(a):
        try:
            return int((a or "A-0").split("-")[-1])
        except ValueError:
            return 0
    index.sort(key=lambda r: absnum(r["abstract"]))

    os.makedirs(out_dir, exist_ok=True)
    gj_path = os.path.join(out_dir, f"{key}-abstracts.geojson")
    idx_path = os.path.join(out_dir, f"{key}-abstracts-index.json")
    with open(gj_path, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh, separators=(",", ":"))
    with open(idx_path, "w") as fh:
        json.dump(index, fh, separators=(",", ":"))

    # Validation summary.
    bad_fips = sum(1 for f in features if f["properties"]["countyFips"] != fips)
    with_survey = sum(1 for f in features if f["properties"]["survey"])
    print(f"{key} ({name}, {fips}): {len(features)} abstracts, {with_survey} with survey, "
          f"{bad_fips} wrong-county → {os.path.basename(gj_path)} / {os.path.basename(idx_path)}")


if __name__ == "__main__":
    main()
