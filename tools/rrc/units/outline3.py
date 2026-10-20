"""Unit outline from a hatched boundary, whether the line itself is colored or black with colored ticks inside."""
import sys, json, math
import numpy as np, cv2
from outline import color_masks

def fill_holes_region(ink):
    inv = cv2.bitwise_not(ink)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, 4)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
    holes = [i for i in range(1, n) if i not in border]
    if not holes: return None, 0
    big = max(holes, key=lambda i: stats[i, cv2.CC_STAT_AREA])
    filled = cv2.bitwise_or(ink, ((lab != 0) & ~np.isin(lab, list(border))).astype(np.uint8) * 255)
    # keep the filled component containing the biggest hole
    m, lab2 = cv2.connectedComponents(filled, connectivity=8)
    ys, xs = np.nonzero(lab == big)
    comp = (lab2 == lab2[ys[0], xs[0]]).astype(np.uint8) * 255
    return comp, int(stats[big, cv2.CC_STAT_AREA])

def region(bgr, mask, min_px=20000):
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    dark = (gray < 130).astype(np.uint8) * 255
    for near_px, close_px in ((6, 7), (10, 13), (12, 21), (14, 31), (16, 41)):
        near = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * near_px + 1, 2 * near_px + 1)))
        ink = cv2.bitwise_or(mask, cv2.bitwise_and(dark, near))
        ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_px, close_px)))
        comp, hole = fill_holes_region(ink)
        if comp is None or hole < min_px: continue
        # drop thin stubs that stick out of the band (survey lines touching the boundary)
        comp = cv2.morphologyEx(comp, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        outer = max(cnts, key=cv2.contourArea)
        # the boundary line's half width: dark or colored line pixels along the outer edge
        line = cv2.bitwise_or(mask, cv2.bitwise_and(dark, near))
        dt = cv2.distanceTransform((line > 0).astype(np.uint8), cv2.DIST_L2, 3)
        edge = outer.reshape(-1, 2)
        vals = []
        for x, y in edge[:: max(1, len(edge) // 400)]:
            win = dt[max(0, y - 4): y + 5, max(0, x - 4): x + 5]
            if win.size and win.max() > 0: vals.append(win.max())
        halfw = float(np.median(vals)) if vals else 1.5
        return {"outer": edge, "halfWidthPx": halfw, "close": close_px, "holePx": hole}
    return None

def best_outline(bgr, min_px=20000):
    best = None
    for name, m in color_masks(bgr).items():
        r = region(bgr, m, min_px)
        if not r: continue
        a = cv2.contourArea(r["outer"].astype(np.float32))
        if best is None or a > best[0]: best = (a, name, r)
    return best

if __name__ == "__main__":
    for path, ftpx, called in zip(sys.argv[1::3], sys.argv[2::3], sys.argv[3::3]):
        img = cv2.imread(path); ftpx = float(ftpx); called = float(called)
        b = best_outline(img)
        if not b: print(path.split("/")[-1], "no closed outline"); continue
        a, name, r = b; per = cv2.arcLength(r["outer"].astype(np.float32), True)
        ac = (a - per * r["halfWidthPx"]) * ftpx ** 2 / 43560
        print(f"{path.split('/')[-1]:22} {name:6} close {r['close']:2}px halfw {r['halfWidthPx']:.1f}px | {ac:9.2f} ac vs called {called} ({100*(ac-called)/called:+.2f}%)")
        vis = (img * 0.45 + 140).astype(np.uint8); cv2.polylines(vis, [r["outer"].astype(np.int32)], True, (255, 0, 255), 4)
        cv2.imwrite(path.replace(".png", "_o3.png"), cv2.resize(vis, None, fx=0.25, fy=0.25))
