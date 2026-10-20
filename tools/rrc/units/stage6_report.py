"""Stage 6: the tables of the release report (docs/reports/pooled-units-*/README.md) from the QA outputs.

Prints Markdown: published units; well-location plats that could not be placed (with the reason);
older scanned plats that could not be placed; units whose outline failed a check.
"""
import sys, os, json, gzip
U = os.path.expanduser("~/rrc-data/unit-plats")


def main(wells_bundle):
    qa = json.load(open(f"{U}/work/bundle_qa.json"))
    inv = {m["id"]: m for m in json.load(open(f"{U}/work/inventory.json"))}
    scan = {r["id"]: r for r in json.load(open(f"{U}/work/scan.json"))}
    old = json.load(open(f"{U}/work/old_place.json")) if os.path.exists(f"{U}/work/old_place.json") else {}
    vec = json.load(open(f"{U}/work/units_sp_vector.json")) if os.path.exists(f"{U}/work/units_sp_vector.json") else []
    man = {m["newName"]: m for m in json.load(open(f"{U}/plats-manifest.json"))}
    W = {w["api8"]: w for w in json.load(gzip.open(wells_bundle))["wells"] if w["api8"]}
    well = lambda api: f"{W.get(api, {}).get('leaseName') or '?'} {W.get(api, {}).get('wellNo') or ''} (42-{api[:3]}-{api[3:]})"
    orig = lambda f: man.get(f, {}).get("origName") or f

    units = qa["units"]
    print(f"Published units: {len(units)} ({sum(u['operator'] == 'Comstock' for u in units)} Comstock, {sum(u['operator'] == 'Mitsui' for u in units)} Mitsui)")
    covered = {w["api"] for u in units for w in u["wells"]}
    print(f"Wells with at least one unit shown: {len(covered)} of {len({m['api'] for m in inv.values()})}\n")
    print("| Unit | Operator | County | Called acres | Mapped | How placed | Shown on the plat for |")
    print("|---|---|---|---|---|---|---|")
    how = {"unit-plat": "unit plat lined up on the well plat", "well-plat": "drawn on the well plat"}
    for u in sorted(units, key=lambda u: u["name"].lower()):
        p = u["placement"]
        h = "drawn on an older scanned plat (survey-line placement)" if p.get("basis") == "survey-lines" else how[p["method"]]
        d = u["_qa"]["areaDiffPct"]
        mapped = f"{d:+.2f}%" + (" (drawing differs from called acres)" if u.get("drawnVsCalledPct") is not None else "")
        ws = ", ".join(f"{w['lease']} {w['wellNo']}" for w in u["wells"])
        print(f"| {u['name']} | {u['operator']} | {u['county']} | {u['calledAcres']} | {mapped} | {h} | {ws} |")
    d = sorted(abs(u["_qa"]["areaDiffPct"]) for u in units)
    within = sum(x <= 2.5 for x in d)
    print(f"\nMapped area vs called acres: median {d[len(d) // 2]:.2f}%; {within} of {len(d)} within 2.5%; the other {len(d) - within} carry a drawn-vs-called note (worst {d[-1]:.1f}%).\n")

    print("### Well-location plats that could not be placed\n")
    print("| Well | Plat | Why |\n|---|---|---|")
    vec_ok = {c["plat"] for c in vec if (c.get("georef") or {}).get("ok")}
    for pid, r in sorted(scan.items(), key=lambda kv: inv[kv[0]]["api"]):
        m = inv[pid]
        if m["kind"] == "tif" or len(r["pts"]) < 2 or (r.get("georef") or {}).get("ok") or pid in vec_ok: continue
        g = r.get("georef") or {}
        why = g.get("why") or ("no bottom-hole coordinates read" if "BHL" not in r["pts"] else "only two control points printed" if len(r["pts"]) == 2 else "not placed")
        print(f"| {well(m['api'])} | {orig(m['file'])} | {why} |")
    print("\n### Older scanned plats (2006-2012) that could not be placed\n")
    print("| Well | Plat | Why |\n|---|---|---|")
    for pid, g in sorted(old.items(), key=lambda kv: inv[kv[0]]["api"]):
        if g.get("ok"): continue
        print(f"| {well(inv[pid]['api'])} | {orig(inv[pid]['file'])} | {g.get('why')} |")
    print("\n### Units whose outline failed a check\n")
    print("| Unit | Called acres | Why |\n|---|---|---|")
    for r in sorted(qa["rejected"], key=lambda r: r["unit"].lower()):
        print(f"| {r['unit']} | {r['calledAcres']} | {'; '.join(r['why'])} |")


if __name__ == "__main__":
    main(sys.argv[1])
