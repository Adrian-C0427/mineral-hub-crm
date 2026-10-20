"""Stage 1: rasterize every plat (PDF at 300 dpi, TIF at native dpi) and OCR it with macOS Vision."""
import sys, os, re, json, subprocess
from concurrent.futures import ProcessPoolExecutor
import fitz
from PIL import Image

U = os.path.expanduser("~/rrc-data/unit-plats")
PLATS, IMG, OCR = f"{U}/plats", f"{U}/work/img", f"{U}/work/ocr"
NAME = re.compile(r"^(\d{3})-(\d{5})_(.+?)_permit(\d+)(?:_(\d+))?_(.+)$")

def job(f):
    m = NAME.match(f)
    api = m.group(1) + m.group(2); permit = m.group(4); rid = m.group(5) or f"{permit}-x"
    out_img = f"{IMG}/{rid}.png"; out_ocr = f"{OCR}/{rid}.json"
    meta = {"id": rid, "file": f, "api": api, "permit": permit, "orig": m.group(6)}
    src = f"{PLATS}/{f}"
    if f.lower().endswith(".pdf"):
        doc = fitz.open(src); pg = doc[0]
        meta.update(kind="pdf", vector=len(pg.get_drawings()) > 300 and not pg.get_images(), pageW=pg.rect.width, pageH=pg.rect.height, rotation=pg.rotation, dpi=300)
        if not os.path.exists(out_img): pg.get_pixmap(dpi=300).save(out_img)
    else:
        im = Image.open(src); dpi = im.info.get("dpi", (150, 150))[0]
        meta.update(kind="tif", vector=False, dpi=float(dpi), px=im.size)
        if not os.path.exists(out_img): im.convert("RGB").save(out_img)
    if not os.path.exists(out_ocr):
        r = subprocess.run([f"{U}/tools/ocr", out_img], capture_output=True, timeout=600)
        if r.returncode == 0: open(out_ocr, "wb").write(r.stdout)
        else: meta["ocrError"] = r.stderr.decode()[:300]
    return meta

if __name__ == "__main__":
    files = sorted(f for f in os.listdir(PLATS) if NAME.match(f))
    with ProcessPoolExecutor(max_workers=6) as ex:
        inv = list(ex.map(job, files))
    json.dump(inv, open(f"{U}/work/inventory.json", "w"), indent=1)
    print("plats:", len(inv), "| ocr errors:", sum(1 for m in inv if "ocrError" in m), "| vector pdfs:", sum(1 for m in inv if m.get("vector")))
