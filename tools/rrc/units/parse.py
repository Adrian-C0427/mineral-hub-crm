"""Text facts from a plat's OCR: control-point coordinates, unit names + called acres, scale."""
import re, math
import numpy as np

def norm(t):
    return (t.replace("Х", "X").replace("х", "x").replace("У", "Y").replace("−", "-").replace("’", "'").replace("”", '"').replace("“", '"'))

def lines(ocr, upright=False):
    """OCR lines with normalized text. When most text on the sheet runs vertically (a plat drawn
    sideways), boxes are turned upright so 'the line below' means the next line of the block."""
    L = [dict(l, text=norm(l["text"])) for l in ocr["lines"]]
    long = [l for l in L if len(l["text"]) >= 10]
    tall = sum(1 for l in long if l["box"][3] > 2.5 * l["box"][2])
    if upright and long and tall > 0.6 * len(long):
        W = ocr["width"]
        for l in L:
            x, y, w, h = l["box"]
            l["box"] = [y, W - x - w, h, w]
    return L

NUM = lambda s: float(s.replace(",", "").replace(" ", ""))

HEAD = [("SHL", r"SURFACE\s*LOC|SURF\.?\s*LOC|^SURFACE$|^SHL\b"),
        ("PP", r"PENETRATION|ENETRATION|TOP\s*PERF|FIRST\s*TAKE|^FTP\b"),
        ("BHL", r"B?OTTOM\s*HOLE|B?OTTOM\s*PERF|LAST\s*TAKE|^BHL\b|^BOTTOM$")]
VAL = re.compile(r"LATITUDE|LONGITUDE|^LAT|^LON|NAD|^X\b|^Y\b|^N\s*=|^E\s*=|STATE PLANE|GEOGRAPHIC|TX-C", re.I)

def _num_after(t, keys, lo, hi):
    u = t.upper().replace(" ", "")
    for m in re.finditer(r"(?:^|[^A-Z])(?:" + keys + r")[:=](\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{5,7}(?:\.\d+)?)", u):
        v = NUM(m.group(1))
        if lo < v < hi: return v
    return None

def _vals(t):
    """(x, y, lat, lon) found on one OCR line (any may be None)."""
    x = _num_after(t, "X|E=X|EAST(?:ING)?|E", 1_000_000, 5_000_000)
    y = _num_after(t, "Y|N=Y|NORTH(?:ING)?|N", 10_000, 2_000_000)
    lat = lon = None
    mm = re.search(r"LAT\w*\s*[:=]?\s*(\d{2}\.\d{5,})", t, re.I)
    if mm: lat = float(mm.group(1))
    mm = re.search(r"LON\w*\s*[:=]?\s*-?(\d{2,3}\.\d{5,})", t, re.I)
    if mm: lon = -float(mm.group(1))
    return x, y, lat, lon

def control_points(ocr, with_alternates=False):
    """SHL / PP / BHL from the plat's coordinate blocks: State Plane X/Y where printed, else the decimal
    NAD27 latitude/longitude of the same block converted to Texas Central State Plane.
    Blocks may read top-down (values below their heading) or, on plats drawn sideways, bottom-up."""
    L = sorted(lines(ocr, upright=True), key=lambda l: l["box"][1])
    W, H = ocr["width"], ocr["height"]
    if L and max(l["box"][1] + l["box"][3] for l in L) > H * 1.01 or (L and max(l["box"][0] for l in L) > W * 1.01): W, H = H, W
    col = 0.06 * W
    def near(l, sign, n=4):
        x, y = l["box"][0], l["box"][1]
        cand = [m for m in L if 0 < sign * (m["box"][1] - y) < 0.045 * H and abs(m["box"][0] - x) < col]
        return sorted(cand, key=lambda m: abs(m["box"][1] - y))[:n]
    heads = []
    for l in L:
        t = l["text"].upper().strip()
        if len(t) > 70: continue
        for key, pat in HEAD:
            if re.search(pat, t):
                below = any(VAL.search(m["text"].strip()) for m in near(l, +1))
                above = any(VAL.search(m["text"].strip()) for m in near(l, -1))
                if below or above: heads.append((key, l, below, above))
                break
    if not heads: return ({}, None, None, {}, {}) if with_alternates else ({}, None, None, {})
    down = sum(h[2] for h in heads) >= sum(h[3] and not h[2] for h in heads)
    sign = 1 if down else -1
    blocks = {}
    for key, h, _, _ in heads:
        hx, hy = h["box"][0], h["box"][1]
        others = [g["box"][1] for k2, g, _, _ in heads if k2 != key and abs(g["box"][0] - hx) < col and sign * (g["box"][1] - hy) > 0]
        lim = min([abs(o - hy) for o in others] + [0.14 * H])
        body = [m for m in L if 0 < sign * (m["box"][1] - hy) < lim and abs(m["box"][0] - hx) < col * 1.2]
        cur = blocks.setdefault(key, {"x": None, "y": None, "lat": None, "lon": None, "used": set()})
        for m in sorted(body, key=lambda m: abs(m["box"][1] - hy)):
            x, y, lat, lon = _vals(m["text"])
            if x and not cur["x"]: cur["x"] = x; cur["used"].add(id(m))
            if y and not cur["y"]: cur["y"] = y; cur["used"].add(id(m))
            if lat and not cur["lat"]: cur["lat"] = lat
            if lon and not cur["lon"]: cur["lon"] = lon
    U = " ".join(l["text"].upper() for l in L)
    datum = "NAD27" if re.search(r"NAD\s*27|NAD\s*1927|1927", U) else ("NAD83" if re.search(r"NAD\s*83|1983", U) else None)
    zone = "central" if re.search(r"CENTRAL|C\.\s*Z\.|C-ZONE|TX-C", U) else None
    # one point missing its heading (OCR dropped it): a leftover printed pair in the same column is that point
    missing = [k for k in ("SHL", "PP", "BHL") if not (blocks.get(k, {}).get("x") and blocks.get(k, {}).get("y"))]
    used = set().union(*[b["used"] for b in blocks.values()]) if blocks else set()
    if len(missing) == 1 and heads:
        hx = np.median([h[1]["box"][0] for h in heads]) if False else sorted(h[1]["box"][0] for h in heads)[len(heads) // 2]
        pairs = [m for m in L if id(m) not in used and abs(m["box"][0] - hx) < col * 1.2]
        pairs = [(m, _vals(m["text"])) for m in pairs]
        pairs = [(m, v) for m, v in pairs if v[0] and v[1]]
        if len(pairs) == 1:
            b = blocks.setdefault(missing[0], {"x": None, "y": None, "lat": None, "lon": None, "used": set()})
            b["x"], b["y"] = pairs[0][1][0], pairs[0][1][1]; b["fromLeftover"] = True
    from pyproj import Transformer
    ll2sp = Transformer.from_crs("EPSG:4267", "EPSG:32039", always_xy=True)
    pts, how, alts = {}, {}, {}
    for key, b in blocks.items():
        sp = (b["x"], b["y"]) if b["x"] and b["y"] else None
        ll = ll2sp.transform(b["lon"], b["lat"]) if b["lat"] and b["lon"] and datum == "NAD27" else None
        if sp: pts[key] = sp; how[key] = "state-plane" + (" (unlabelled pair)" if b.get("fromLeftover") else "")
        elif ll: pts[key] = ll; how[key] = "lat-long"
        if sp and ll and math.dist(sp, ll) > 15:
            how[key] = f"state-plane (lat/long disagrees by {math.dist(sp, ll):.0f} ft)"
            alts[key] = [sp, ll]  # one of the two was misread; the placement checks decide
    if with_alternates: return pts, datum, zone, how, alts
    return pts, datum, zone, how

def scale_ft_per_in(ocr):
    for l in lines(ocr):
        t = l["text"].upper().replace(" ", "")
        m = re.search(r'1["\']{0,2}=([\d,]{3,6})', t)
        if m and ("SCALE" in t or t.startswith("1")):
            v = NUM(m.group(1))
            if v in (200, 250, 300, 400, 500, 600, 800, 1000, 1200, 1500, 2000, 2500, 3000, 4000): return v
    return None

def called_units(ocr):
    """[(name, calledAcres, (cx, cy))] for every 'X Unit ... Called N Acres' pairing on the plat."""
    L = lines(ocr); out = []
    called = [(l, NUM(m.group(1))) for l in L for m in [re.search(r"CALLED\s*([\d,]+\.?\d*)\s*(?:AC|ACRES|AC\.)", l["text"].upper())] if m]
    for l, ac in called:
        x, y, w, h = l["box"]
        # the unit name: the nearest line above (or the same line) that mentions UNIT
        same = re.search(r"^(.*?UN(?:I)?T)\b", l["text"], re.I)
        best = None
        if same and len(same.group(1)) > 6: best = same.group(1)
        else:
            cands = [m for m in L if m is not l and re.search(r"\bUN(?:I)?T\b", m["text"], re.I) and not re.search(r"\b(IN|PER|OF) UNIT\b|TOTAL|ACREAGE|SHOWN|HEREON", m["text"], re.I)
                     and 0 <= y - m["box"][1] < 4 * h and abs((m["box"][0] + m["box"][2] / 2) - (x + w / 2)) < 2.5 * w]
            if cands: best = min(cands, key=lambda m: y - m["box"][1])["text"]
        if best and 50 <= ac <= 20000: out.append((re.sub(r"\s+", " ", best).strip(), ac, (x + w / 2, y + h / 2)))
    return out
