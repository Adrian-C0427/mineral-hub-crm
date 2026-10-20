"""Stage 3: unit outlines -> State Plane polygons.

For each well (permit):
  * unit plats (one unit each, no coordinates): trace the hatched outline, check its
    area against the plat's "Called N Acres", then line it up against the well's
    placed well-location plat (rotation + translation, scale held to the stated scale).
  * placed well-location plats: closed colored outlines with a "Called N Acres" label
    inside are taken directly (used when a unit has no plat of its own).
Writes work/units_sp.json: every candidate polygon (NAD27 Texas Central, US ft) with its QA.
"""
import sys, os, json, math, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from concurrent.futures import ProcessPoolExecutor
import numpy as np, cv2
import parse
from outline import color_masks
from outline3 import best_outline, region
from register import register, xform

U = os.path.expanduser("~/rrc-data/unit-plats")
INV = {m["id"]: m for m in json.load(open(f"{U}/work/inventory.json"))}
SCAN = {r["id"]: r for r in json.load(open(f"{U}/work/scan.json"))}
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
        if toks and set(toks) & set(name_tokens(n)): return pt, n, ac
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
    out.update(name=name, calledAcres=called, tracedAcres=round(traced_ac, 2), color=color, statedScale=sc["scale"] or 1000.0)
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
        rb = reg["best"]
        score = (rb["labelInside"] is not False, rb["within3px"] * min(1.0, rb["inFrame"] / 0.5))
        if best is None or score > best[0]: best = (score, wid, reg, lab_name, s0, g)
    if not best:
        out["fail"] = "no placed well-location plat to line it up with"; return out
    _, wid, reg, lab_name, s0, g = best
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
               halfWidthFt=round(hw_ft, 2), sp=sp[:: max(1, len(sp) // 4000)].round(2).tolist())
    return out


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
        # touching the image frame means the plat cuts the unit off
        H, W = img.shape[:2]; xs, ys = r["outer"][:, 0], r["outer"][:, 1]
        clipped = bool(xs.min() <= 3 or ys.min() <= 3 or xs.max() >= W - 4 or ys.max() >= H - 4)
        res.append({"plat": wid, "file": m["file"], "api": m["api"], "permit": m["permit"], "kind": "well-plat", "name": name, "calledAcres": called, "color": color,
                    "mappedAcres": round(mapped, 2), "mappedDiffPct": round(100 * (mapped - called) / called, 2), "clipped": clipped,
                    "controlResidualFt": max(g["residualFt"].values()), "halfWidthFt": round(hw_ft, 2), "sp": sp[:: max(1, len(sp) // 4000)].round(2).tolist()})
    return res


if __name__ == "__main__":
    by_permit = {}
    for pid, m in INV.items(): by_permit.setdefault((m["api"], m["permit"]), []).append(pid)
    unit_jobs, wl_jobs = [], []
    for key, pids in by_permit.items():
        wls = [p for p in pids if good_wl(p)]
        wl_jobs += wls
        for p in pids:
            if len(SCAN[p]["pts"]) >= 2: continue  # a well-location plat, not a unit plat
            if not SCAN[p]["units"]: continue
            unit_jobs.append((p, wls))
    with ProcessPoolExecutor(max_workers=8) as ex:
        units = list(ex.map(do_unit_plat, unit_jobs))
        direct = [x for r in ex.map(do_wl_direct, wl_jobs) for x in r]
    json.dump({"unitPlats": units, "wellPlatUnits": direct}, open(f"{U}/work/units_sp.json", "w"))
    ok = [u for u in units if "fail" not in u]
    print("unit plats:", len(units), "| lined up:", len(ok), "| failed:", len(units) - len(ok))
    from collections import Counter
    print(Counter(u["fail"] for u in units if "fail" in u))
    print("well-plat outlines with their own label:", len(direct), "| not cut off by the frame:", sum(1 for d in direct if not d["clipped"]))
