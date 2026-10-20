"""Georeference a well-location plat from its printed SHL / PP / BHL State Plane coordinates."""
import sys, json, re, math, itertools
import numpy as np, cv2

def norm_text(t):
    return t.replace("Х", "X").replace("х", "x").replace("У", "Y").replace("−", "-")

def parse_points(ocr):
    """Return {"SHL": (x, y), "PP": ..., "BHL": ...} in State Plane ft from the plat's coordinate blocks."""
    lines = [dict(l, text=norm_text(l["text"])) for l in ocr["lines"]]
    heads = []
    for l in lines:
        t = l["text"].upper()
        if "SURFACE LOCATION" in t and len(t) < 40: heads.append(("SHL", l))
        elif ("PENETRATION" in t or "TOP PERF" in t or "FIRST TAKE" in t) and len(t) < 45: heads.append(("PP", l))
        elif ("BOTTOM HOLE" in t or "BOTTOM PERF" in t or "LAST TAKE" in t) and len(t) < 45: heads.append(("BHL", l))
    num = lambda s: float(s.replace(",", "").replace(" ", ""))
    xs, ys = [], []
    for l in lines:
        t = l["text"].upper().replace(" ", "")
        m = re.search(r"(?:^|[^A-Z])(?:X|E|E=X|EAST(?:ING)?)[:=]?(\d[\d,]{6,}\.?\d*)", t)
        if m and 1_000_000 < num(m.group(1)) < 5_000_000: xs.append((l, num(m.group(1))))
        m = re.search(r"(?:^|[^A-Z])(?:Y|N|N=Y|NORTH(?:ING)?)[:=]?(\d[\d,]{5,}\.?\d*)", t)
        if m and 10_000 < num(m.group(1)) < 2_000_000: ys.append((l, num(m.group(1))))
    pts = {}
    for key, h in heads:
        hx, hy = h["box"][0], h["box"][1]
        # nearest X and Y below the heading in the same column
        cand = lambda arr: sorted([(l["box"][1] - hy, v) for l, v in arr if 0 < l["box"][1] - hy < 700 and abs(l["box"][0] - hx) < 250])
        cx, cy = cand(xs), cand(ys)
        if cx and cy and key not in pts: pts[key] = (cx[0][1], cy[0][1])
    return pts

def parse_scale(ocr):
    for l in ocr["lines"]:
        m = re.search(r"1\s*[\"”'']{0,2}\s*=\s*([\d,]{3,6})\s*['’]?", l["text"].replace(" ", ""))
        if m and "SCALE" in l["text"].upper(): return float(m.group(1).replace(",", ""))
    for l in ocr["lines"]:
        m = re.search(r"^1\s*[\"”]\s*=\s*([\d,]{3,6})", l["text"].strip())
        if m: return float(m.group(1).replace(",", ""))
    return None

def circles(gray, dpi=300):
    """Open-circle markers: bright center, dark ring. Hough proposes; each proposal is verified over nearby centers/radii (vectorized)."""
    k = dpi / 300
    g = cv2.medianBlur(gray, 3)
    c = cv2.HoughCircles(g, cv2.HOUGH_GRADIENT, dp=1, minDist=max(4, int(6 * k)), param1=120, param2=max(9, int(13 * k)), minRadius=max(3, int(5 * k)), maxRadius=int(18 * k))
    if c is None: return []
    H, W = gray.shape
    ang = np.linspace(0, 2 * math.pi, 40, endpoint=False)
    offs = np.arange(-3, 3.01, 1.5) * k
    out = []
    for x, y, r0 in c[0]:
        rs = np.arange(max(3.0, r0 - 4 * k), r0 + 4 * k + 0.01, 1.0)
        cx = (x + offs)[:, None, None]; cy = (y + offs)[None, :, None]
        cx, cy = np.broadcast_arrays(cx, cy)
        cx = cx[..., 0].ravel(); cy = cy[..., 0].ravel()
        if cx.min() - rs.max() < 1 or cy.min() - rs.max() < 1 or cx.max() + rs.max() > W - 2 or cy.max() + rs.max() > H - 2: continue
        # an open marker keeps some white inside even when the well path runs through it
        ci = cy.round().astype(int); cj = cx.round().astype(int)
        disc = [gray[ci + dy, cj + dx] for dy in range(-3, 4) for dx in range(-3, 4) if dx * dx + dy * dy <= 9]
        ok = np.mean(np.array(disc) > 180, axis=0) >= 0.12
        if not ok.any(): continue
        cx, cy = cx[ok], cy[ok]
        X = (cx[:, None, None] + rs[None, :, None] * np.cos(ang)[None, None, :]).round().astype(int)
        Y = (cy[:, None, None] + rs[None, :, None] * np.sin(ang)[None, None, :]).round().astype(int)
        dark = (gray[Y, X] < 130).mean(axis=2)  # (centers, radii)
        i, j = np.unravel_index(np.argmax(dark), dark.shape)
        if dark[i, j] >= 0.7: out.append((float(cx[i]), float(cy[i]), float(rs[j])))
    merged = []
    for q in sorted(out, key=lambda q: -q[2]):
        if all(math.dist(q[:2], m[:2]) > 4 * k for m in merged): merged.append(q)
    return merged

def similarity(src, dst):
    """Least-squares similarity src(px) -> dst(ft). Returns (a, b, tx, ty) with x' = a x - b y + tx, y' = b x + a y + ty."""
    A, B = [], []
    for (x, y), (X, Y) in zip(src, dst):
        A += [[x, -y, 1, 0], [y, x, 0, 1]]; B += [X, Y]
    sol, *_ = np.linalg.lstsq(np.array(A, float), np.array(B, float), rcond=None)
    return sol
def apply(t, x, y): a, b, tx, ty = t; return a * x - b * y + tx, b * x + a * y + ty

COMMON_SCALES = (500, 1000, 1500, 2000)


def _ink(img_bgr, band=3):
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    ink = ((gray < 140) | ((hsv[..., 1] > 90) & (hsv[..., 2] > 70))).astype(np.uint8)
    return cv2.dilate(ink, np.ones((2 * band + 1, 2 * band + 1), np.uint8)) > 0


def _support(ink, pix, order, step=5):
    H, W = ink.shape; hits = tot = 0
    for a, b in zip(order, order[1:]):
        (x0, y0), (x1, y1) = pix[a], pix[b]
        n = max(3, int(math.hypot(x1 - x0, y1 - y0) / step))
        t = np.linspace(0.08, 0.92, n)
        xs = np.round(x0 + t * (x1 - x0)).astype(int); ys = np.round(y0 + t * (y1 - y0)).astype(int)
        ok = (xs >= 0) & (xs < W) & (ys >= 0) & (ys < H)
        hits += int(ink[ys[ok], xs[ok]].sum()); tot += int(ok.sum())
    return hits / tot if tot else 0.0


def _walk_end(mask, x, y, dx, dy, limit):
    """Follow a drawn line from (x, y) along (dx, dy) while ink continues; return the last inked point."""
    H, W = mask.shape; lx, ly = x, y
    for i in range(1, limit):
        xi, yi = int(round(x + dx * i)), int(round(y + dy * i))
        if not (0 <= xi < W and 0 <= yi < H) or not mask[max(0, yi - 1): yi + 2, max(0, xi - 1): xi + 2].any(): break
        lx, ly = x + dx * i, y + dy * i
    return lx, ly


def _line_candidates(img, gray, P, pts, scales, dpi, cs, ink, order, many=False):
    """Candidates from the drawn lateral: a long straight red or black line whose length matches PP->BHL
    at the plat's scale; its two ends are PP and BHL (snapped to a marker circle when one is right there)."""
    if "PP" not in P: return [] if many else None
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    red = (((hsv[..., 0] <= 10) | (hsv[..., 0] >= 170)) & (hsv[..., 1] > 90) & (hsv[..., 2] > 70)).astype(np.uint8) * 255
    dark = (gray < 90).astype(np.uint8) * 255
    L_ft = abs(P["BHL"] - P["PP"])
    best = None; found = []
    cc = np.array([c[:2] for c in cs]) if cs else np.zeros((0, 2))
    for sc in scales:
        exp = L_ft * dpi / sc
        for mask in (red, dark):
            segs = cv2.HoughLinesP(mask, 1, np.pi / 1440, threshold=int(exp * 0.2), minLineLength=int(exp * 0.5), maxLineGap=int(30 * dpi / 300))
            if segs is None: continue
            for x1, y1, x2, y2 in segs.reshape(-1, 4)[:60].astype(float):
                L = math.hypot(x2 - x1, y2 - y1); ux, uy = (x2 - x1) / L, (y2 - y1) / L
                ax, ay = _walk_end(mask, x1, y1, -ux, -uy, int(exp * 0.2)); bx, by = _walk_end(mask, x2, y2, ux, uy, int(exp * 0.2))
                Lw = math.hypot(bx - ax, by - ay)
                if not (1 - SCALE_TOL <= Lw / exp <= 1 + SCALE_TOL): continue
                ends = []
                for ex, ey in ((ax, ay), (bx, by)):  # snap to a marker circle centered on the line end
                    snapped = False
                    if len(cc):
                        d = np.hypot(cc[:, 0] - ex, cc[:, 1] - ey); j = int(np.argmin(d))
                        if d[j] < 14 * dpi / 300: ex, ey = cc[j]; snapped = True
                    ends.append((float(ex), float(ey), snapped))
                for pp, bh in ((ends[0], ends[1]), (ends[1], ends[0])):
                    m = {"PP": (pp[0], pp[1], 0.0, pp[2]), "BHL": (bh[0], bh[1], 0.0, bh[2])}
                    tr = similarity([(pp[0], -pp[1]), (bh[0], -bh[1])], [pts["PP"], pts["BHL"]])
                    if "SHL" in P:
                        a_, b_, tx, ty = tr; det = a_ * a_ + b_ * b_
                        X, Y = pts["SHL"][0] - tx, pts["SHL"][1] - ty
                        sx, sy = (a_ * X + b_ * Y) / det, -(-b_ * X + a_ * Y) / det
                        snapped = False
                        if len(cc):
                            d = np.hypot(cc[:, 0] - sx, cc[:, 1] - sy); j = int(np.argmin(d))
                            if d[j] < 18 * dpi / 300: sx, sy = cc[j]; snapped = True
                        m["SHL"] = (float(sx), float(sy), 0.0, snapped)
                    sup = _support(ink, {k: v[:2] for k, v in m.items()}, order)
                    found.append((sup, m))
                    if best is None or sup > best[0]: best = (sup, m)
    return found if many else best


SCALE_TOL = 0.06   # printed PDFs are often scaled to fit the paper: true scale can be ~5% off the label
SURVEY_MIN = 0.5   # share of RRC survey-line samples within 30 ft of the plat's ink
SHARP_MIN = 1.4    # ... versus the same placement nudged 300 ft / turned 2 deg


def solve(img_path, pts, scale, dpi, min_support=0.75, survey_segments=None, survey_ink=150):
    """Find the SHL/PP/BHL circle markers whose layout matches the printed coordinates.
    SHL, PP and BHL often sit nearly on one line, so a residual check alone accepts any three
    marks in a row; the drawn well path between the matched points decides among candidates,
    and the implied scale must agree with the plat's printed (or a standard) scale within 2%."""
    from scipy.spatial import cKDTree
    if "BHL" not in pts or not ({"SHL", "PP"} & set(pts)):
        return {"ok": False, "why": f"need BHL plus SHL or PP ({sorted(pts)})"}
    img = cv2.imread(img_path); gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    cs = circles(gray, dpi)
    survey = None
    if survey_segments is not None:
        from survey_check import SurveyScorer
        survey = SurveyScorer(img, *survey_segments, ink_below=survey_ink)
    if len(cs) < 3: return {"ok": False, "why": "too few circle markers", "circles": len(cs)}
    P = {k: complex(v[0], v[1]) for k, v in pts.items()}
    C = np.array([complex(c[0], -c[1]) for c in cs])
    tree = cKDTree(np.c_[C.real, C.imag])
    scales = [scale] if scale else list(COMMON_SCALES)
    tol = 8 * dpi / 300
    D_px = np.abs(C[:, None] - C[None, :])
    triples = []  # (residual, {key: circle})
    # anchor on SHL->BHL and on PP->BHL: whichever markers are drawn clearly
    for first in [k for k in ("SHL", "PP") if k in P]:
        others = [k for k in ("SHL", "PP") if k in P and k != first]
        if not others: continue
        D = D_px / abs(P["BHL"] - P[first])
        win = np.zeros(D.shape, bool)
        for sc in scales: win |= (D >= dpi / sc * (1 - SCALE_TOL)) & (D <= dpi / sc * (1 + SCALE_TOL))
        ii, jj = np.nonzero(win)
        if not len(ii): continue
        z = (P["BHL"] - P[first]) / (C[jj] - C[ii]); t = P[first] - z * C[ii]
        resid = np.zeros(len(ii)); hit = {}
        for k in others:
            pred = (P[k] - t) / z
            d, idx = tree.query(np.c_[pred.real, pred.imag]); resid += d; hit[k] = (d, idx)
        good = np.nonzero(np.all([hit[k][0] <= tol for k in others], axis=0))[0]
        for gi in good[np.argsort(resid[good])][:3000]:
            m = {first: cs[ii[gi]], "BHL": cs[jj[gi]]}
            for k in others: m[k] = cs[hit[k][1][gi]]
            triples.append((float(resid[gi]), m))
    if "SHL" not in P or "PP" not in P:
        return {"ok": False, "why": "only two control points printed (no independent check)", "circles": len(cs)}
    ink = _ink(img)
    order = [k for k in ("SHL", "PP", "BHL") if k in P]
    cands = [(_support(ink, {k: m[k][:2] for k in m}, order), m, True) for _, m in triples]
    for sup, m in _line_candidates(img, gray, P, pts, scales, dpi, cs, ink, order, many=True):
        cands.append((sup, m, False))
    cands = [c for c in cands if c[0] >= 0.6]
    cands.sort(key=lambda c: -c[0])
    if not cands: return {"ok": False, "why": "no candidate has the well path drawn between its points", "circles": len(cs)}
    scored = []
    for sup, m, from_circles in cands[:600]:
        keys = [k for k in order if k in m]
        tr = similarity([(m[k][0], -m[k][1]) for k in keys], [pts[k] for k in keys])
        s0 = survey.score(tr)[0] if survey is not None else 0.0
        scored.append((s0, sup, m, from_circles, tr))
    scored.sort(key=lambda c: (-c[0], -c[1]))
    best = None
    for s0_, sup, m, from_circles, tr in scored[:8]:
        if survey is not None: s0, sharp, n = survey.peak(tr)
        else: s0, sharp, n = 0.0, 0.0, 0
        key = (s0 * sharp, sup)
        if best is None or key > best[0]: best = (key, sup, m, s0, sharp, n, from_circles)
    _, sup, m, s0, sharp, n, from_circles = best
    # Near-identical candidates (same fit within 50 ft / 0.5 deg) differ only in which marker pixels
    # were picked: keep the one whose three points agree best.
    def _fit(mm):
        ks = [k for k in order if k in mm]
        tr_ = similarity([(mm[k][0], -mm[k][1]) for k in ks], [pts[k] for k in ks])
        return tr_, max(math.dist(apply(tr_, mm[k][0], -mm[k][1]), pts[k]) for k in ks)
    tr_b, res_b = _fit(m)
    for s0_, sup_, mm, fc_, tr_ in scored:
        if s0_ < s0 - 0.03 or sup_ < sup - 0.05: continue
        if abs(math.degrees(math.atan2(tr_[1], tr_[0]) - math.atan2(tr_b[1], tr_b[0]))) > 0.5 or math.hypot(tr_[2] - tr_b[2], tr_[3] - tr_b[3]) > 50: continue
        _, r_ = _fit(mm)
        if r_ < res_b: m, res_b, sup, from_circles = mm, r_, sup_, fc_
    if survey is not None and not ((s0 >= SURVEY_MIN and sharp >= SHARP_MIN) or (s0 >= 0.35 and sharp >= 1.5)):
        ks = [k for k in order if k in m]
        trc = similarity([(m[k][0], -m[k][1]) for k in ks], [pts[k] for k in ks])
        return {"ok": False, "why": f"RRC survey lines don't line up with the plat's (best {s0:.0%}, sharpness {sharp:.2f})", "circles": len(cs),
                "candidate": {"transform": list(map(float, trc)), "pixels": {k: m[k][:2] for k in ks}, "surveyMatch": round(s0, 3), "surveySharpness": round(sharp, 2), "pathSupport": round(sup, 3),
                              "residualFt": {k: math.dist(apply(trc, m[k][0], -m[k][1]), pts[k]) for k in ks}, "impliedScale": math.hypot(trc[0], trc[1]) * dpi}}
    if sup < 0.75:
        return {"ok": False, "why": f"well path drawn along only {sup:.0%} of the matched points", "circles": len(cs)}
    real = all(len(m[k]) < 4 or m[k][3] for k in order)  # circle-based points are all real markers
    if not real and not (survey is not None and s0 >= 0.45 and sharp >= 1.6 and sup >= 0.9):
        return {"ok": False, "why": "a control point isn't on a detected marker and the survey lines don't confirm it strongly", "circles": len(cs)}
    H_, W_ = gray.shape
    if any(not (0.05 * W_ < m[k][0] < 0.95 * W_ and 0.04 * H_ < m[k][1] < 0.96 * H_) for k in order):
        return {"ok": False, "why": "matched points fall on the sheet's border, not the map", "circles": len(cs)}
    keys = order
    tr = similarity([(m[k][0], -m[k][1]) for k in keys], [pts[k] for k in keys])
    res = {k: math.dist(apply(tr, m[k][0], -m[k][1]), pts[k]) for k in keys}
    ftpx = math.hypot(tr[0], tr[1])
    return {"ok": True, "transform": list(map(float, tr)), "ftPerPx": ftpx, "rotationDeg": math.degrees(math.atan2(tr[1], tr[0])), "residualFt": res,
            "pixels": {k: m[k][:2] for k in keys}, "circles": len(cs), "impliedScale": ftpx * dpi, "pathSupport": round(sup, 3),
            "scaleChecked": scale or "standard scales", "surveyMatch": round(s0, 3), "surveySharpness": round(sharp, 2), "surveySamples": n,
            "markersFrom": "circles" if from_circles else "drawn well path"}


def solve_any(img_path, pts, alts, scale, dpi, **kw):
    """Try the printed coordinates and, where a point's X/Y and lat/long disagree (one was misread),
    each alternative; keep the placement that passes with the strongest survey-line confirmation."""
    import itertools
    keys = sorted(alts)
    best = None
    for choice in (itertools.product(*[range(len(alts[k])) for k in keys]) if keys else [()]):
        p = dict(pts)
        for k, c in zip(keys, choice): p[k] = tuple(alts[k][c])
        r = solve(img_path, p, scale, dpi, **kw)
        r["pointsUsed"] = {k: list(v) for k, v in p.items()}
        score = (bool(r.get("ok")), (r.get("surveyMatch") or 0) * (r.get("surveySharpness") or 0))
        if best is None or score > best[0]: best = (score, r)
    return best[1]
