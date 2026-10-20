"""Extract colored hatched unit outlines from a raster plat; report polygons in pixels."""
import sys, json, math
import numpy as np, cv2

HUES = {"red": [(0, 9), (170, 180)], "orange": [(10, 24)], "yellow": [(25, 34)], "green": [(35, 85)], "cyan": [(86, 99)], "blue": [(100, 130)], "purple": [(131, 150)], "magenta": [(151, 169)]}

def color_masks(bgr):
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    sat = (s > 90) & (v > 70)
    out = {}
    for name, ranges in HUES.items():
        m = np.zeros(h.shape, bool)
        for lo, hi in ranges: m |= (h >= lo) & (h <= hi)
        m &= sat
        if m.sum() > 2000: out[name] = m.astype(np.uint8) * 255
    return out

def outline_from_mask(mask, close_px):
    """Close the hatched line into a solid ring, fill it, return the outer contour of the largest region."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_px, close_px))
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(closed, 8)
    if n < 2: return None
    # biggest-extent component = the boundary line (text labels are compact)
    idx = max(range(1, n), key=lambda i: stats[i, cv2.CC_STAT_WIDTH] * stats[i, cv2.CC_STAT_HEIGHT])
    comp = (lab == idx).astype(np.uint8) * 255
    cnts, hier = cv2.findContours(comp, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if not cnts: return None
    outer = max(cnts, key=cv2.contourArea)
    filled = np.zeros_like(comp); cv2.drawContours(filled, [outer], -1, 255, -1)
    # Closed ring <=> filling adds a large interior beyond the line itself
    ring_area = comp.sum() / 255; fill_area = filled.sum() / 255
    return {"contour": outer.reshape(-1, 2), "fillPx": fill_area, "linePx": ring_area, "closed": fill_area > 4 * ring_area, "bbox": [int(v) for v in stats[idx, :4]]}

if __name__ == "__main__":
    img = cv2.imread(sys.argv[1]); ftpx = float(sys.argv[2]); out = sys.argv[3]
    ms = color_masks(img)
    vis = (img * 0.45 + 140).astype(np.uint8)
    res = {}
    for name, m in ms.items():
        o = outline_from_mask(m, 15)
        if not o: continue
        poly = cv2.approxPolyDP(o["contour"].reshape(-1, 1, 2).astype(np.float32), 1.5, True).reshape(-1, 2)
        area_ac = cv2.contourArea(poly.astype(np.float32)) * ftpx * ftpx / 43560
        res[name] = {"closed": bool(o["closed"]), "areaAcres": round(area_ac, 2), "vertices": len(poly), "maskPx": int(m.sum() / 255)}
        cv2.polylines(vis, [poly.astype(np.int32)], True, (255, 0, 255), 3)
    cv2.imwrite(out, cv2.resize(vis, None, fx=0.25, fy=0.25))
    print(json.dumps(res, indent=1))
