"""Placement for vector plats whose well path is drawn as red filled shapes (Bowman / Mitsui).

The surface location, first take point and bottom hole are corners of the red path shapes,
so the candidate points are those corners (exact PDF geometry, mapped into the 300-dpi render
frame). The triple whose layout matches the printed State Plane coordinates is fitted with a
3-point similarity (the third point is an independent check), then confirmed against RRC's
survey lines exactly like the raster plats.
"""
import math
import numpy as np, cv2, fitz
from scipy.spatial import cKDTree
from georef import similarity, apply, COMMON_SCALES, SCALE_TOL, SURVEY_MIN, SHARP_MIN


def red_corners(page, dpi=300, min_span_pt=20):
    mat = page.rotation_matrix * fitz.Matrix(dpi / 72, dpi / 72)
    pts = []
    for d in page.get_drawings():
        if tuple(round(x, 2) for x in (d.get("fill") or ())) != (1.0, 0.0, 0.0): continue
        vs = []
        for it in d["items"]:
            if it[0] == "l": vs += [it[1], it[2]]
            elif it[0] == "re": r = it[1]; vs += [r.tl, r.tr, r.br, r.bl]
            elif it[0] == "c": vs += [it[1], it[4]]
        if not vs: continue
        xs = [p.x for p in vs]; ys = [p.y for p in vs]
        if math.hypot(max(xs) - min(xs), max(ys) - min(ys)) < min_span_pt: continue
        pts += [tuple(p * mat) for p in vs]
    if not pts: return np.zeros((0, 2))
    P = np.array(pts)
    merged = []
    for p in P:  # merge corners within ~2 pt
        if all(np.hypot(*(p - q)) > 2 * dpi / 72 for q in merged): merged.append(p)
    return np.array(merged)


def place(page, img_bgr, pts, scale, dpi, scorer):
    Cn = red_corners(page, dpi)
    if len(Cn) < 3 or not all(k in pts for k in ("SHL", "PP", "BHL")):
        return {"ok": False, "why": "red well path or a control point missing"}
    C = Cn[:, 0] - 1j * Cn[:, 1]
    P = {k: complex(*v) for k, v in pts.items()}
    tree = cKDTree(np.c_[C.real, C.imag])
    D = np.abs(C[:, None] - C[None, :]) / abs(P["BHL"] - P["SHL"])
    win = np.zeros(D.shape, bool)
    for sc in ([scale] if scale else COMMON_SCALES):
        win |= (D >= dpi / sc * (1 - SCALE_TOL)) & (D <= dpi / sc * (1 + SCALE_TOL))
    ii, jj = np.nonzero(win)
    if not len(ii): return {"ok": False, "why": "no red-path corner pair at the plat's scale"}
    z = (P["BHL"] - P["SHL"]) / (C[jj] - C[ii]); t = P["SHL"] - z * C[ii]
    pred = (P["PP"] - t) / z
    d, idx = tree.query(np.c_[pred.real, pred.imag])
    best = None
    for k in np.argsort(d)[:50]:
        if d[k] > 8 * dpi / 300: break
        m = {"SHL": Cn[ii[k]], "PP": Cn[idx[k]], "BHL": Cn[jj[k]]}
        tr = similarity([(m[q][0], -m[q][1]) for q in m], [pts[q] for q in m])
        s0, sharp, n = scorer.peak(tr)
        key = s0 * sharp
        if best is None or key > best[0]: best = (key, tr, m, s0, sharp, n)
    if not best: return {"ok": False, "why": "red-path corners don't match the printed coordinates"}
    _, tr, m, s0, sharp, n = best
    res = {q: math.dist(apply(tr, m[q][0], -m[q][1]), pts[q]) for q in m}
    out = {"transform": list(map(float, tr)), "ftPerPx": math.hypot(tr[0], tr[1]), "rotationDeg": math.degrees(math.atan2(tr[1], tr[0])),
           "residualFt": res, "pixels": {q: [float(v) for v in m[q]] for q in m}, "impliedScale": math.hypot(tr[0], tr[1]) * dpi,
           "surveyMatch": round(s0, 3), "surveySharpness": round(sharp, 2), "surveySamples": n, "markersFrom": "vector red well path"}
    if max(res.values()) > 25: return dict(out, ok=False, why=f"red-path corners fit the coordinates only to {max(res.values()):.0f} ft")
    if not ((s0 >= SURVEY_MIN and sharp >= SHARP_MIN) or (s0 >= 0.35 and sharp >= 1.5)):
        return dict(out, ok=False, why=f"RRC survey lines don't line up with the plat's ({s0:.0%}, sharpness {sharp:.2f})")
    return dict(out, ok=True)
