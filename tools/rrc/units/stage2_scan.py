"""Stage 2: per plat, parse coordinates/scale/unit labels; place well-location plats from their control points."""
import sys, os, json, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from concurrent.futures import ProcessPoolExecutor
import parse, georef, survey_check

U = os.path.expanduser("~/rrc-data/unit-plats")
ABSTRACTS = os.environ.get("RRC_ABSTRACTS", os.path.expanduser("~/rrc-data/unit-plats/work/tx-rrc-abstracts.json.gz"))
SEG = None
def job(m):
    global SEG
    if SEG is None: SEG = survey_check.abstract_lines_sp(ABSTRACTS)
    ocr = json.load(open(f"{U}/work/ocr/{m['id']}.json"))
    pts, datum, zone, how = parse.control_points(ocr)
    r = {"id": m["id"], "pts": pts, "ptsFrom": how, "datum": datum, "zone": zone, "scale": parse.scale_ft_per_in(ocr), "units": parse.called_units(ocr)}
    if len(pts) >= 2 and "BHL" in pts:
        g = georef.solve(f"{U}/work/img/{m['id']}.png", pts, r["scale"], m["dpi"], survey_segments=SEG)
        r["georef"] = g
    return r

if __name__ == "__main__":
    inv = json.load(open(f"{U}/work/inventory.json"))
    with ProcessPoolExecutor(max_workers=8) as ex: res = list(ex.map(job, inv))
    json.dump(res, open(f"{U}/work/scan.json", "w"), indent=1, default=float)
    wl = [r for r in res if len(r["pts"]) >= 2]
    ok = [r for r in wl if r.get("georef", {}).get("ok")]
    print("plats with control points:", len(wl), "| placed from circles:", len(ok), "| plats with unit labels:", sum(1 for r in res if r["units"]))
    good = [r for r in ok if max(r["georef"]["residualFt"].values()) <= 25]
    print("placed with all residuals <= 25 ft:", len(good))
