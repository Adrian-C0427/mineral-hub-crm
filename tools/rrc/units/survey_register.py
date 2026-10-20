"""Raster helpers for survey-line matching (plat_line_ink, _template, _render, transform_from), used by
old_plats.py. The free search below (register) is NOT used: with no anchor it locked onto wrong
placements on sparse plats (Lanier, 163.7 deg) -- old_plats.py anchors on a printed point instead.

Placement by survey lines: find where (rotation, scale, offset) RRC's survey/abstract
network best matches the survey lines drawn on the plat, with no reliance on well markers.

Search: the plat's line ink (text boxes from OCR masked out), blurred and downsampled, is
matched as a template against RRC's survey lines rendered around a known anchor (a printed
well coordinate, or RRC's own location for the well) for every rotation (1.5 deg steps) and
scale (stated scale +/-6%). The best match is refined at higher resolution by maximizing the
same 30-ft survey-line score the marker placement uses.

The result still has to pass independent checks (see check_with_coordinates): the plat's
printed well coordinates, mapped back onto the sheet, must land on the drawn well path.
"""
import math
import numpy as np, cv2
from survey_check import sp_to_px, SurveyScorer


def plat_line_ink(img_bgr, ocr):
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    ink = (gray < 150).astype(np.uint8)
    for l in ocr["lines"]:  # text is not linework
        x, y, w, h = [int(round(v)) for v in l["box"]]
        ink[max(0, y - 3): y + h + 3, max(0, x - 3): x + w + 3] = 0
    return ink


def _template(ink, f):
    small = cv2.resize(ink.astype(np.float32), None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    t = (small > 0.08).astype(np.float32)
    return cv2.GaussianBlur(t, (0, 0), 1.2)


def _render(seg_a, seg_b, center, theta, ftpx, f, size):
    """RRC lines -> raster in a frame where the plat (rotated by theta, at ftpx) would sit; center maps to the raster middle."""
    c, s = math.cos(theta), math.sin(theta)
    def tf(p):
        d = (p - center) / (ftpx / f)
        x = c * d[:, 0] + s * d[:, 1]; y = -(-s * d[:, 0] + c * d[:, 1])
        return np.stack([x + size / 2, y + size / 2], 1)
    A, B = tf(seg_a), tf(seg_b)
    R = np.zeros((size, size), np.uint8)
    segs = np.stack([A, B], 1).round().astype(np.int32)  # one C call for all lines (same raster as a per-line loop)
    segs = segs[(np.abs(segs) < 1 << 20).all(axis=(1, 2))]
    cv2.polylines(R, list(segs), False, 255, 1)
    return cv2.GaussianBlur(R.astype(np.float32) / 255, (0, 0), 1.2)


def transform_from(theta, ftpx, center, f, size, loc):
    """Similarity (plat px -> SP, image y down) for a match whose template top-left lands at `loc` in the raster."""
    # plat pixel (u, v) -> raster ((u*f) + loc) -> SP via the inverse of _render's mapping
    a = ftpx * math.cos(theta); b = ftpx * math.sin(theta)
    # raster offset (x, y) from the middle -> SP: d = R(-theta) * (x, -y) * ftpx/f
    # plat px (u, v): raster x = u*f + loc_x - size/2, raster y = v*f + loc_y - size/2
    ox, oy = loc[0] - size / 2, loc[1] - size / 2
    c, s = math.cos(theta), math.sin(theta)
    k = ftpx / f
    # SP = center + k * [ c*x - s*(-y) ,  s*x + c*(-y) ] with x = u f + ox, y = v f + oy
    # in the georef convention x' = A u - B (-v) + TX, y' = B u + A (-v) + TY:
    A_, B_ = k * f * c, k * f * s
    TX = center[0] + k * (c * ox + s * oy)
    TY = center[1] + k * (s * ox - c * oy)
    return [A_, B_, TX, TY]


def register(img_bgr, ocr, seg_a, seg_b, anchor_sp, scales_ft_per_in, dpi, radius_ft=22000, f=1 / 8):
    ink = plat_line_ink(img_bgr, ocr)
    T = _template(ink, f)
    keep = (np.hypot(*(seg_a - anchor_sp).T) < radius_ft) | (np.hypot(*(seg_b - anchor_sp).T) < radius_ft)
    sa, sb = seg_a[keep], seg_b[keep]
    if len(sa) < 50: return None
    best = None
    for sc in scales_ft_per_in:
        for ds in np.linspace(-0.06, 0.06, 9):
            ftpx = sc * (1 + ds) / dpi
            size = int(2 * radius_ft / (ftpx / f))
            if size <= max(T.shape) + 4: continue
            for deg in np.arange(0, 360, 1.5):
                th = math.radians(deg)
                R = _render(sa, sb, anchor_sp, th, ftpx, f, size)
                res = cv2.matchTemplate(R, T, cv2.TM_CCORR)
                _, mx, _, loc = cv2.minMaxLoc(res)
                score = mx / (T.sum() + 1e-6)
                if best is None or score > best[0]: best = (score, th, ftpx, loc, size)
    if best is None: return None
    score, th, ftpx, loc, size = best
    tr = transform_from(th, ftpx, anchor_sp, f, size, loc)
    # refine on the full-resolution 30-ft score
    scorer = SurveyScorer(img_bgr, seg_a, seg_b)
    cur = scorer.score(tr)[0]
    steps = [0.004 * abs(tr[0]) + 1e-9, 0.004 * abs(tr[0]) + 1e-9, 40.0, 40.0]
    p = list(tr)
    for _ in range(60):
        improved = False
        for k in range(4):
            for sg in (1, -1):
                q = list(p)
                if k < 2:  # rotate/scale together through (a, b)
                    ang = math.atan2(p[1], p[0]) + (sg * 0.003 if k == 0 else 0)
                    mag = math.hypot(p[0], p[1]) * (1 + (sg * 0.002 if k == 1 else 0))
                    q[0], q[1] = mag * math.cos(ang), mag * math.sin(ang)
                else:
                    q[k] += sg * steps[k]
                v = scorer.score(q)[0]
                if v > cur: p, cur, improved = q, v, True
        if not improved:
            steps[2] /= 2; steps[3] /= 2
            if steps[2] < 2: break
    s0, sharp, n = scorer.peak(p)
    return {"transform": p, "coarseScore": float(score), "surveyMatch": round(s0, 3), "surveySharpness": round(sharp, 2), "surveySamples": n,
            "ftPerPx": math.hypot(p[0], p[1]), "rotationDeg": math.degrees(math.atan2(p[1], p[0])), "impliedScale": math.hypot(p[0], p[1]) * dpi}


def check_with_coordinates(img_bgr, transform, pts, circles):
    """Independent check: the printed well points, mapped onto the sheet, must sit on the drawn well path;
    snap each to a marker circle when one is right there, and report the residual of a 3-point refit."""
    from georef import _ink, _support, similarity, apply
    ink = _ink(img_bgr)
    order = [k for k in ("SHL", "PP", "BHL") if k in pts]
    pix = {k: tuple(sp_to_px(transform, np.array([pts[k]], float))[0]) for k in order}
    sup = _support(ink, pix, order)
    cc = np.array([c[:2] for c in circles]) if circles else np.zeros((0, 2))
    snapped = {}
    for k in order:
        if len(cc):
            d = np.hypot(cc[:, 0] - pix[k][0], cc[:, 1] - pix[k][1]); j = int(np.argmin(d))
            if d[j] < 25: snapped[k] = tuple(cc[j])
    out = {"pathSupport": round(sup, 3), "predicted": {k: [float(v) for v in pix[k]] for k in order}, "snapped": sorted(snapped)}
    if len(snapped) == len(order) == 3:
        tr = similarity([(snapped[k][0], -snapped[k][1]) for k in order], [pts[k] for k in order])
        out["refit"] = list(map(float, tr))
        out["residualFt"] = {k: math.dist(apply(tr, snapped[k][0], -snapped[k][1]), pts[k]) for k in order}
    return out
