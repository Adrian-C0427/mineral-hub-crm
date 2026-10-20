"""Stage 4: QA gate, de-duplicate, convert to NAD83 and write the Mineral Hub bundle + report.

A unit is published only if:
  * its well-location plat was placed from three surveyed points, worst residual <= 25 ft, confirmed by
    RRC's survey lines (older scanned plats: one printed point + a strict survey-line match);
  * unit-plat outlines: the traced outline lines up with the well plat (label inside, >= 60% of the
    in-frame edge within ~10 ft or a sharp partial fit, >= 30% of the edge in frame), AND RRC's survey
    lines fall on the unit plat's own survey lines at that placement (sharpness >= 1.15; >= 1.10 with a
    >= 60% fit at an expected orientation) unless the outline sits on the well plat's drawing almost
    everywhere (>= 75% within ~10 ft). A name label outside the outline (a callout) is accepted only
    when that check is decisive (>= 1.6); and the unit plat's survey names (e.g. "A-267") land in their
    own RRC surveys (at least half of those that can be checked);
  * well-plat outlines: closed on the sheet (not cut off by the frame);
  * area within 2.5% of the called acres, or within 15% when the trace is verified complete
    (published with a drawn-vs-called note). Older scanned plats: 2.5%, no allowance, and the well's
    drawn surface location inside the outline.
"""
import sys, os, re, json, gzip, math, datetime, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from shapely.geometry import Polygon, mapping
from shapely.validation import make_valid
import datum

U = os.path.expanduser("~/rrc-data/unit-plats")
MAX_AREA_PCT = 2.5
MAX_DRAWN_PCT = 15.0      # drawn-vs-called differences up to this are published with a note
MIN_COMPLETE = 0.95
MIN_WITHIN10 = 0.60       # ... or a sharp partial fit:
MIN_FIT_SHARP = 1.6       # outline fits >= 1.6x better than the same outline nudged 150 ft / turned 2 deg
MIN_FIT = 0.20
MIN_IN_FRAME = 0.30
MAX_CONTROL_FT = 25.0
UNIT_SURVEY_SHARP = 1.15  # registration check on the unit plat's own survey lines (stage3 unit_survey)
STRONG_WITHIN10 = 0.75


def norm_name(n):
    n = (n or "").lower().replace("unt", "unit")
    n = re.sub(r"\b(gas|pooled|deep|the|called)\b", " ", n)
    n = re.sub(r"\bunit\b", " ", n)
    return re.sub(r"[^a-z0-9]+", " ", n).strip()


def title(n):
    n = re.sub(r"\s+", " ", (n or "").strip())
    n = re.sub(r"\bUNT\b", "Unit", n, flags=re.I)
    n = re.sub(r"\b(Unit)( Unit)+\b", r"\1", n, flags=re.I)
    def w(x):
        if "." in x.strip('"') or (x.isupper() and len(x.strip('"')) <= 2): return x.upper()
        return x[:1].upper() + x[1:].lower() if x[:1] != '"' else '"' + x[1:2].upper() + x[2:].lower()
    return " ".join(w(x) for x in n.split(" "))


def clean_ocr_name(n):
    """Fold accents a misread can add (À, ö); None when stray symbols remain (*, ®): use the file name."""
    import unicodedata
    f = unicodedata.normalize("NFKD", n or "").encode("ascii", "ignore").decode()
    return f if re.fullmatch(r"[A-Za-z0-9 .,'\"&()#/-]+", f.strip()) else None


def unit_survey_agrees(sharp, within10, orient_dev):  # same rule as stage3_units.unit_survey_agrees
    return sharp >= UNIT_SURVEY_SHARP or within10 >= STRONG_WITHIN10 or (sharp >= 1.10 and within10 >= 0.60 and orient_dev <= 15)


def passes(c):
    why = []
    if c.get("controlResidualFt", 99) > MAX_CONTROL_FT: why.append(f"well plat placement off by {c['controlResidualFt']:.0f} ft")
    if c["kind"] == "unit-plat":
        dev = min(abs((c.get("rotationDeg", 0) + 180) % 360 - 180), abs((c.get("rotationDeg", 0) - c.get("wlRotationDeg", 0) + 180) % 360 - 180))
        # a label printed in a callout outside the unit (with a leader) is fine when the unit plat's own
        # survey lines confirm the placement decisively
        if c.get("labelInside") is False and not (c.get("unitSurveySharpness", 0) >= 1.6 and c.get("within10ft", 0) >= 0.5 and dev <= 15):
            why.append("unit's name label falls outside the lined-up outline")
        if c.get("inFrame", 0) < MIN_IN_FRAME: why.append(f"only {c['inFrame']:.0%} of the unit lies on the well plat")
        elif c.get("within10ft", 0) < MIN_WITHIN10 and not (c.get("fitSharpness", 0) >= MIN_FIT_SHARP and c.get("fit", 0) >= MIN_FIT):
            why.append(f"outline doesn't line up decisively with the well plat (fit {c.get('fit', 0):.0%}, sharpness {c.get('fitSharpness', 0):.2f})")
        if not unit_survey_agrees(c.get("unitSurveySharpness", 0), c.get("within10ft", 0), dev):
            why.append(f"at this placement RRC's survey lines miss the unit plat's own ({c.get('unitSurveyMatch', 0):.0%}, sharpness {c.get('unitSurveySharpness', 0):.2f})")
        n_lab, ok_lab = c.get("surveyNamesCounted", 0), c.get("surveyNamesConsistent", 0)
        if n_lab and ok_lab < 0.5 * n_lab:
            why.append(f"at this placement the unit plat's survey names land in other surveys ({ok_lab} of {n_lab} in their own)")
        t = abs(c.get("tracedDiffPct", 99))
        if t > MAX_AREA_PCT and not (t <= MAX_DRAWN_PCT and c.get("completeness", 0) >= MIN_COMPLETE): why.append(f"traced area {c['tracedDiffPct']:+.1f}% from called acres")
    elif c.get("clipped"):
        why.append("outline runs off the well plat's sheet")
    if c["kind"] == "old-plat":
        if c.get("wellInsideFt", -1e9) < -100: why.append("the well's drawn surface location is outside this outline")
        n_lab, ok_lab = c.get("surveyNamesCounted", 0), c.get("surveyNamesConsistent", 0)
        if n_lab and ok_lab < 0.5 * n_lab: why.append(f"the plat's survey names land in other surveys ({ok_lab} of {n_lab} in their own)")
        if abs(c.get("mappedDiffPct", 99)) > MAX_AREA_PCT: why.append(f"mapped area {c.get('mappedDiffPct', 0):+.1f}% from the W-1 unit acres")
        return why
    # Acreage: within 2.5% of the called acres, or -- when the trace is verified complete (it accounts for
    # >= 95% of the unit's own boundary marking) -- within 15%, published with both figures shown, since
    # the plat's drawing itself differs from the acres written on it.
    d = abs(c.get("mappedDiffPct", 99)); comp = c.get("completeness", 0)
    if d > MAX_AREA_PCT and not (d <= MAX_DRAWN_PCT and comp >= MIN_COMPLETE):
        why.append(f"mapped area {c.get('mappedDiffPct', 0):+.1f}% from called acres" + (f" (trace accounts for {comp:.0%} of the unit's marking)" if d <= MAX_DRAWN_PCT else ""))
    return why


def main(wells_bundle, out_bundle, report_dir):
    sp = json.load(open(f"{U}/work/units_sp.json"))
    manifest = {m["newName"]: m for m in json.load(open(f"{U}/plats-manifest.json"))}
    W = {w["api8"]: w for w in json.load(gzip.open(wells_bundle))["wells"] if w["api8"]}
    shift = datum.default_shift()
    scan = {r["id"]: r for r in json.load(open(f"{U}/work/scan.json"))}
    old_place = json.load(open(f"{U}/work/old_place.json")) if os.path.exists(f"{U}/work/old_place.json") else {}
    for pid, g in old_place.items():  # older scanned plats placed by survey lines (old_plats.py)
        if g.get("ok") and pid in scan: scan[pid]["georef"] = dict(g, oldPlat=True)
    vec = json.load(open(f"{U}/work/units_sp_vector.json")) if os.path.exists(f"{U}/work/units_sp_vector.json") else []
    for c in vec:  # Mitsui plats don't name the unit: it is the well's unit
        w = W.get(c["api"], {})
        c["name"] = f"{title(w.get('leaseName') or 'Unit')} {w.get('wellNo') or ''} Unit".replace("  ", " ")
    old = sp.get("oldPlatUnits", [])
    for c in old:  # older plats: the unit is the well's (W-1) unit
        w = W.get(c["api"], {}); n = title(w.get("leaseName") or "Unit")
        c["name"] = n if re.search(r"\bunit\b", n, re.I) else f"{n} Unit"
    cands = [c for c in sp["unitPlats"] + sp["wellPlatUnits"] + vec + old if "fail" not in c and c.get("calledAcres")]
    import cv2
    from fit_sharpness import FitScorer
    for c in cands:  # how decisively each lined-up unit plat sits on its well plat
        if c["kind"] != "unit-plat": continue
        sc = FitScorer(cv2.imread(f"{U}/work/img/{c['wlPlat']}.png"), scan[c["wlPlat"]]["georef"]["transform"])
        c["fit"], c["fitSharpness"] = sc.sharpness(c["sp"])
    def from_file(fname):
        n = manifest.get(fname, {}).get("origName") or fname
        n = re.sub(r"\.(pdf|tif|tiff)$", "", n, flags=re.I)
        n = re.sub(r"^\d+[_ ]", "", n)
        n = re.sub(r"(pooled|pooed)?[_ ]*unit[_ ]*plat.*$|[_ ]plat.*$|[_ ](rev(ised)?|final|rrc version).*$", " Unit", n, flags=re.I)
        return re.sub(r"[_ ]+", " ", n).strip()
    for c in cands:
        if c["kind"] != "unit-plat": continue
        cleaned = clean_ocr_name(c["name"])
        if cleaned is None or len(norm_name(cleaned).split()) < 1:
            alt = from_file(c["file"])
            if norm_name(alt): c["name"] = alt
        else:
            c["name"] = cleaned
    for c in cands:  # the placement each outline was drawn from (for the visual QA overlay)
        wl = c.get("wlPlat") or c["plat"]
        c["_transform"] = (c.get("georef") or {}).get("transform") or (scan.get(wl, {}).get("georef") or {}).get("transform")
    fails = [c for c in sp["unitPlats"] if "fail" in c]
    by = collections.defaultdict(list)
    for c in cands: by[(norm_name(c["name"]), round(float(c["calledAcres"]), 1))].append(c)
    units, rejected, sp_polys = [], [], []
    for key, cs in sorted(by.items()):
        ok = [c for c in cs if not passes(c)]
        wells = {}
        for c in cs:
            w = W.get(c["api"], {})
            wells[(c["api"], c["permit"])] = {"api": c["api"], "lease": w.get("leaseName"), "wellNo": w.get("wellNo"), "permit": c["permit"]}
        if not ok:
            rejected.append({"unit": title(cs[0]["name"]), "calledAcres": cs[0]["calledAcres"], "wells": sorted({f"{v['lease']} {v['wellNo']}" for v in wells.values()}), "why": sorted({w for c in cs for w in passes(c)}),
                             "plats": sorted({c["file"] for c in cs})})
            continue
        best = sorted(ok, key=lambda c: (c["kind"] != "unit-plat", c["kind"] == "old-plat", -(c.get("fitSharpness") or 0), abs(c["mappedDiffPct"])))[0]
        poly = make_valid(Polygon(best["sp"]))
        if poly.geom_type != "Polygon": poly = max(getattr(poly, "geoms", [poly]), key=lambda g: g.area)
        poly = poly.buffer(0)
        if poly.geom_type != "Polygon": poly = max(getattr(poly, "geoms", [poly]), key=lambda g: g.area)
        inset = poly.buffer(-best.get("halfWidthFt", 0.0), join_style=2)
        if inset.geom_type != "Polygon": inset = max(getattr(inset, "geoms", [inset]), key=lambda g: g.area) if not inset.is_empty else inset
        poly = (inset if not inset.is_empty else poly).simplify(4.0, preserve_topology=True)
        if poly.is_empty or poly.geom_type != "Polygon": rejected.append({"unit": title(best["name"]), "calledAcres": best["calledAcres"], "why": ["outline collapsed when cleaned"]}); continue
        acres = poly.area / 43560
        sp_polys.append(poly)
        rings = [datum.sp27_to_lonlat83(np.array(poly.exterior.coords), shift)] + [datum.sp27_to_lonlat83(np.array(r.coords), shift) for r in poly.interiors]
        api0 = best["api"]; w0 = W.get(api0, {})
        op = "Mitsui" if "MITSUI" in (w0.get("operator") or "").upper() else "Comstock"
        man = manifest.get(best["file"], {})
        units.append({
            "id": f"TX-UNIT-{re.sub(r'[^a-z0-9]+', '-', norm_name(best['name'])).strip('-')}-{best['calledAcres']}",
            "name": title(best["name"]), "operator": op, "county": w0.get("county") or "",
            "calledAcres": float(best["calledAcres"]), "mappedAcres": round(acres, 2),
            "wells": sorted(wells.values(), key=lambda v: (v["lease"] or "", v["wellNo"] or "")),
            "plat": {"permit": best["permit"], "rrcId": man.get("id") or best["plat"], "url": man.get("url") or "", "file": man.get("origName") or best["file"]},
            "drawnVsCalledPct": round(100 * (acres - best["calledAcres"]) / best["calledAcres"], 1) if abs(100 * (acres - best["calledAcres"]) / best["calledAcres"]) > MAX_AREA_PCT else None,
            "placement": {"method": "well-plat" if best["kind"] == "old-plat" else best["kind"], "basis": "survey-lines" if best["kind"] == "old-plat" else "well-points",
                          "controlResidualFt": round(best["controlResidualFt"], 2), "within10ftPct": round(100 * best["within10ft"], 1) if best["kind"] == "unit-plat" else None},
            "_fit": {"fit": best.get("fit"), "fitSharpness": best.get("fitSharpness"), "within10ft": best.get("within10ft")},
            "rings": [[[round(x, 6), round(y, 6)] for x, y in r] for r in rings],
            "_qa": {"wlPlat": best.get("wlPlat") or best["plat"], "sourcePlat": best["plat"], "areaDiffPct": round(100 * (acres - best["calledAcres"]) / best["calledAcres"], 2),
                    "transform": best["_transform"], "spOuter": best["sp"], "halfWidthFt": best.get("halfWidthFt", 0.0)},
        })
    # The same unit drawn on several wells' plats (a slightly different call, a misread letter):
    # outlines overlapping >= 80% are one unit. Keep the best-checked copy; pool the wells.
    order_ = sorted(range(len(units)), key=lambda i: (units[i]["placement"]["method"] != "unit-plat", -((units[i]["_fit"] or {}).get("fitSharpness") or 0), abs(units[i]["_qa"]["areaDiffPct"])))
    keep, merged_into = [], {}
    for i in order_:
        dup = next((j for j in keep if abs(units[i]["calledAcres"] - units[j]["calledAcres"]) <= 0.02 * units[j]["calledAcres"]
                    and sp_polys[i].intersection(sp_polys[j]).area / sp_polys[i].union(sp_polys[j]).area >= 0.8), None)
        if dup is None: keep.append(i); continue
        merged_into[i] = dup
        have = {(w["api"], w["permit"]) for w in units[dup]["wells"]}
        units[dup]["wells"] += [w for w in units[i]["wells"] if (w["api"], w["permit"]) not in have]
        units[dup].setdefault("_alsoDrawnAs", []).append({"name": units[i]["name"], "calledAcres": units[i]["calledAcres"], "plat": units[i]["plat"]["file"]})
    units = [units[i] for i in sorted(keep)]
    for u in units: u["wells"].sort(key=lambda v: (v["lease"] or "", v["wellNo"] or ""))
    print(f"merged {len(merged_into)} duplicate drawings into the units they repeat")
    ds = {"key": "rrc-tx-pooled-units", "builtAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
          "source": {"name": "RRC drilling permit plats (W-1 attachments), Comstock + Mitsui wells, Leon/Freestone", "asOf": "2026-10-19"},
          "units": [{k: v for k, v in u.items() if not k.startswith("_")} for u in units]}
    os.makedirs(os.path.dirname(out_bundle), exist_ok=True)
    with gzip.open(out_bundle, "wt", compresslevel=9) as f: json.dump(ds, f, separators=(",", ":"))
    json.dump({"units": units, "rejected": rejected, "platFailures": [{k: f[k] for k in ("file", "fail")} for f in fails]}, open(f"{U}/work/bundle_qa.json", "w"), indent=1)
    covered = {w["api"] for u in units for w in u["wells"]}
    allw = {m["api"] for m in json.load(open(f"{U}/work/inventory.json"))}
    print(f"published units: {len(units)} | rejected units: {len(rejected)} | unit plats that failed before QA: {len(fails)}")
    print(f"wells with at least one unit on the map: {len(covered)} of {len(allw)}")
    d = sorted(abs(u["_qa"]["areaDiffPct"]) for u in units)
    if d: print(f"area vs called acres: median {d[len(d)//2]:.2f}% | worst {d[-1]:.2f}%")
    return units, rejected, fails


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
