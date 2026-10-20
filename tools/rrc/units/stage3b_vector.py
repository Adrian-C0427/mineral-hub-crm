"""Stage 3b: Mitsui (Bowman) plats — the unit is drawn as a heavy BLACK dashed outline and the
well path as red filled shapes.

Placement comes from the drawn red path (vector_place.py, confirmed against RRC's survey lines);
the outline from ink at least ~3.5 pt thick (only the heavy dashes survive), gaps between dashes
closed, enclosed region filled. The outline's area is checked against the plat's own acreage
label, picked as the label closest to the well's W-1 unit acres (so a tract row can't pose as
the total).
"""
import sys, os, re, json, gzip, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, cv2, fitz
from outline3 import fill_holes_region
from stage3_units import px_to_sp, area_ac
import vector_place, survey_check

U = os.path.expanduser("~/rrc-data/unit-plats")
INV = {m["id"]: m for m in json.load(open(f"{U}/work/inventory.json"))}
SCAN = {r["id"]: r for r in json.load(open(f"{U}/work/scan.json"))}
MITSUI = {"16134869", "16134870", "16134872", "28932204", "28932207", "28932220"}


def acres_labels(ocr):
    out = []
    for l in ocr["lines"]:
        t = l["text"].upper().replace(",", "")
        for m in re.finditer(r"(\d{2,5}\.\d{1,4})\s*(?:CALLED\s*)?AC", t):
            out.append(float(m.group(1)))
    return out


def heavy_dash_mask(gray, dpi):
    k = int(round(3.2 / 72 * dpi)) | 1
    dark = (gray < 110).astype(np.uint8) * 255
    return cv2.morphologyEx(dark, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))


def do(pid, seg, w1_acres):
    m = INV[pid]; dpi = m["dpi"]
    base = {"plat": pid, "file": m["file"], "api": m["api"], "permit": m["permit"], "kind": "well-plat"}
    pts = SCAN[pid]["pts"]
    page = fitz.open(f"{U}/plats/{m['file']}")[0]
    img = cv2.imread(f"{U}/work/img/{pid}.png"); gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = vector_place.place(page, img, pts, SCAN[pid]["scale"], dpi, survey_check.SurveyScorer(img, *seg, ink_below=200))
    if not g.get("ok"): return dict(base, fail=f"placement: {g.get('why')}", georef=g)
    mask = heavy_dash_mask(gray, dpi)
    comp = None
    for k in (31, 45, 61, 81, 101, 121):  # acreage + completeness gate whatever the bridging produces
        closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        comp, hole = fill_holes_region(closed)
        if comp is not None and hole > 20000 * (dpi / 300) ** 2: break
        comp = None
    if comp is None: return dict(base, fail="heavy dashed outline does not close", georef=g)
    comp = cv2.morphologyEx(comp, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21)))
    cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    outer = max(cnts, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
    # the outline is the dash centerline: half a dash (~2.45 pt) inside the outer edge
    halfw_ft = 2.45 / 72 * dpi * g["ftPerPx"]
    sp = px_to_sp(g["transform"], outer)
    from shapely.geometry import Polygon
    mapped = Polygon(sp).buffer(-halfw_ft, join_style=2).area / 43560
    labels = acres_labels(json.load(open(f"{U}/work/ocr/{pid}.json")))
    called = min(labels, key=lambda a: abs(a - w1_acres)) if labels and w1_acres else None
    H, W = gray.shape
    clipped = bool(outer[:, 0].min() <= 3 or outer[:, 1].min() <= 3 or outer[:, 0].max() >= W - 4 or outer[:, 1].max() >= H - 4)
    # completeness: share of the heavy-dash marking (text removed) along the traced outline
    from outline3 import trace_completeness
    # only dash-shaped marks count (small, elongated): not the scale bar, north arrow or title block
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    dash_mask = np.zeros_like(mask)
    for i in range(1, n):
        a_ = stats[i, cv2.CC_STAT_AREA]
        if not (200 * (dpi / 300) ** 2 <= a_ <= 4000 * (dpi / 300) ** 2): continue
        ys, xs = np.nonzero(lab == i)
        (_, _), (w, h), _ = cv2.minAreaRect(np.c_[xs, ys].astype(np.float32))
        if max(w, h) >= 2.0 * max(1.0, min(w, h)): dash_mask[lab == i] = 255
    comp = trace_completeness(img, outer, dash_mask, json.load(open(f"{U}/work/ocr/{pid}.json")), dpi)
    return dict(base, name=None, calledAcres=called, w1Acres=w1_acres, mappedAcres=round(mapped, 2), completeness=round(comp, 3),
                mappedDiffPct=round(100 * (mapped - called) / called, 2) if called else None, clipped=clipped,
                controlResidualFt=max(g["residualFt"].values()), halfWidthFt=round(halfw_ft, 2), georef=g,
                sp=sp[:: max(1, len(sp) // 4000)].round(2).tolist())


if __name__ == "__main__":
    wells = {w["api8"]: w for w in json.load(gzip.open(sys.argv[1]))["wells"] if w["api8"]}
    seg = survey_check.abstract_lines_sp(f"{U}/work/tx-rrc-abstracts.json.gz")
    ids = [pid for pid, m in INV.items() if m["api"] in MITSUI and m.get("vector") and len(SCAN[pid]["pts"]) >= 3]  # incl. O. Henson + JBC Ranch now
    res = [do(pid, seg, wells.get(INV[pid]["api"], {}).get("unitAcres")) for pid in ids]
    json.dump(res, open(f"{U}/work/units_sp_vector.json", "w"))
    for r in res:
        print(r["file"][:58], "|", r.get("fail") or f"called {r['calledAcres']} (W-1 {r['w1Acres']}) | mapped {r['mappedAcres']} ({r['mappedDiffPct']:+}%) | clipped {r['clipped']} | residual {r['controlResidualFt']:.1f} ft")
