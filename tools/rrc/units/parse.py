"""Text facts from a plat's OCR: control-point coordinates, unit names + called acres, scale."""
import re, math

def norm(t):
    return (t.replace("Х", "X").replace("х", "x").replace("У", "Y").replace("−", "-").replace("’", "'").replace("”", '"').replace("“", '"'))

def lines(ocr):
    return [dict(l, text=norm(l["text"])) for l in ocr["lines"]]

NUM = lambda s: float(s.replace(",", "").replace(" ", ""))

HEAD = [("SHL", r"SURFACE\s*LOC|SURF\.?\s*LOC|^SURFACE$|^SHL\b"), ("PP", r"PENETRATION|TOP\s*PERF|FIRST\s*TAKE|^FTP\b"), ("BHL", r"BOTTOM\s*HOLE|BOTTOM\s*PERF|LAST\s*TAKE|^BHL\b")]
VAL = re.compile(r"LATITUDE|LONGITUDE|^LAT|^LON|NAD|^X\b|^Y\b|^N\s*=|^E\s*=|STATE PLANE|GEOGRAPHIC", re.I)

def _num_after(t, keys, lo, hi):
    u = t.upper().replace(" ", "")
    for m in re.finditer(r"(?:^|[^A-Z])(?:" + keys + r")[:=](\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{5,7}(?:\.\d+)?)", u):
        v = NUM(m.group(1))
        if lo < v < hi: return v
    return None

def control_points(ocr):
    """SHL / PP / BHL from the plat's coordinate blocks: State Plane X/Y where printed, else the decimal
    NAD27 latitude/longitude of the same block converted to Texas Central State Plane."""
    W, H = ocr["width"], ocr["height"]; L = sorted(lines(ocr), key=lambda l: l["box"][1])
    def below(l, n=4):
        x, y = l["box"][0], l["box"][1]
        return [m for m in L if 0 < m["box"][1] - y < 0.035 * H * n / 4 and abs(m["box"][0] - x) < 0.05 * W][:n]
    heads = []
    for l in L:
        t = l["text"].upper().strip()
        if len(t) > 70: continue
        for key, pat in HEAD:
            if re.search(pat, t) and any(VAL.search(m["text"].strip()) for m in below(l)):
                heads.append((key, l)); break
    blocks = {}
    for key, h in heads:
        hx, hy = h["box"][0], h["box"][1]
        nxt = min([g["box"][1] for k2, g in heads if k2 != key and g["box"][1] > hy and abs(g["box"][0] - hx) < 0.05 * W] + [hy + 0.14 * H])
        body = [m for m in L if hy < m["box"][1] < nxt and abs(m["box"][0] - hx) < 0.06 * W]
        x = y = lat = lon = None
        for m in body:
            t = m["text"]
            x = x or _num_after(t, "X|E=X|EAST(?:ING)?|E", 1_000_000, 5_000_000)
            y = y or _num_after(t, "Y|N=Y|NORTH(?:ING)?|N", 10_000, 2_000_000)
            mm = re.search(r"LAT\w*\s*[:=]?\s*(\d{2}\.\d{5,})", t, re.I)
            if mm and not lat: lat = float(mm.group(1))
            mm = re.search(r"LON\w*\s*[:=]?\s*-?(\d{2,3}\.\d{5,})", t, re.I)
            if mm and not lon: lon = -float(mm.group(1))
        cur = blocks.setdefault(key, {"x": None, "y": None, "lat": None, "lon": None})
        if not (cur["x"] and cur["y"]) and x and y: cur["x"], cur["y"] = x, y
        if not (cur["lat"] and cur["lon"]) and lat and lon: cur["lat"], cur["lon"] = lat, lon
    U = " ".join(l["text"].upper() for l in L)
    datum = "NAD27" if re.search(r"NAD\s*27|NAD\s*1927|1927", U) else ("NAD83" if re.search(r"NAD\s*83|1983", U) else None)
    zone = "central" if re.search(r"CENTRAL|C\.\s*Z\.|C-ZONE|TX-C", U) else None
    pts, how = {}, {}
    for key, b in blocks.items():
        if b["x"] and b["y"]: pts[key] = (b["x"], b["y"]); how[key] = "state-plane"
        elif b["lat"] and b["lon"] and datum == "NAD27":
            from pyproj import Transformer
            X, Y = Transformer.from_crs("EPSG:4267", "EPSG:32039", always_xy=True).transform(b["lon"], b["lat"])
            pts[key] = (X, Y); how[key] = "lat-long"
    # a block's X/Y and lat/long must agree when both are printed (catches misread digits)
    for key, b in blocks.items():
        if key in pts and how[key] == "state-plane" and b["lat"] and b["lon"] and datum == "NAD27":
            from pyproj import Transformer
            X, Y = Transformer.from_crs("EPSG:4267", "EPSG:32039", always_xy=True).transform(b["lon"], b["lat"])
            if math.dist((X, Y), pts[key]) > 15: how[key] = f"state-plane (lat/long disagrees by {math.dist((X, Y), pts[key]):.0f} ft)"
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
