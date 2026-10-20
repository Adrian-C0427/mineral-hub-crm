"""NAD27 Texas Central State Plane (US ft) -> NAD83 lon/lat, the way Mineral Hub converts RRC geometry.

State Plane -> NAD27 lon/lat is an exact projection (pyproj, EPSG:32039 -> EPSG:4267).
NAD27 -> NAD83 uses RRC's OWN conversion: every RRC well carries both LAT27/LONG27 and
LAT83/LONG83, and a per-county least-squares quadratic surface through those pairs
reproduces RRC's shift to a fraction of a foot (same method as server/src/ingest/refresh/datum.ts).
"""
import io, os, zipfile
import numpy as np
np.seterr(all='ignore')
import shapefile  # pyshp
from pyproj import Transformer

_SP = Transformer.from_crs("EPSG:32039", "EPSG:4267", always_xy=True)
FT_PER_DEG_LAT = 364_000.0


def _wells(zip_path):
    z = zipfile.ZipFile(zip_path)
    base = [n[:-4] for n in z.namelist() if n.endswith("s.dbf")][0]
    r = shapefile.Reader(dbf=io.BytesIO(z.read(base + ".dbf")))
    names = [f[0] for f in r.fields[1:]]
    rows = []
    for rec in r.iterRecords():
        d = dict(zip(names, rec))
        try:
            p = [float(d["LONG27"]), float(d["LAT27"]), float(d["LONG83"]), float(d["LAT83"])]
        except (KeyError, TypeError, ValueError):
            continue
        if -99 < p[0] < -93 and 28 < p[1] < 34 and -99 < p[2] < -93 and 28 < p[3] < 34:
            rows.append(p)
    return np.array(rows)


def _terms(x, y):
    return np.stack([np.ones_like(x), x, y, x * x, x * y, y * y], 1)


class Shift:
    def __init__(self, zip_paths):
        P = np.vstack([_wells(z) for z in zip_paths])
        self.x0, self.y0 = P[:, 0].mean(), P[:, 1].mean()
        A = _terms(P[:, 0] - self.x0, P[:, 1] - self.y0)
        dlon, dlat = P[:, 2] - P[:, 0], P[:, 3] - P[:, 1]
        keep = np.ones(len(P), bool)
        for _ in range(3):  # drop wells whose two published pairs disagree (re-spotted in one datum)
            self.cx, *_ = np.linalg.lstsq(A[keep], dlon[keep], rcond=None)
            self.cy, *_ = np.linalg.lstsq(A[keep], dlat[keep], rcond=None)
            res = np.hypot((A @ self.cx - dlon) * FT_PER_DEG_LAT * np.cos(np.radians(P[:, 1])), (A @ self.cy - dlat) * FT_PER_DEG_LAT)
            keep = res < max(2.0, np.percentile(res[keep], 90) * 3)
        r = np.sort(res[keep])
        self.inliers, self.total = int(keep.sum()), len(P)
        self.p50, self.p90 = float(r[len(r) // 2]), float(r[int(0.9 * (len(r) - 1))])

    def nad27_to_83(self, lon, lat):
        A = _terms(np.asarray(lon) - self.x0, np.asarray(lat) - self.y0)
        return lon + A @ self.cx, lat + A @ self.cy


def sp27_to_lonlat83(xy, shift):
    xy = np.asarray(xy, float)
    lon27, lat27 = _SP.transform(xy[:, 0], xy[:, 1])
    lon83, lat83 = shift.nad27_to_83(np.asarray(lon27), np.asarray(lat27))
    return np.stack([lon83, lat83], 1)


def default_shift():
    d = os.path.expanduser("~/rrc-data/2026-10")
    return Shift([f"{d}/well289.zip", f"{d}/well161.zip"])
