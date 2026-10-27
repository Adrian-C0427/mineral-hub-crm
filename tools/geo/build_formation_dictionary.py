"""Build the RRC reservoir-token → formation dictionary from the field file.
Usage: python3 -I build_formation_dictionary.py fldtpe.txt out_dir
Writes out_dir/formation-dictionary.json and out_dir/formation-dictionary-review.csv
Positions per RRC OGA040 (80-byte records): district 1-3, field number 4-11 (5 field + 3 reservoir),
county code 12-14, multi-county flag 15, class 16-20, field name 21-52.
"""
import sys, re, json, collections, csv
src, out = sys.argv[1], sys.argv[2]
raw = open(src, "rb").read()
recs = []; i = 0
while i + 80 <= len(raw):
    r = raw[i:i+80]; i += 80
    while i < len(raw) and raw[i:i+1] in (b"\r", b"\n"): i += 1
    recs.append({"district": r[0:3].decode("latin1").strip(), "fno": r[3:11].decode("latin1"), "county": r[11:14].decode("latin1"),
                 "multi": r[14:15].decode("latin1") == "*", "cls": r[15:20].decode("latin1").strip(), "name": r[20:52].decode("latin1").strip()})

# --- the reservoir token: the LAST parenthetical (closed, or truncated-open at the 32-char limit)
def token_of(name):
    m = list(re.finditer(r"\(([^()]*)(?:\)|$)", name))
    if not m: return None
    t = m[-1].group(1).strip().upper()
    return t or None

ABBR = {
    "MISS": "MISSISSIPPIAN", "MISS.": "MISSISSIPPIAN", "MISSISSIPPI": "MISSISSIPPIAN", "PENN": "PENNSYLVANIAN", "PENN.": "PENNSYLVANIAN",
    "DEV": "DEVONIAN", "DEV.": "DEVONIAN", "SIL": "SILURIAN", "ORD": "ORDOVICIAN", "MIO": "MIOCENE", "MIO.": "MIOCENE", "OLIG": "OLIGOCENE",
    "VKSBG": "VICKSBURG", "VICKS": "VICKSBURG", "ELLEN": "ELLENBURGER", "ELLEN.": "ELLENBURGER", "ELLENBERGER": "ELLENBURGER", "ELLENBURG": "ELLENBURGER",
    "EAGLEFORD": "EAGLE FORD", "CROSSCUT": "CROSS CUT", "COOK MTN": "COOK MOUNTAIN", "COOK MT": "COOK MOUNTAIN", "COOK MTN.": "COOK MOUNTAIN",
    "RECKLAW": "REKLAW", "WICHITA ALBANY": "WICHITA-ALBANY", "WICHITA": "WICHITA-ALBANY", "ALBANY": "WICHITA-ALBANY",
    "AUSTIN": "AUSTIN CHALK", "GOVT. WELLS": "GOVERNMENT WELLS", "GOVT WELLS": "GOVERNMENT WELLS", "CLEARFORK": "CLEAR FORK",
    "BEND CONGL": "BEND CONGLOMERATE", "BEND": "BEND CONGLOMERATE", "ATOKA CONGL": "ATOKA", "CADDO CONGL": "CADDO", "MARBLE FALLS CONGL": "MARBLE FALLS",
    "CANYON REEF": "CANYON", "STRAWN REEF": "STRAWN", "CISCO REEF": "CISCO", "PENN REEF": "PENNSYLVANIAN", "PENN DETRITAL": "PENNSYLVANIAN",
    "CADDO LIME": "CADDO", "MISSISSIPPI LIME": "MISSISSIPPIAN", "CAPPS LIME": "CAPPS", "EDWARDS LIME": "EDWARDS", "GOEN LIME": "GOEN",
    "FLIPPEN LIME": "FLIPPEN", "FLIPPEN SAND": "FLIPPEN", "DUFFER LIME": "DUFFER", "GARDNER LIME": "GARDNER", "GARDNER SD": "GARDNER", "GARDNER SAND": "GARDNER",
    "COTTON VALLEY LIME": "COTTON VALLEY", "COTTON VALLEY SAND": "COTTON VALLEY", "JAMES LIME": "JAMES", "BOSSIER SAND": "BOSSIER",
    "DELAWARE SAND": "DELAWARE", "CANYON SAND": "CANYON", "CANYON SD": "CANYON", "CANYON LIME": "CANYON", "STRAWN SAND": "STRAWN", "STRAWN LIME": "STRAWN",
    "KING SAND": "KING", "LAKE SAND": "LAKE", "GRAY SAND": "GRAY", "FRY SAND": "FRY", "MORRIS SAND": "MORRIS", "COOK SAND": "COOK", "JENNINGS SAND": "JENNINGS",
    "CISCO SAND": "CISCO", "HOCKLEY": "HOCKLEY", "MARG": "MARGINULINA", "MARG.": "MARGINULINA", "DISCORBIS": "DISCORBIS", "SILURO-DEVONIAN": "SILURIAN-DEVONIAN",
    "FT": None, "FS": None, "PETTET": "PETTIT", "SUBCLARKSVILLE": "SUB-CLARKSVILLE", "SUB CLARKSVILLE": "SUB-CLARKSVILLE", "SUB-CLARKSVILLE SAND": "SUB-CLARKSVILLE", "CLARKSVILLE": "SUB-CLARKSVILLE", "SLIGO": "SLIGO", "PETTIT LIME": "PETTIT", "JAMES": "JAMES LIME", "RODESSA LIME": "RODESSA", "GLEN ROSE LIME": "GLEN ROSE", "AUSTIN CHALK GAS": "AUSTIN CHALK", "EAGLEFORD SHALE": "EAGLE FORD", "EAGLE FORD SHALE": "EAGLE FORD", "HAYNESVILLE SHALE": "HAYNESVILLE", "BARNETT SHALE": "BARNETT", "WOLFCAMP SHALE": "WOLFCAMP", "BONE SPRINGS": "BONE SPRING", "SPRABERRY TREND AREA": "SPRABERRY", "TREND AREA": None, "CANYON SAND": "CANYON", "GRANITE WASH": "GRANITE WASH", "WASH": "GRANITE WASH",
}
# Words that describe a reservoir within a formation, not the formation itself.
STRIP_WORDS = {"UPPER", "LOWER", "MIDDLE", "UP", "LO", "MID", "SAND", "SD", "SANDS", "LIME", "LM", "LS", "SHALE", "SH", "CONGL", "CONGL.", "CONGLOMERATE", "REEF", "DOLOMITE", "DOL",
               "CONS", "CONS.", "CONSOLIDATED", "SEG", "ZONE", "TREND", "AREA", "TREND AREA", "FM", "FORMATION", "DETRITAL", "LIMESTONE", "SANDSTONE", "CHERT", "OIL", "GAS", "SERIES", "GROUP"}
GENERIC = {"CONGL", "CONGL.", "LM", "SD", "DOL", "CONS", "CONSOL", "SEG", "UP", "LO", "MID", "UPPER", "LOWER", "MIDDLE", "CONGLOMERATE", "CONSOLIDATED", "REEF", "LIME", "SAND", "SHALLOW", "MASSIVE", "GAS", "OIL", "DETRITAL", "STRAY", "SHALE", "SERPENTINE", "DEEP", "ZONE", ""}

TRAIL = re.compile(r"[\s,]+(?:\d{1,6}(?:-[A-Z0-9]+)?|[A-Z]-?\d+|[A-Z]|NO\.?\s*\d+|SEG\.?\s*[A-Z0-9]+|[A-Z]{1,2}-\d{1,3})$")
def normalize(t):
    t = t.upper().replace("&", "AND").strip(" ,.-")
    t = re.sub(r"\s+", " ", t)
    if t in ABBR: return ABBR[t]
    for _ in range(6):
        before = t
        t = TRAIL.sub("", t).strip(" ,.-")
        words = [w for w in re.split(r"[\s,]+", t) if w]
        core = [w for w in words if w not in STRIP_WORDS]
        t = " ".join(core)
        if t in ABBR:
            return ABBR[t]
        if t == before: break
    if not t or re.fullmatch(r"[\d\s,-]+", t) or re.fullmatch(r"[A-Z]-?\d*", t) or t in GENERIC:
        return None
    return t

tok = collections.Counter(); byname = collections.defaultdict(lambda: collections.Counter())
noparen = 0
for r in recs:
    t = token_of(r["name"])
    if t is None: noparen += 1; continue
    tok[t] += 1
    n = normalize(t)
    byname[n][t] += 1
mapping = {}; generic = []; review = []
total = sum(tok.values()); mapped = 0
for n, raws in sorted(byname.items(), key=lambda kv: -sum(kv[1].values())):
    c = sum(raws.values())
    if n is None or n in GENERIC or len(n) <= 2 or re.fullmatch(r"[A-Z]-?\d*", n):
        generic.append({"token": n, "records": c, "examples": [k for k, _ in raws.most_common(4)]}); continue
    pretty = " ".join(w.capitalize() if not re.fullmatch(r"[A-Z]+-[A-Z]+", w) else "-".join(p.capitalize() for p in w.split("-")) for w in n.split(" "))
    for raw in raws: mapping[raw] = pretty
    mapped += c
    if c < 5: review.append({"formation": pretty, "records": c, "raw_tokens": "; ".join(k for k, _ in raws.most_common(6))})
json.dump({"version": 1, "source": "RRC Oil & Gas Field Name & Numbers (fldtpe), cut 2026-10-03; normalization rules in scripts/build_formation_dictionary.py",
           "records": len(recs), "withToken": total, "mapped": mapped, "tokens": mapping, "generic": generic[:200]}, open(f"{out}/formation-dictionary.json", "w"), indent=0)
with open(f"{out}/formation-dictionary-review.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["formation", "records", "raw_tokens"]); w.writeheader(); w.writerows(review)
# county → formations (records per county code & formation) for the county table
cf = collections.Counter()
for r in recs:
    t = token_of(r["name"]); f = mapping.get(t) if t else None
    if f: cf[(r["county"], f)] += 1
json.dump([{"countyCode": k[0], "formation": k[1], "fieldReservoirs": v} for k, v in sorted(cf.items())], open(f"{out}/county-formations.json", "w"))
import gzip, datetime
fcount = collections.Counter()
for raw_t, f in mapping.items(): fcount[f] += tok[raw_t]
bundle = {"key": "tx-formations", "builtAt": datetime.date.today().isoformat(),
          "source": {"name": "RRC Oil & Gas Field Names & Numbers (fldtpe)", "asOf": "2026-10"},
          "records": len(recs), "withToken": total, "mapped": mapped,
          "tokens": mapping,
          "formations": [{"name": f, "records": c} for f, c in fcount.most_common()],
          "countyFormations": [{"fips": k[0], "formation": k[1], "fieldReservoirs": v} for k, v in sorted(cf.items()) if k[0].isdigit() and k[0] != "000"]}
gz = sys.argv[3] if len(sys.argv) > 3 else None
if gz:
    with gzip.open(gz, "wb", compresslevel=9) as g: g.write(json.dumps(bundle, separators=(",", ":")).encode())
    import os; print("bundle", gz, os.path.getsize(gz)//1000, "KB")
print(f"records {len(recs)} noparen {noparen} tokens {total} distinct raw {len(tok)} → formations {len(set(mapping.values()))}; mapped records {mapped} ({mapped/total:.1%}); generic groups {len(generic)}; review rows (<5 records) {len(review)}; county-formation pairs {len(cf)}")
print("top 60 formations by records:")
fc = collections.Counter()
for raw, f in mapping.items(): fc[f] += tok[raw]
for f, c in fc.most_common(60): print(f"  {c:6d} {f}")
