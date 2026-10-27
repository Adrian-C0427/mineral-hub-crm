"""Build server/data/gis/tx-geo-regions.json.gz: Texas basins (EPA/AAPG GHGRP tessellation), Permian
sub-basins (EIA 2017), Marfa (EIA 2024), EIA 2024 basins as an independent reference layer, and
play outlines (EIA 2021 shale plays + USGS assessment units dissolved per formation), with
county-level overlap shares computed against the app's county polygons.
Usage: python -I build_geo_regions.py <dl_root> <tx-counties.geojson> <out.json.gz>
"""
import sys, json, gzip, re, datetime, shapefile
from shapely.geometry import shape, box, mapping, MultiPolygon, Polygon
from shapely.ops import unary_union
from shapely.validation import make_valid

DL, COUNTIES, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
CLIP = box(-107.0, 25.6, -93.3, 36.7)          # Texas + the app's Louisiana parishes
BASIN_TOL, PLAY_TOL, MIN_SHARE = 0.002, 0.001, 0.02

def fix(g):
    g = make_valid(g) if not g.is_valid else g
    g = g.intersection(CLIP)
    if g.geom_type == "GeometryCollection":
        g = unary_union([p for p in g.geoms if p.geom_type in ("Polygon", "MultiPolygon")])
    return g

def as_multi(g):
    if g.geom_type == "Polygon": g = MultiPolygon([g])
    if g.geom_type != "MultiPolygon": raise SystemExit(f"unexpected geometry {g.geom_type}")
    return g

def geojson(g, tol):
    s = as_multi(fix(g.simplify(tol, preserve_topology=True)))
    s = as_multi(MultiPolygon([p for p in s.geoms if p.area > 1e-6]))
    return json.loads(json.dumps(mapping(s)), parse_float=lambda x: round(float(x), 5))

def shp(path):
    r = shapefile.Reader(path); flds = [f[0] for f in r.fields[1:]]
    for sr in r.shapeRecords():
        yield dict(zip(flds, sr.record)), fix(shape(sr.shape.__geo_interface__))

def slug(s): return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

counties = {}
for f in json.load(open(COUNTIES))["features"]:
    counties[f["properties"]["fips"]] = (f["properties"]["name"], fix(shape(f["geometry"])))
texas = unary_union([g for _, g in counties.values()])

regions = []  # dicts with shapely geom under "_g"
def add(id, name, kind, geom, sources, parent=None, formation=None, tol=BASIN_TOL, note=None):
    if geom.is_empty or not geom.intersects(texas): return None
    r = {"id": id, "name": name, "kind": kind, "parent": parent, "formation": formation, "sources": sources, "_g": geom, "_tol": tol}
    if note: r["note"] = note
    regions.append(r); return r

# --- 1. Primary basins: EPA/AAPG GHGRP (a tessellation — every point has exactly one basin)
EPA_NAMES = {"430": "Permian Basin", "220": "Gulf Coast Basin", "260": "East Texas Basin", "435": "Palo Duro Basin",
             "400": "Ouachita Fold Belt", "425": "Bend Arch", "360": "Anadarko Basin", "410": "Llano Uplift", "415": "Strawn Basin",
             "420": "Fort Worth Basin", "405": "Kerr Basin", "350": "North Texas (Muenster Arch)", "465": "Orogrande Basin", "230": "Ark-La-Tex"}
for rec, g in shp(f"{DL}/epa-basins/Basins_GHGRP.shp"):
    code = rec["BASIN_CODE"]
    if code not in EPA_NAMES: continue
    share = g.intersection(texas).area / texas.area
    if share < 0.00005: continue
    add(f"basin:{slug(EPA_NAMES[code])}", EPA_NAMES[code], "basin", g, [{"id": "epa-aapg", "code": code, "label": rec["BASIN_NAME"]}])

# --- 2. Reference basins: EIA 2024 (independent second opinion for confidence; not a display layer)
EIA_NAMES = {"ANADARKO": "Anadarko Basin", "PALO DURO": "Palo Duro Basin", "PERMIAN": "Permian Basin", "FORT WORTH": "Fort Worth Basin",
             "WESTERN GULF": "Gulf Coast Basin", "TX-LA-MS SALT": "East Texas Basin", "MARFA": "Marfa Basin"}
eia = json.load(open(f"{DL}/eia-basins/basins.geojson"))
for f in eia["features"]:
    n = f["properties"]["Name"]
    if n not in EIA_NAMES: continue
    g = fix(shape(f["geometry"]))
    if n == "MARFA":
        add("subbasin:marfa-basin", "Marfa Basin", "subbasin", g, [{"id": "eia-basins", "code": n, "label": "Marfa"}])
    else:
        add(f"ref:{slug(n)}", EIA_NAMES[n], "reference", g, [{"id": "eia-basins", "code": n, "label": n}])

# --- 3. Permian sub-basins (EIA 2017)
for rec, g in shp(f"{DL}/eia-permian/Permian_SubBasins_201712.shp"):
    add(f"subbasin:{slug(rec['Name'])}", rec["Name"], "subbasin", g, [{"id": "eia-permian", "code": rec["Name"], "label": rec["Name"]}], parent="basin:permian-basin")

# --- 4. Plays: dissolve per formation
plays = {}  # formation -> {"geoms": [], "sources": [], "basin": }
def play(formation, geom, source, basin):
    p = plays.setdefault(formation, {"geoms": [], "sources": [], "basin": basin})
    p["geoms"].append(geom); p["sources"].append(source)
EIA_PLAYS = {  # Shale_play -> [(formation, basin)]
    "Barnett": [("Barnett", "basin:fort-worth-basin")], "Haynesville-Bossier": [("Haynesville", "basin:east-texas-basin"), ("Bossier", "basin:east-texas-basin")],
    "Eagle Ford": [("Eagle Ford", "basin:gulf-coast-basin")], "Bend": [("Bend Shale", "basin:palo-duro-basin")],
    "Abo-Yeso": [("Abo", "basin:permian-basin"), ("Yeso", "basin:permian-basin")], "Glorieta-Yeso": [("Glorieta", "basin:permian-basin"), ("Yeso", "basin:permian-basin")],
    "Bone Spring": [("Bone Spring", "basin:permian-basin")], "Delaware": [("Delaware", "basin:permian-basin")],
    "Wolfcamp": [("Wolfcamp", "basin:permian-basin")], "Wolfcamp - Midland": [("Wolfcamp", "basin:permian-basin")], "Spraberry": [("Spraberry", "basin:permian-basin")],
    "Tuscaloosa": [("Tuscaloosa", "basin:gulf-coast-basin")], "Woodford": [("Woodford", "basin:anadarko-basin")],
}
for rec, g in shp(f"{DL}/eia-plays/ShalePlays_US_EIA_Dec2021.shp"):
    for formation, basin in EIA_PLAYS.get(rec["Shale_play"], []):
        if g.is_empty or not g.intersects(texas): continue
        play(formation, g, {"id": "eia-plays", "code": rec["ID"], "label": rec["Shale_play"]}, basin)
def usgs(file, rule, basin, code):
    d = json.load(open(f"{DL}/{file}"))
    for f in d["features"]:
        p = f["properties"]; name = (p.get("ASSESSNAME") or "").replace("\r\n", " ").strip()
        formation = rule(name)
        if not formation: continue
        g = fix(shape(f["geometry"]))
        if g.is_empty or not g.intersects(texas): continue
        play(formation, g, {"id": code, "code": str(p.get("ASSESSCODE") or ""), "label": name.split("  ")[0]}, basin)
def delaware_rule(n):
    if "Bone Spring" in n: return "Bone Spring"
    if "Avalon" in n: return "Avalon"
    if "Wolfcamp" in n: return "Wolfcamp"
usgs("usgs-delaware/DelawareBasinAUs.geojson", delaware_rule, "basin:permian-basin", "usgs-delaware-2018")
usgs("usgs-midland/MidlandBasinWolfcampAUs.geojson", lambda n: "Wolfcamp" if "Wolfcamp" in n else None, "basin:permian-basin", "usgs-midland-2016")
usgs("usgs-eagleford/EagleFordAUs.geojson", lambda n: "Eagle Ford", "basin:gulf-coast-basin", "usgs-eagle-ford-2018")
usgs("usgs-austinchalk/AustinChalkAUs.geojson", lambda n: "Austin Chalk", "basin:gulf-coast-basin", "usgs-austin-chalk-2018")
for formation, p in plays.items():
    g = fix(unary_union(p["geoms"]))
    seen, srcs = set(), []
    for s in p["sources"]:
        k = (s["id"], s["label"])
        if k not in seen: seen.add(k); srcs.append(s)
    add(f"play:{slug(formation)}", f"{formation} play", "play", g, srcs, parent=p["basin"], formation=formation, tol=PLAY_TOL)

# parent of Marfa = the EPA basin it mostly lies in
for r in regions:
    if r["kind"] == "subbasin" and not r["parent"]:
        best = max((b for b in regions if b["kind"] == "basin"), key=lambda b: b["_g"].intersection(r["_g"]).area)
        r["parent"] = best["id"]

# --- 5. County shares (Texas counties)
county_regions = []
for fips, (name, cg) in counties.items():
    for r in regions:
        if r["kind"] == "reference" or not cg.intersects(r["_g"]): continue
        share = cg.intersection(r["_g"]).area / cg.area
        if share >= MIN_SHARE: county_regions.append({"fips": fips, "regionId": r["id"], "share": round(share, 3)})

out = {
    "key": "tx-geo-regions", "builtAt": datetime.date.today().isoformat(),
    "sources": [
        {"id": "epa-aapg", "name": "EPA GHGRP basin boundaries (AAPG CSD geologic provinces)", "asOf": "2023", "license": "US Government work / CC0"},
        {"id": "eia-basins", "name": "EIA Sedimentary basins of the United States (2024)", "asOf": "2024", "license": "US Government work"},
        {"id": "eia-permian", "name": "EIA Permian Basin sub-basins (2017)", "asOf": "2017-12", "license": "US Government work"},
        {"id": "eia-plays", "name": "EIA Shale plays of the lower 48 states (Dec 2021)", "asOf": "2021-12", "license": "US Government work"},
        {"id": "usgs-delaware-2018", "name": "USGS Delaware Basin Wolfcamp/Bone Spring assessment units (2018)", "asOf": "2018", "license": "US Government work"},
        {"id": "usgs-midland-2016", "name": "USGS Midland Basin Wolfcamp assessment units (2016)", "asOf": "2016", "license": "US Government work"},
        {"id": "usgs-eagle-ford-2018", "name": "USGS Eagle Ford Group assessment units (2018)", "asOf": "2018", "license": "US Government work"},
        {"id": "usgs-austin-chalk-2018", "name": "USGS Austin Chalk assessment units (2018)", "asOf": "2018", "license": "US Government work"},
    ],
    "uncovered": {
        "basins": ["Dalhart Basin", "Hardeman Basin", "Maverick Basin", "Northwest Shelf", "Eastern Shelf", "Sabine Uplift", "Rio Grande Embayment", "Burgos Basin", "San Marcos Arch", "Marathon Fold Belt"],
        "note": "No free public polygon exists for these; they stay available as manual picks.",
    },
    "regions": [{k: v for k, v in r.items() if not k.startswith("_")} | {"geom": geojson(r["_g"], r["_tol"])} for r in regions],
    "countyRegions": county_regions,
    "counties": [{"fips": fips, "name": name} for fips, (name, _) in sorted(counties.items(), key=lambda kv: kv[1][0])],
}
raw = json.dumps(out, separators=(",", ":")).encode()
with gzip.open(OUT, "wb", compresslevel=9) as f: f.write(raw)
print(f"regions {len(regions)}  countyRegions {len(county_regions)}  raw {len(raw)/1e6:.2f} MB  gz {__import__('os').path.getsize(OUT)/1e3:.0f} KB")
for r in regions: print(f"  {r['kind']:9s} {r['id']:36s} parent={r['parent'] or '-':28s} vertices={sum(len(p.exterior.coords) for p in as_multi(fix(r['_g'].simplify(r['_tol'], True))).geoms)}")
