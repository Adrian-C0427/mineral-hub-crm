"""Independent placement check: RRC's survey (abstract) boundaries, projected into the plat with the
candidate placement, should fall on the survey lines the plat draws.
Score = share of RRC boundary samples (inside the sheet) within `tol_ft` of drawn ink."""
import os, json, gzip, math
import numpy as np, cv2
from pyproj import Transformer
import datum

U = os.path.expanduser("~/rrc-data/unit-plats")
_CACHE = f"{U}/work/abstract_lines_sp.npz"


def abstract_lines_sp(abstracts_gz):
    """All abstract boundary vertices as (N, 2) segment arrays in NAD27 Texas Central ft (cached)."""
    if os.path.exists(_CACHE):
        z = np.load(_CACHE); return z["a"], z["b"]
    ds = json.load(gzip.open(abstracts_gz))
    shift = datum.default_shift()
    to_sp = Transformer.from_crs("EPSG:4267", "EPSG:32039", always_xy=True)
    A, B = [], []
    for ab in ds["abstracts"]:
        for poly in ab["geom"]:
            for ring in poly:
                r = np.array(ring, float)
                # NAD83 -> NAD27: invert the smooth RRC shift by one fixed-point step (sub-0.01 ft)
                lon27, lat27 = r[:, 0], r[:, 1]
                for _ in range(2):
                    l83, a83 = shift.nad27_to_83(lon27, lat27)
                    lon27, lat27 = lon27 - (l83 - r[:, 0]), lat27 - (a83 - r[:, 1])
                x, y = to_sp.transform(lon27, lat27)
                p = np.c_[x, y]; A.append(p[:-1]); B.append(p[1:])
    a, b = np.vstack(A), np.vstack(B)
    np.savez(_CACHE, a=a, b=b)
    return a, b


def sp_to_px(t, xy):
    aa, bb, tx, ty = t; det = aa * aa + bb * bb
    X, Y = xy[:, 0] - tx, xy[:, 1] - ty
    return np.stack([(aa * X + bb * Y) / det, -((-bb * X + aa * Y) / det)], 1)


class SurveyScorer:
    """Scores placements of one plat against RRC's survey lines (distance transform built once)."""
    def __init__(self, img_bgr, seg_a, seg_b, ink_below=150):
        self.H, self.W = img_bgr.shape[:2]
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        self.dt = cv2.distanceTransform((gray >= ink_below).astype(np.uint8), cv2.DIST_L2, 5)
        self.a, self.b = seg_a, seg_b

    def score(self, transform, tol_ft=30.0, step_ft=40.0):
        H, W = self.H, self.W
        aa, bb, tx, ty = transform; ftpx = math.hypot(aa, bb)
        pa, pb = sp_to_px(transform, self.a), sp_to_px(transform, self.b)
        lo, hi = np.array([0.04 * W, 0.04 * H]), np.array([0.96 * W, 0.96 * H])
        keep = np.all((pa > lo) & (pa < hi), 1) | np.all((pb > lo) & (pb < hi), 1)
        pa, pb = pa[keep], pb[keep]
        if not len(pa): return 0.0, 0
        n = np.maximum(1, (np.hypot(*(pb - pa).T) * ftpx / step_ft).astype(int))
        reps = np.repeat(np.arange(len(pa)), n + 1)
        t = np.concatenate([np.linspace(0, 1, k + 1) for k in n])[:, None]
        P = pa[reps] + t * (pb[reps] - pa[reps])
        P = P[np.all((P > lo) & (P < hi), 1)].round().astype(int)
        if len(P) < 30: return 0.0, len(P)
        d = self.dt[P[:, 1], P[:, 0]] * ftpx
        return float((d <= tol_ft).mean()), len(P)

    def peak(self, transform):
        """(score, sharpness): sharpness = score / mean score of the same placement nudged 300 ft
        (8 directions) and turned +/-2 deg. A real fit stands out; a chance fit over dense linework doesn't."""
        s0, n = self.score(transform)
        aa, bb, tx, ty = transform
        alts = []
        for ang in range(0, 360, 45):
            dx, dy = 300 * math.cos(math.radians(ang)), 300 * math.sin(math.radians(ang))
            alts.append(self.score([aa, bb, tx + dx, ty + dy])[0])
        for dth in (-2, 2):
            c, s_ = math.cos(math.radians(dth)), math.sin(math.radians(dth))
            alts.append(self.score([aa * c - bb * s_, aa * s_ + bb * c, tx, ty])[0])
        m = float(np.mean(alts))
        return s0, (s0 / m if m > 0 else 0.0), n
