"""Independent placement check by survey NAMES: a plat labels the surveys it shows ("D. Frisman Survey,
A-267"). Through a correct placement each label lands inside RRC's polygon for that abstract number
(any county the layer covers); through a wrong one the labels land in other surveys.

A label near a survey line can sit just across it, so "consistent" allows 300 ft. A label whose
abstract number is nowhere within 25,000 ft (a sheet's reach) is a misread or another county's
survey (the same number repeats per county) and is not counted.
"""
import os, re, json, gzip
import numpy as np
from shapely.geometry import Polygon, MultiPolygon, Point
from shapely.prepared import prep
import datum

LABEL = re.compile(r"\bA\s*[-–—.]\s*(\d{1,4})\b")
NEAR_FT = 300.0
FAR_FT = 25000.0
_SHIFT = None


def load_abstracts(gz):
    """{abstract number: [(geometry in NAD83 lon/lat, prepared), ...]} over every county in the layer."""
    out = {}
    for ab in json.load(gzip.open(gz))["abstracts"]:
        m = re.match(r"A-(\d+)$", ab.get("abstract") or "")
        if not m: continue
        polys = [Polygon(p[0], p[1:]) for p in ab["geom"] if len(p[0]) >= 4]
        if not polys: continue
        g = MultiPolygon(polys).buffer(0)
        key = int(m.group(1))  # the number alone: units straddle county lines
        out.setdefault(key, []).append((g, prep(g)))
    return out


def plat_labels(ocr):
    """[(abstract number, (cx, cy) px)] from the plat's text."""
    out = []
    for l in ocr["lines"]:
        for m in LABEL.finditer(l["text"].upper()):
            x, y, w, h = l["box"]; out.append((int(m.group(1)), (x + w / 2, y + h / 2)))
    return out


def check(transform, ocr, abstracts, shift=None):
    """(counted, consistent, details) for the plat's abstract labels through `transform` (px -> NAD27 SP)."""
    global _SHIFT
    if shift is None:
        if _SHIFT is None: _SHIFT = datum.default_shift()
        shift = _SHIFT
    a, b, tx, ty = transform
    tested = consistent = 0; details = []
    deg_per_ft = 1 / 364000.0  # ~ft -> degrees of latitude; fine for a 300-ft tolerance
    for num, (cx, cy) in plat_labels(ocr):
        gs = abstracts.get(num)
        if not gs: continue
        X, Y = a * cx - b * (-cy) + tx, b * cx + a * (-cy) + ty
        lon, lat = datum.sp27_to_lonlat83(np.array([[X, Y]]), shift)[0]
        p = Point(lon, lat)
        d_ft = min(0.0 if pg.contains(p) else g.distance(p) / deg_per_ft for g, pg in gs)
        if d_ft > FAR_FT: continue
        tested += 1; ok = d_ft <= NEAR_FT; consistent += ok
        details.append({"abstract": num, "offFt": round(d_ft)})
    return tested, consistent, details


def labels_ok(counted, consistent):
    """No contradiction: no countable label, or at least half land in their own survey."""
    return counted == 0 or consistent >= 0.5 * counted
