"""Register a unit plat's outline onto a georeferenced well-location plat (rotation + translation + small scale)."""
import sys, json, math, re
import numpy as np, cv2
from outline3 import best_outline as unit_outline

def sat_ink(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    return (((hsv[..., 1] > 90) & (hsv[..., 2] > 70)).astype(np.uint8) * 255)

def label_point(ocr, unit_name):
    toks = [t for t in re.findall(r"[A-Za-z]{3,}", unit_name) if t.lower() not in ("gas", "unit", "pooled", "called", "acres", "deep", "the")]
    for l in ocr["lines"]:
        tl = l["text"].lower()
        if toks and any(t.lower() in tl for t in toks[:1]):
            x, y, w, h = l["box"]; return (x + w / 2, y + h / 2), l["text"]
    return None, None

def xform(pts, th, s, tx, ty):
    c, sn = math.cos(th) * s, math.sin(th) * s
    return np.stack([pts[:, 0] * c - pts[:, 1] * sn + tx, pts[:, 0] * sn + pts[:, 1] * c + ty], 1)

SCALE_TOL = 0.006  # both plats print at the same stated scale; allow 0.6% for printing

def register(unit_img, wl_img, s0, label=None, coarse=0.15, rot_window=None):
    """rot_window=(center_deg, tol_deg) limits the rotation (unit plat -> well plat pixels) to that window."""
    u = unit_outline(unit_img)
    if not u: return None
    contour = u[2]["outer"].astype(np.float64)
    step = max(1, len(contour) // 1500); pts = contour[::step]
    ink = sat_ink(wl_img)
    H, W = ink.shape
    dt = cv2.distanceTransform(cv2.bitwise_not(ink), cv2.DIST_L2, 5)
    # coarse search on a downsampled proximity map
    small = cv2.resize(ink, None, fx=coarse, fy=coarse, interpolation=cv2.INTER_AREA)
    prox = cv2.GaussianBlur((small > 0).astype(np.float32), (0, 0), 2.0)
    c0 = pts.mean(0)
    best = []
    def in_win(deg):
        return rot_window is None or abs((deg - rot_window[0] + 180) % 360 - 180) <= rot_window[1]
    for deg in ([d for d in range(0, 360, 3) if in_win(d)] if rot_window is None or rot_window[1] >= 3 else [rot_window[0]]):
        th = math.radians(deg)
        q = xform(pts - c0, th, s0 * coarse, 0, 0)
        mn = q.min(0); size = (q.max(0) - mn + 3).astype(int)
        tpl = np.zeros((size[1], size[0]), np.float32)
        qi = (q - mn + 1).astype(int); tpl[qi[:, 1], qi[:, 0]] = 1.0
        pad = cv2.copyMakeBorder(prox, size[1], size[1], size[0], size[0], cv2.BORDER_CONSTANT, value=0)
        res = cv2.matchTemplate(pad, tpl, cv2.TM_CCORR)
        _, mx, _, loc = cv2.minMaxLoc(res)
        # template top-left at loc -> translation of the centroid in full-res WL pixels
        tx = (loc[0] - size[0] + 1 - mn[0]) / coarse; ty = (loc[1] - size[1] + 1 - mn[1]) / coarse
        best.append((mx / len(q), deg, tx, ty))
    best.sort(reverse=True)
    def cost(p):
        th, s, tx, ty = p
        q = xform(pts - c0, th, s, tx, ty)
        inside = (q[:, 0] >= 0) & (q[:, 0] < W - 1) & (q[:, 1] >= 0) & (q[:, 1] < H - 1)
        if inside.sum() < 0.2 * len(q): return 1e9, inside
        d = dt[q[inside, 1].astype(int), q[inside, 0].astype(int)]
        return float(np.minimum(d, 25).mean()), inside
    results = []
    for score, deg, tx, ty in best[:12]:
        p = np.array([math.radians(deg), s0, tx, ty])
        steps = np.array([math.radians(1.0), 0.004, 6.0, 6.0])
        cur, _ = cost(p)
        for it in range(200):  # coordinate descent with shrinking steps
            improved = False
            for k in range(4):
                for sgn in (1, -1):
                    q = p.copy(); q[k] += sgn * steps[k]
                    if abs(q[1] / s0 - 1) > SCALE_TOL: continue
                    if not in_win(math.degrees(q[0])): continue
                    c, _ = cost(q)
                    if c < cur: p, cur, improved = q, c, True
            if not improved:
                steps /= 2
                if steps[2] < 0.25: break
        c, inside = cost(p)
        q = xform(pts - c0, *p)
        d = dt[q[inside, 1].astype(int), q[inside, 0].astype(int)]
        ok_label = None
        if label is not None:
            poly = xform(contour - c0, *p).astype(np.float32)
            ok_label = cv2.pointPolygonTest(poly.reshape(-1, 1, 2), label, False) >= 0
        results.append({"cost": c, "params": p.tolist(), "inFrame": float(inside.mean()), "within3px": float((d <= 3).mean()), "medianPx": float(np.median(d)), "labelInside": ok_label})
    results.sort(key=lambda r: (r["labelInside"] is False, r["cost"]))
    return {"best": results[0], "alternatives": results[1:4], "color": u[1], "contour": contour, "c0": c0.tolist(), "unitAreaPx": float(cv2.contourArea(contour.astype(np.float32))), "halfWidthPx": u[2]["halfWidthPx"]}

if __name__ == "__main__":
    import os
    L = sys.argv[1]
    wl = cv2.imread(f"{L}/lanier_wl.jpg"); wl_ocr = json.load(open(f"{L}/lanier_wl.ocr.json"))
    geo = json.load(open(f"{L}/lanier_wl.georef.json"))
    t = geo["transform"]; ftpx_wl = geo["ftPerPx"]
    vis = (wl * 0.5 + 127).astype(np.uint8)
    for name, called in (("Lanier", 701.4459), ("Carper", 700.089), ("Winn", 704.0)):
        ui = cv2.imread(f"{L}/unit_{name}.png")
        s0 = (1000 / 300) / ftpx_wl
        lab, labtxt = label_point(wl_ocr, name)
        r = register(ui, wl, s0, lab)
        b = r["best"]; th, s, tx, ty = b["params"]
        poly = xform(r["contour"] - np.array(r["c0"]), th, s, tx, ty)
        # to State Plane: x' = a x - b y + tx, y' = b x + a y + ty with image y flipped
        a, bb, TX, TY = t
        sp = np.stack([a * poly[:, 0] - bb * (-poly[:, 1]) + TX, bb * poly[:, 0] + a * (-poly[:, 1]) + TY], 1)
        area_sp = abs(cv2.contourArea(sp.astype(np.float64).astype(np.float32)))
        # centerline correction: inset by half the line width (in WL px -> ft)
        per_ft = cv2.arcLength(sp.astype(np.float32), True); hw_ft = r["halfWidthPx"] * s * ftpx_wl
        ac = (area_sp - per_ft * hw_ft) / 43560
        print(f"{name:7} called {called:9.4f} | mapped {ac:9.2f} ac ({100*(ac-called)/called:+.2f}%) | rot {math.degrees(th)%360:6.1f} scale {s:.4f} | in-frame {b['inFrame']:.0%} within 3px(~10ft) {b['within3px']:.0%} median {b['medianPx']*ftpx_wl:.1f} ft | label '{labtxt}' inside {b['labelInside']}")
        cv2.polylines(vis, [poly.astype(np.int32)], True, (255, 0, 255), 4)
    cv2.imwrite(f"{L}/lanier_registered.png", cv2.resize(vis, None, fx=0.25, fy=0.25))
