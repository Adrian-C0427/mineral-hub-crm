"""Stage 3: unit outlines -> State Plane polygons.

For each well (permit):
  * unit plats (one unit each, no coordinates): trace the hatched outline, check its
    area against the plat's "Called N Acres", then line it up against the well's
    placed well-location plat (rotation + translation, scale held to the stated scale).
  * placed well-location plats: closed colored outlines with a "Called N Acres" label
    inside are taken directly (used when a unit has no plat of its own).
Writes work/units_sp.json: every candidate polygon (NAD27 Texas Central, US ft) with its QA.
"""
import sys, os, json, gzip, math, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from concurrent.futures import ProcessPoolExecutor
import numpy as np, cv2
import parse
from outline import color_masks
from outline3 import best_outline, region, trace_completeness
from register import register, xform
import survey_check as sv
import abstract_check as ac

U = os.path.expanduser("~/rrc-data/unit-plats")
INV = {m["id"]: m for m in json.load(open(f"{U}/work/inventory.json"))}
SCAN = {r["id"]: r for r in json.load(open(f"{U}/work/scan.json"))}
# older scanned plats placed from one printed point + RRC's survey lines (old_plats.py)
OLD = json.load(open(f"{U}/work/old_place.json")) if os.path.exists(f"{U}/work/old_place.json") else {}
for _pid, _g in OLD.items():
    if _g.get("ok") and _pid in SCAN: SCAN[_pid]["georef"] = dict(_g, oldPlat=True)
UNIT_SURVEY_SHARP = 1.15   # RRC's survey lines vs the unit plat's own drawing (see unit_survey)
STRONG_WITHIN10 = 0.75     # ... unless the outline sits on the well plat's drawing this closely
_SEG = None
_ABS = None


def _abs():
    global _ABS
    if _ABS is None: _ABS = ac.load_abstracts(f"{U}/work/tx-rrc-abstracts.json.gz")
    return _ABS


def unit_survey_agrees(sharp, within10, orient_dev):
    """The unit plat's own survey lines don't contradict the registration: decisive (>= 1.15), or the
    outline sits on the well plat's drawing almost everywhere (>= 75%), or a near-decisive score
    (>= 1.10) with a solid fit (>= 60%) at an expected orientation (within 15 deg of north-up or the
    well plat's frame). Flipped or shifted fits score ~0.9-1.07 here."""
    return sharp >= UNIT_SURVEY_SHARP or within10 >= STRONG_WITHIN10 or (sharp >= 1.10 and within10 >= 0.60 and orient_dev <= 15)


def _seg():
    global _SEG
    if _SEG is None: _SEG = sv.abstract_lines_sp(f"{U}/work/tx-rrc-abstracts.json.gz")
    return _SEG


def unit_survey(unit_img, params, c0, wl_transform):
    """Independent check of a registration: compose unit-plat px -> well-plat px -> State Plane and
    score RRC's survey lines against the survey lines the UNIT plat itself draws. A flipped or shifted
    registration of a near-symmetric outline sits on nothing there (sharpness ~1)."""
    th, s, tx, ty = params
    P = np.array([[0.0, 0.0], [1000.0, 0.0]])
    Z = px_to_sp(wl_transform, xform(P - np.array(c0), th, s, tx, ty))
    w = P[:, 0] - 1j * P[:, 1]; z = Z[:, 0] + 1j * Z[:, 1]
    k = (z[1] - z[0]) / (w[1] - w[0]); t = z[0] - k * w[0]
    tr = [k.real, k.imag, t.real, t.imag]
    s0, sharp, _ = sv.SurveyScorer(unit_img, *_seg()).peak(tr)
    return s0, sharp, tr
STOP = {"gas", "unit", "pooled", "called", "acres", "deep", "the", "unt", "plat", "revised", "rev", "final", "and"}


def name_tokens(name):
    return [t.lower() for t in re.findall(r"[A-Za-z]{3,}", name or "") if t.lower() not in STOP]


def px_to_sp(t, pts):
    a, b, tx, ty = t
    x, y = pts[:, 0], -pts[:, 1]
    return np.stack([a * x - b * y + tx, b * x + a * y + ty], 1)


def area_ac(poly_ft, halfw_ft=0.0):
    p = poly_ft.astype(np.float64)
    x, y = p[:, 0], p[:, 1]
    a = 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
    per = float(np.sum(np.hypot(np.diff(x, append=x[0]), np.diff(y, append=y[0]))))
    return (a - per * halfw_ft) / 43560.0


def good_wl(pid):
    g = SCAN[pid].get("georef") or {}
    return g.get("ok") and max(g["residualFt"].values()) <= 25


def unit_label(scan_row, outline_ac=None):
    """The unit plat's own name + called acres: prefer the entry whose acres best match the traced area."""
    us = scan_row["units"]
    if not us: return None, None
    if outline_ac:
        name, ac, _ = min(us, key=lambda u: abs(u[1] - outline_ac) / u[1])
    else:
        name, ac, _ = us[0]
    return name, ac


def label_on_wl(wl_scan, name):
    toks = name_tokens(name)
    for n, ac, pt in wl_scan["units"]:
        if toks and set(toks) <= set(name_tokens(n)): return pt, n, ac
    return None, None, None


def do_unit_plat(args):
    pid, wl_ids = args
    m = INV[pid]; sc = SCAN[pid]
    img = cv2.imread(f"{U}/work/img/{pid}.png")
    b = best_outline(img, min_px=int(20000 * (m["dpi"] / 300) ** 2))
    out = {"plat": pid, "file": m["file"], "api": m["api"], "permit": m["permit"], "kind": "unit-plat"}
    if not b:
        out["fail"] = "no closed colored outline on the unit plat"; return out
    area_px, color, r = b
    ftpx_nom = (sc["scale"] or 1000.0) / m["dpi"]
    per_px = cv2.arcLength(r["outer"].astype(np.float32), True)
    traced_ac = (area_px - per_px * r["halfWidthPx"]) * ftpx_nom ** 2 / 43560
    name, called = unit_label(sc, traced_ac)
    masks = color_masks(img)
    unit_ocr = json.load(open(f"{U}/work/ocr/{pid}.json"))
    comp = trace_completeness(img, r["outer"], masks[color], unit_ocr, m["dpi"]) if color in masks else 0.0
    out.update(name=name, calledAcres=called, tracedAcres=round(traced_ac, 2), color=color, statedScale=sc["scale"] or 1000.0, completeness=round(comp, 3))
    if not called:
        out["fail"] = "no 'Called N Acres' label on the unit plat"; return out
    out["tracedDiffPct"] = round(100 * (traced_ac - called) / called, 2)
    best = None
    for wid in wl_ids:
        wsc = SCAN[wid]; g = wsc["georef"]
        wl = cv2.imread(f"{U}/work/img/{wid}.png")
        s0 = ftpx_nom / g["ftPerPx"]
        lab, lab_name, lab_ac = label_on_wl(wsc, name)
        reg = register(img, wl, s0, lab)
        if not reg: continue
        regs = [reg]
        # Unit plats are drawn grid-north-up or in their well plat's frame (a few degrees off at most);
        # a fit far from both is often a near-symmetric outline sitting flipped, so try both expected ones.
        rot = math.degrees(reg["best"]["params"][0]) % 360
        dev = min(abs((rot + 180) % 360 - 180), abs((rot - g["rotationDeg"] + 180) % 360 - 180))
        if dev > 15:
            for c in (g["rotationDeg"] % 360, 0.0):
                alt = register(img, wl, s0, lab, rot_window=(c, 4))
                if alt: regs.append(alt)
        for rg in regs:
            rb = rg["best"]
            th_, s_, tx_, ty_ = rb["params"]
            if rb["inFrame"] < 0.9 or rb["within3px"] < 0.85: s_ = s0  # the scale the outline is published at (below)
            us0, ush, utr = unit_survey(img, [th_, s_, tx_, ty_], rg["c0"], g["transform"])
            # the unit plat's survey names ("A-267") must land in their own RRC surveys
            n_lab, ok_lab, _ = ac.check(utr, unit_ocr, _abs())
            rdev = min(abs((math.degrees(th_) % 360 + 180) % 360 - 180), abs((math.degrees(th_) - g["rotationDeg"] + 180) % 360 - 180))
            agrees = unit_survey_agrees(ush, rb["within3px"], rdev) and ac.labels_ok(n_lab, ok_lab)
            score = (agrees, rb["labelInside"] is not False, rb["within3px"] * min(1.0, rb["inFrame"] / 0.5))
            if best is None or score > best[0]: best = (score, wid, rg, lab_name, s0, g, us0, ush, len(regs), (ok_lab, n_lab))
    if not best:
        out["fail"] = "no placed well-location plat to line it up with"; return out
    _, wid, reg, lab_name, s0, g, us0, ush, n_orient, (ok_lab, n_lab) = best
    rb = reg["best"]
    th, s, tx, ty = rb["params"]
    # Partial overlap can't pin the scale: hold it to the plats' stated scales.
    if rb["inFrame"] < 0.9 or rb["within3px"] < 0.85: s = s0
    poly_wl = xform(reg["contour"] - np.array(reg["c0"]), th, s, tx, ty)
    sp = px_to_sp(g["transform"], poly_wl)
    hw_ft = reg["halfWidthPx"] * s * g["ftPerPx"]
    mapped = area_ac(sp, hw_ft)
    # inset the outline to the boundary line's centerline before simplifying
    out.update(wlPlat=wid, wlLabel=lab_name, labelInside=rb["labelInside"], inFrame=round(rb["inFrame"], 3), within10ft=round(rb["within3px"], 3),
               medianFt=round(rb["medianPx"] * g["ftPerPx"], 1), rotationDeg=round(math.degrees(th) % 360, 2), relScale=round(s / s0, 4),
               controlResidualFt=max(g["residualFt"].values()), mappedAcres=round(mapped, 2), mappedDiffPct=round(100 * (mapped - called) / called, 2),
               halfWidthFt=round(hw_ft, 2), unitSurveyMatch=round(us0, 3), unitSurveySharpness=round(ush, 2), orientationsTried=n_orient,
               surveyNamesConsistent=ok_lab, surveyNamesCounted=n_lab,
               wlRotationDeg=round(g["rotationDeg"], 2), sp=sp[:: max(1, len(sp) // 4000)].round(2).tolist())
    return out


UNIT_TOTAL = [r"TOTAL\s*(?:CALLED\s*)?ACRE(?:S|AGE)\s*(?:IN\s*UNIT)?\s*=\s*([\d,]+\.?\d*)",
              r"CALLED\s*([\d,]+\.?\d*)\s*AC\.?\s*UNIT", r"([\d,]+\.\d+)\s*AC\.?\s*UNIT"]


def plat_unit_totals(ocr):
    out = []
    for l in ocr["lines"]:
        t = l["text"].upper()
        for pat in UNIT_TOTAL:
            for m in re.finditer(pat, t):
                try: out.append(float(m.group(1).replace(",", "")))
                except ValueError: pass
    return out


def do_old_direct(args):
    """Older scanned plats (placed from one printed point + RRC's survey lines): the unit is the closed
    colored (usually red dashed) outline that contains the well's drawn surface location. Called acres:
    RRC's W-1 unit acres, cross-checked against the plat's own unit total when that text scans."""
    wid, w1_acres = args
    m = INV[wid]; sc = SCAN[wid]; g = sc["georef"]
    base = {"plat": wid, "file": m["file"], "api": m["api"], "permit": m["permit"], "kind": "old-plat"}
    if not w1_acres: return [dict(base, fail="no W-1 unit acreage to check the outline against")]
    img = cv2.imread(f"{U}/work/img/{wid}.png")
    ocr = json.load(open(f"{U}/work/ocr/{wid}.json"))
    totals = plat_unit_totals(ocr)
    confirmed = any(abs(t / w1_acres - 1) <= 0.005 for t in totals)
    shl_px = tuple(g["pixels"]["SHL"])
    n_lab, ok_lab, _ = ac.check(g["transform"], ocr, _abs())
    res = []
    for color, mask in color_masks(img).items():
        r = region(img, mask, min_px=int(20000 * (m["dpi"] / 300) ** 2))
        if not r: continue
        poly = r["outer"].astype(np.float32).reshape(-1, 1, 2)
        # the well sits in its unit (allow ~100 ft for a marker drawn on the boundary)
        inside = cv2.pointPolygonTest(poly, (float(shl_px[0]), float(shl_px[1])), True) * g["ftPerPx"]
        sp = px_to_sp(g["transform"], r["outer"].astype(np.float64))
        hw_ft = r["halfWidthPx"] * g["ftPerPx"]
        mapped = area_ac(sp, hw_ft)
        comp = trace_completeness(img, r["outer"], mask, ocr, m["dpi"])
        H, W = img.shape[:2]; xs, ys = r["outer"][:, 0], r["outer"][:, 1]
        clipped = bool(xs.min() <= 3 or ys.min() <= 3 or xs.max() >= W - 4 or ys.max() >= H - 4)
        res.append(dict(base, name=None, calledAcres=w1_acres, calledConfirmedOnPlat=confirmed, platTotals=totals[:6], color=color,
                        mappedAcres=round(mapped, 2), mappedDiffPct=round(100 * (mapped - w1_acres) / w1_acres, 2), clipped=clipped,
                        completeness=round(comp, 3), wellInsideFt=round(float(inside), 1), controlResidualFt=0.0,
                        surveyMatch=g.get("surveyMatch"), surveySharpness=g.get("surveySharpness"), halfWidthFt=round(hw_ft, 2),
                        surveyNamesConsistent=ok_lab, surveyNamesCounted=n_lab,
                        sp=sp[:: max(1, len(sp) // 4000)].round(2).tolist()))
    return res or [dict(base, fail="no closed colored outline on the plat")]


def do_wl_direct(wid):
    """Closed colored outlines on a placed well-location plat that carry their own 'Called N Acres' label."""
    m = INV[wid]; sc = SCAN[wid]; g = sc["georef"]
    img = cv2.imread(f"{U}/work/img/{wid}.png")
    res = []
    for color, mask in color_masks(img).items():
        r = region(img, mask, min_px=int(20000 * (m["dpi"] / 300) ** 2))
        if not r: continue
        poly = r["outer"].astype(np.float32)
        inside = [(n, ac) for n, ac, pt in sc["units"] if cv2.pointPolygonTest(poly.reshape(-1, 1, 2), (float(pt[0]), float(pt[1])), False) >= 0]
        if len(inside) != 1: continue
        name, called = inside[0]
        sp = px_to_sp(g["transform"], r["outer"].astype(np.float64))
        hw_ft = r["halfWidthPx"] * g["ftPerPx"]
        mapped = area_ac(sp, hw_ft)
        comp = trace_completeness(img, r["outer"], mask, json.load(open(f"{U}/work/ocr/{wid}.json")), m["dpi"])
        # touching the image frame means the plat cuts the unit off
        H, W = img.shape[:2]; xs, ys = r["outer"][:, 0], r["outer"][:, 1]
        clipped = bool(xs.min() <= 3 or ys.min() <= 3 or xs.max() >= W - 4 or ys.max() >= H - 4)
        res.append({"plat": wid, "file": m["file"], "api": m["api"], "permit": m["permit"], "kind": "well-plat", "name": name, "calledAcres": called, "color": color,
                    "mappedAcres": round(mapped, 2), "mappedDiffPct": round(100 * (mapped - called) / called, 2), "clipped": clipped, "completeness": round(comp, 3),
                    "controlResidualFt": max(g["residualFt"].values()), "halfWidthFt": round(hw_ft, 2), "sp": sp[:: max(1, len(sp) // 4000)].round(2).tolist()})
    return res


if __name__ == "__main__":
    by_permit = {}
    for pid, m in INV.items(): by_permit.setdefault((m["api"], m["permit"]), []).append(pid)
    unit_jobs, wl_jobs = [], []
    all_wls = [p for p in INV if good_wl(p)]
    for key, pids in by_permit.items():
        wls = [p for p in pids if good_wl(p)]
        wl_jobs += [w for w in wls if not SCAN[w]['georef'].get('oldPlat')]
        for p in pids:
            if len(SCAN[p]["pts"]) >= 2 or (SCAN[p].get("georef") or {}).get("oldPlat"): continue  # a well-location plat, not a unit plat
            if not SCAN[p]["units"]: continue
            if wls: unit_jobs.append((p, wls)); continue
            nm = SCAN[p]["units"][0][0]
            others = [w for w in all_wls if any(set(name_tokens(nm)) and set(name_tokens(nm)) <= set(name_tokens(n)) for n, _, _ in SCAN[w]["units"])]
            unit_jobs.append((p, others[:4]))
    w1 = {}
    if len(sys.argv) > 1:
        w1 = {w["api8"]: w.get("unitAcres") for w in json.load(gzip.open(sys.argv[1]))["wells"] if w["api8"]}
    old_jobs = [(p, w1.get(INV[p]["api"])) for p in INV if (SCAN[p].get("georef") or {}).get("oldPlat") and good_wl(p)]
    with ProcessPoolExecutor(max_workers=8) as ex:
        units = list(ex.map(do_unit_plat, unit_jobs))
        direct = [x for r in ex.map(do_wl_direct, wl_jobs) for x in r]
        old = [x for r in ex.map(do_old_direct, old_jobs) for x in r]
    json.dump({"unitPlats": units, "wellPlatUnits": direct, "oldPlatUnits": old}, open(f"{U}/work/units_sp.json", "w"))
    print("old plats placed:", len(old_jobs), "| outlines:", sum(1 for o in old if "fail" not in o))
    ok = [u for u in units if "fail" not in u]
    print("unit plats:", len(units), "| lined up:", len(ok), "| failed:", len(units) - len(ok))
    from collections import Counter
    print(Counter(u["fail"] for u in units if "fail" in u))
    print("well-plat outlines with their own label:", len(direct), "| not cut off by the frame:", sum(1 for d in direct if not d["clipped"]))
