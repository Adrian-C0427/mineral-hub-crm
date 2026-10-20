"""Stage 5: visual QA — draw each published unit's final outline back onto the well plat it was placed with.

The outline goes through the same State Plane polygon that was published, mapped back into the
well plat's pixels with the inverse of that plat's control-point transform, so any placement or
registration error shows as magenta drifting off the plat's own hatched boundary.
Writes work/qa/<unit id>.jpg and contact sheets work/qa/sheet_<n>.jpg (12 units each).
"""
import sys, os, json, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, cv2
from shapely.geometry import Polygon

U = os.path.expanduser("~/rrc-data/unit-plats")


def sp_to_px(t, xy):
    a, b, tx, ty = t; det = a * a + b * b
    X, Y = xy[:, 0] - tx, xy[:, 1] - ty
    x = (a * X + b * Y) / det; yf = (-b * X + a * Y) / det
    return np.stack([x, -yf], 1)


def main():
    qa = json.load(open(f"{U}/work/bundle_qa.json"))
    scan = {r["id"]: r for r in json.load(open(f"{U}/work/scan.json"))}
    sp = json.load(open(f"{U}/work/units_sp.json"))
    src = {(c["plat"], c.get("wlPlat")): c for c in sp["unitPlats"] + sp["wellPlatUnits"] if "fail" not in c}
    out = f"{U}/work/qa"; os.makedirs(out, exist_ok=True)
    thumbs = []
    for u in qa["units"]:
        wl = u["_qa"]["wlPlat"]; t = u["_qa"]["transform"]
        img = cv2.imread(f"{U}/work/img/{wl}.png")
        poly = Polygon(u["_qa"]["spOuter"]).buffer(-u["_qa"]["halfWidthFt"], join_style=2)
        px = sp_to_px(t, np.array(poly.exterior.coords))
        g = scan.get(wl, {}).get("georef") or {"pixels": {}}
        vis = (img * 0.55 + 110).astype(np.uint8)
        cv2.polylines(vis, [px.round().astype(np.int32)], True, (255, 0, 255), 5)
        for k, (x, y) in (g.get("pixels") or {}).items(): cv2.circle(vis, (int(x), int(y)), 22, (0, 160, 0), 5)
        # crop to the unit (plus margin), clipped to the sheet
        x0, y0 = np.maximum(px.min(0) - 150, 0).astype(int); x1, y1 = np.minimum(px.max(0) + 150, [vis.shape[1], vis.shape[0]]).astype(int)
        crop = vis[y0:y1, x0:x1] if x1 > x0 + 50 and y1 > y0 + 50 else vis
        s = 520 / max(crop.shape[:2]); th = cv2.resize(crop, None, fx=s, fy=s)
        lab = f"{u['name'][:34]} | {u['calledAcres']} ac | {u['_qa']['areaDiffPct']:+.2f}%"
        canvas = np.full((560, 540, 3), 255, np.uint8); canvas[34:34 + th.shape[0], 10:10 + th.shape[1]] = th
        cv2.putText(canvas, lab, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (40, 40, 40), 1, cv2.LINE_AA)
        cv2.imwrite(f"{out}/{u['id']}.jpg", canvas, [cv2.IMWRITE_JPEG_QUALITY, 85])
        thumbs.append(canvas)
    for i in range(0, len(thumbs), 12):
        grid = thumbs[i:i + 12] + [np.full((560, 540, 3), 255, np.uint8)] * (12 - len(thumbs[i:i + 12]))
        rows = [np.hstack(grid[r * 4:(r + 1) * 4]) for r in range(3)]
        cv2.imwrite(f"{out}/sheet_{i // 12 + 1}.jpg", cv2.resize(np.vstack(rows), None, fx=0.6, fy=0.6), [cv2.IMWRITE_JPEG_QUALITY, 80])
    print("overlays:", len(thumbs), "| sheets:", math.ceil(len(thumbs) / 12))


if __name__ == "__main__":
    main()
