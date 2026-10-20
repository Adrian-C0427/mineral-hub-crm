"""Placement for the older scanned plats (2008-2012) whose printed coordinates can't be read.

Anchor: RRC's own surface location for the well (and its bottom hole, for a deviated well).
Search: for every rotation (1 deg) and scale (stated +/-6%), RRC's survey lines are correlated
with the plat's linework (text masked out), but only at offsets that put RRC's surface location
exactly on a drawn marker circle. The best candidates are refined about that marker and must pass:
  * survey lines: >= 50% within 30 ft and sharpness >= 1.6 (stricter than coordinate plats);
  * deviated wells whose plat prints the proposed bottom hole: it lands on a drawn marker (<= 30 ft)
    (RRC's own bottom hole is the as-drilled one, so it isn't comparable);
  * downstream, the unit outline must match its called acres within 2.5% (no drawn-vs-called
    allowance: here the acreage is the only check on the plat's scale).
"""
import sys, os, re, json, gzip, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, cv2
import georef, parse, survey_check, datum
from survey_register import plat_line_ink, _template, _render, transform_from
from pyproj import Transformer

U = os.path.expanduser("~/rrc-data/unit-plats")


def to_sp27(lon, lat, shift, _t=Transformer.from_crs("EPSG:4267", "EPSG:32039", always_xy=True)):
    lo, la = np.array([lon], float), np.array([lat], float)
    for _ in range(3):
        l83, a83 = shift.nad27_to_83(lo, la); lo, la = lo - (l83 - lon), la - (a83 - lat)
    return np.array(_t.transform(lo[0], la[0]))


SCALES = (500, 1000, 1500, 2000, 2500, 3000, 4000)


def read_scale(ocr):
    """'SCALE: 1" = 1000'' with the scan noise these sheets have ('1i', 'IỗẠạỌ' for 1")."""
    for l in ocr["lines"]:
        t = l["text"].upper().replace(" ", "")
        m = re.search(r"SCALE:?\S{0,6}?=([\d,]{3,6})", t)
        if m:
            v = float(m.group(1).replace(",", ""))
            if v in SCALES: return v
    return None


def bar_scale(ocr, dpi):
    """Scale from the bar's distance labels (0' 1000' 2000' 3000'): positions along the bar vs feet,
    snapped to a standard scale (only used to tell 1000 from 2000 when the SCALE text didn't scan)."""
    labs = []
    for l in ocr["lines"]:
        m = re.match(r"^(\d{1,2},?\d{3}|0)\s*['\u2019\"]?$", l["text"].strip())
        if m:
            v = float(m.group(1).replace(",", "")); x, y, w, h = l["box"]
            if v % 250 == 0: labs.append((v, x + w / 2, y + h / 2))
    best = None
    for i, (v, x, y) in enumerate(labs):  # a row (or column) of labels with distinct values
        row = [q for q in labs if abs(q[2] - y) < 15] if True else []
        col = [q for q in labs if abs(q[1] - x) < 15]
        for grp, k in ((row, 1), (col, 2)):
            vals = {q[0] for q in grp}
            if len(vals) < 3: continue
            A = np.array([[q[k], 1.0] for q in grp]); f = np.array([q[0] for q in grp])
            slope = abs(np.linalg.lstsq(A, f, rcond=None)[0][0])
            ft_in = slope * dpi
            snap = min(SCALES, key=lambda s: abs(s - ft_in))
            if abs(ft_in / snap - 1) < 0.08 and (best is None or len(grp) > best[1]): best = (float(snap), len(grp))
    return best[0] if best else None


def frame_free(img_bgr):
    """The plat with its sheet border painted out: long, horizontal or vertical rules (>= 20% of the sheet)
    within 8% of an edge. Left in, RRC's survey grid can lock onto the border (Gresham Trust #3 did)."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    ink = (gray < 150).astype(np.uint8) * 255
    H, W = ink.shape
    fat = cv2.dilate(ink, np.ones((7, 7), np.uint8))  # tolerate a scan's slight skew along the rule
    h = cv2.morphologyEx(fat, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (int(0.2 * W), 1)))
    v = cv2.morphologyEx(fat, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, int(0.2 * H))))
    # only the sheet border: rules lying near an edge (interior axis-aligned lines can be survey lines,
    # e.g. a plat drawn square to its surveys)
    keep = np.zeros_like(ink)
    for mask, axis, size in ((h, 0, H), (v, 1, W)):
        n, lab, stats, cent = cv2.connectedComponentsWithStats(mask, 8)
        for i in range(1, n):
            pos = cent[i][1] if axis == 0 else cent[i][0]
            if pos < 0.08 * size or pos > 0.92 * size: keep[lab == i] = 255
    rules = cv2.dilate(keep, np.ones((5, 5), np.uint8))
    out = img_bgr.copy(); out[rules > 0] = 255
    return out


def read_xy(ocr):
    """Every printed State Plane pair: [(x, y, (cx, cy))]. Thousands separators may scan as dots;
    a stray trailing glyph is dropped. Each X pairs with the nearest Y line just below it."""
    X, Y = [], []
    for l in ocr["lines"]:
        t = l["text"].strip()
        m = re.match(r"^([XxYy])\s*[:;=.]\s*([\d][\d.,\s]{4,12}\d)", t)
        if not m: continue
        digits = re.sub(r"[^\d]", "", m.group(2))
        bx, by, bw, bh = l["box"]
        if m.group(1) in "Xx" and len(digits) == 7 and 1_000_000 < int(digits) < 5_000_000: X.append((float(digits), (bx + bw / 2, by + bh / 2), max(bw, bh)))
        if m.group(1) in "Yy" and len(digits) == 6 and 10_000 < int(digits) < 2_000_000: Y.append((float(digits), (bx + bw / 2, by + bh / 2), max(bw, bh)))
    out = []
    for x, cx, sz in X:
        near = [(math.dist(cx, cy), y, cy) for y, cy, _ in Y if math.dist(cx, cy) < 3 * sz]
        if near: _, y, _ = min(near); out.append((x, y, cx))
    return out


def place(pid, inv_m, ocr, well, bore, seg, shift, f=1 / 6):
    img = cv2.imread(f"{U}/work/img/{pid}.png"); gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    rrc_shl = to_sp27(well["lon"], well["lat"], shift)
    rrc_bhl = to_sp27(*bore["bh"], shift) if bore else None
    printed = [np.array(p[:2]) for p in read_xy(ocr)]
    # The plat marks the PROPOSED bottom hole; RRC's is as drilled (often 50-800 ft away), so only a
    # printed bottom hole is checked against a drawn marker.
    bhl = None
    if rrc_bhl is not None:
        cand = [p for p in printed if math.dist(p, rrc_shl) > 150 and math.dist(p, rrc_bhl) < 3000]
        if cand: bhl = min(cand, key=lambda p: math.dist(p, rrc_bhl))
    # anchors: the plat's own printed surface location when it reads (and is near RRC's), else RRC's
    anchors = [p for p in printed if math.dist(p, rrc_shl) < 1500]
    anchors = sorted(anchors, key=lambda a: math.dist(a, rrc_shl))[:1]
    if not anchors or math.dist(anchors[0], rrc_shl) > 20: anchors.append(rrc_shl)
    scales = sorted({s for s in (read_scale(ocr), bar_scale(ocr, inv_m["dpi"])) if s}) or [1000.0, 2000.0]
    best_all = None
    for shl in anchors:
        r = _place_at(img, gray, ocr, inv_m, shl, bhl, scales, seg, f)
        r["anchor"] = "printed surface location" if shl is not rrc_shl else "RRC surface location"
        r["anchorFromRrcFt"] = round(math.dist(shl, rrc_shl), 1)
        if best_all is None or (r.get("ok"), (r.get("surveyMatch") or 0) * (r.get("surveySharpness") or 0)) > (best_all.get("ok"), (best_all.get("surveyMatch") or 0) * (best_all.get("surveySharpness") or 0)): best_all = r
    return best_all


def _place_at(img, gray, ocr, inv_m, shl, bhl, scales, seg, f):
    dpi = inv_m["dpi"]
    if bhl is not None and math.dist(shl, bhl) < 150: bhl = None
    cs = georef.circles(gray, dpi)
    H, W = gray.shape
    cs = [c for c in cs if 0.05 * W < c[0] < 0.95 * W and 0.04 * H < c[1] < 0.96 * H]
    # (circles inside OCR text boxes are NOT dropped: label boxes often take in the well marker beside them)
    img = frame_free(img)
    if not cs: return {"ok": False, "why": "no marker circles"}
    C = np.array([c[:2] for c in cs])
    T = _template(plat_line_ink(img, ocr), f)
    radius = 0.85 * math.hypot(W, H) * (2100 / dpi)  # survey lines kept: reach of a 1"=2000' sheet
    keep = (np.hypot(*(seg[0] - shl).T) < radius) | (np.hypot(*(seg[1] - shl).T) < radius)
    sa, sb = seg[0][keep], seg[1][keep]
    if len(sa) < 30: return {"ok": False, "why": "too few RRC survey lines nearby"}
    cands = []
    for sc in scales:
        for ds in np.linspace(-0.04, 0.04, 5):
            ftpx = sc * (1 + ds) / dpi
            rad = 0.8 * math.hypot(W, H) * ftpx   # the sheet's reach from any point on it
            size = int(2 * rad / (ftpx / f))
            if size <= max(T.shape) + 4: continue
            for deg in range(0, 360, 1):
                th = math.radians(deg)
                R = _render(sa, sb, shl, th, ftpx, f, size)
                res = cv2.matchTemplate(R, T, cv2.TM_CCORR)
                locs = np.round(size / 2 - C * f).astype(int)  # offsets putting RRC's SHL on each circle
                ok = (locs[:, 0] >= 0) & (locs[:, 0] < res.shape[1]) & (locs[:, 1] >= 0) & (locs[:, 1] < res.shape[0])
                if not ok.any(): continue
                v = np.full(len(C), -1.0); v[ok] = res[locs[ok, 1], locs[ok, 0]]
                j = int(np.argmax(v))
                cands.append((v[j] / (T.sum() + 1e-6), th, ftpx, tuple(locs[j]), size, j))
    if not cands: return {"ok": False, "why": "no candidate placement"}
    cands.sort(key=lambda c: -c[0])
    scorer = survey_check.SurveyScorer(img, *seg)
    best = None
    for score, th, ftpx, loc, size, j in cands[:12]:
        tr = transform_from(th, ftpx, shl, f, size, loc)
        # exact: SHL on the circle center
        cx, cy = C[j]
        X, Y = georef.apply(tr, cx, -cy); tr[2] += shl[0] - X; tr[3] += shl[1] - Y
        # refine rotation/scale about the marker
        cur = scorer.score(tr)[0]
        for _ in range(40):
            imp = False
            for dth, dsc in ((0.002, 0), (-0.002, 0), (0, 0.002), (0, -0.002)):
                a, b = tr[0], tr[1]; ang = math.atan2(b, a) + dth; mag = math.hypot(a, b) * (1 + dsc)
                q = [mag * math.cos(ang), mag * math.sin(ang), 0, 0]
                X, Y = georef.apply(q, cx, -cy); q[2], q[3] = shl[0] - X, shl[1] - Y
                v = scorer.score(q)[0]
                if v > cur: tr, cur, imp = q, v, True
            if not imp: break
        s0, sharp, n = scorer.peak(tr)
        bh_ft = None
        if bhl is not None:
            px = survey_check.sp_to_px(tr, bhl[None, :])[0]
            d = np.hypot(C[:, 0] - px[0], C[:, 1] - px[1]); k = int(np.argmin(d))
            bh_ft = float(d[k] * math.hypot(tr[0], tr[1]))
        key = s0 * sharp
        if best is None or key > best[0]: best = (key, tr, s0, sharp, n, bh_ft, C[j])
    _, tr, s0, sharp, n, bh_ft, c = best
    out = {"transform": list(map(float, tr)), "ftPerPx": math.hypot(tr[0], tr[1]), "rotationDeg": math.degrees(math.atan2(tr[1], tr[0])),
           "impliedScale": math.hypot(tr[0], tr[1]) * dpi, "surveyMatch": round(s0, 3), "surveySharpness": round(sharp, 2), "surveySamples": n,
           "printedBhlOnMarkerFt": None if bh_ft is None else round(bh_ft, 1), "shlMarkerPx": [float(c[0]), float(c[1])], "residualFt": {"SHL": 0.0},
           "markersFrom": "RRC surface location on a drawn marker", "pixels": {"SHL": [float(c[0]), float(c[1])]}}
    why = []
    if not (s0 >= 0.5 and sharp >= 1.6): why.append(f"survey lines {s0:.0%}, sharpness {sharp:.2f}")
    if bh_ft is not None and bh_ft > 30: why.append(f"printed bottom hole lands {bh_ft:.0f} ft from the nearest drawn marker")
    out["ok"] = not why
    if why: out["why"] = "; ".join(why)
    return out


def _job_top(a):
    (m, w, bore), seg, shift = a
    return m, place(m["id"], m, json.load(open(f"{U}/work/ocr/{m['id']}.json")), w, bore, seg, shift)


if __name__ == "__main__":
    wells = json.load(gzip.open(sys.argv[1]))
    W_ = {w["api8"]: w for w in wells["wells"] if w["api8"]}
    B = {}
    for b in wells["bores"]: B.setdefault(b["surfaceFid"], []).append(b)
    inv = json.load(open(f"{U}/work/inventory.json"))
    seg = survey_check.abstract_lines_sp(f"{U}/work/tx-rrc-abstracts.json.gz")
    shift = datum.default_shift()
    only = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
    jobs = []
    for m in inv:
        if m["kind"] != "tif" or (only and m["id"] not in only): continue
        w = W_.get(m["api"])
        if not w: continue
        jobs.append((m, w, (B.get(w["fid"]) or [None])[0]))
    from concurrent.futures import ProcessPoolExecutor
    res = {}
    with ProcessPoolExecutor(max_workers=8) as ex:
        for m, r in ex.map(_job_top, [(a, seg, shift) for a in jobs]):
            res[m["id"]] = r
            print(m["file"][:60], "|", r.get("ok"), r.get("why", ""), "| anchor", r.get("anchor"), r.get("anchorFromRrcFt"), "| rot", round(r.get("rotationDeg") or 0, 1), "scale", round(r.get("impliedScale") or 0), "survey", r.get("surveyMatch"), "sharp", r.get("surveySharpness"), "printed bhl", r.get("printedBhlOnMarkerFt"), flush=True)
    out = f"{U}/work/old_place.json"
    prev = json.load(open(out)) if os.path.exists(out) else {}
    prev.update(res); json.dump(prev, open(out, "w"), indent=1)
