import { useCallback, useEffect, useMemo, useState } from "react";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { api } from "../api/client";
import { abstractNumber, abstractShortLabel, countyLabel, formatAbstract, isSectionLabel, rankAbstracts, sectionNumber, stateName, surveyLabel } from "../lib/abstracts";
import { mapCountyKey } from "../lib/counties";

/** A GIS cadastral unit: a Texas abstract, or a Louisiana PLSS section (state "LA",
 *  abstract "Sec 12", survey = township/range "T17N R13W"). */
export interface AbstractEntry { id: string; abstract: string; survey: string; county: string; countyFips: string; state?: string }

// Module-level cache so the index loads at most once per session. Served from
// PostGIS via the GIS API (see docs/architecture/0003-gis-scale-architecture.md).
let cache: AbstractEntry[] | null = null;
let inflight: Promise<AbstractEntry[]> | null = null;
function loadIndex(): Promise<AbstractEntry[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api.get<AbstractEntry[]>("/gis/abstracts-index")
      .then((rows) => { cache = rows; return cache; })
      .catch(() => { cache = []; return []; });
  }
  return inflight;
}

/** Selector label for a GIS abstract entry: "A-3 · W. Dwight Survey" (the county is already chosen). */
export function abstractEntryShortLabel(e: AbstractEntry): string {
  return abstractShortLabel({ abstract: e.abstract, survey: e.survey });
}

/**
 * The GIS abstract index, for labelling abstracts known only by id or by
 * county + number (research records, map filters, well identities).
 */
export function useAbstractIndex() {
  const [entries, setEntries] = useState<AbstractEntry[]>(cache ?? []);
  useEffect(() => { if (!cache) loadIndex().then(setEntries); }, []);
  return useMemo(() => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    // Keyed by state too: county names repeat across states (Sabine TX / LA).
    // A key shared by several entries (a section number recurs in every
    // township of a parish) is ambiguous, so it resolves to nothing.
    const byCountyNum = new Map<string, AbstractEntry | null>();
    const byNum = new Map<string, AbstractEntry[]>();
    for (const e of entries) {
      const n = abstractNumber(e.abstract);
      const k = `${(e.state ?? "TX").toUpperCase()}|${e.county.toLowerCase()}|${n}`;
      byCountyNum.set(k, byCountyNum.has(k) ? null : e);
      byNum.set(n, [...(byNum.get(n) ?? []), e]);
    }
    /** The entry for an abstract number in a county (research cells carry no GIS id). */
    const find = (abstract: string | null | undefined, county?: string | null, state?: string | null): AbstractEntry | undefined => {
      const n = abstractNumber(abstract);
      // GIS coverage is Texas + Louisiana; anything not explicitly Louisiana
      // resolves against Texas, as before (state spellings vary in records).
      const st = /^(la|louisiana)$/i.test((state ?? "").trim()) || (!state && isSectionLabel(abstract)) ? "LA" : "TX";
      if (county) return byCountyNum.get(`${st}|${county.toLowerCase()}|${n}`) ?? undefined;
      const hits = byNum.get(n);
      return hits && hits.length === 1 ? hits[0] : undefined;
    };
    /** Label an abstract by number (+ county/state when known), filling in the survey from the index. */
    const label = (abstract: string | null | undefined, county?: string | null, state?: string | null): string => {
      const e = find(abstract, county, state);
      return formatAbstract({ abstract, survey: e?.survey, county: county ?? e?.county, state: state ?? e?.state ?? (e ? "TX" : null) });
    };
    /**
     * Label a bare abstract number/label that may exist in several counties
     * (map filter options): the full label when one entry matches within
     * `counties` (map county keys — "Leon", "LA|Caddo"; all when empty), else
     * the number with where it occurs.
     */
    const labelAmong = (abstract: string, counties: string[] = []): string => {
      const n = abstractNumber(abstract);
      const cset = new Set(counties.map((c) => c.toLowerCase()));
      const hits = (byNum.get(n) ?? []).filter((e) => cset.size === 0 || cset.has(mapCountyKey(e.county, e.state).toLowerCase()));
      if (hits.length === 1) return abstractEntryShortLabel(hits[0]);
      if (hits.length === 0) return abstractShortLabel({ abstract });
      if (isSectionLabel(abstract)) {
        // A section number recurs in every township: say how many and where.
        const ps = [...new Set(hits.map((e) => e.county))].sort();
        const where = ps.length <= 3 ? `${ps.join(", ")} ${ps.length === 1 ? "Parish" : "Parishes"}` : `${ps.length} parishes`;
        return `Sec ${sectionNumber(abstract)} · ${hits.length} townships · ${where}, ${stateName(hits[0].state ?? "LA")}`;
      }
      // The same number in several counties: say where, since it's ambiguous.
      const cs = [...new Set(hits.map((e) => e.county))].sort();
      const where = cs.length <= 3 ? `${cs.join(", ")} ${cs.length === 1 ? "County" : "Counties"}` : `${cs.length} counties`;
      return `A-${n} · ${hits.length} surveys · ${where}, ${stateName(hits[0].state ?? "TX")}`;
    };
    return { entries, byId, find, label, labelAmong };
  }, [entries]);
}

/** Selector labels ("A-3 · W. Dwight Survey") for GIS abstract ids, "; "-separated
 *  (the raw id while the index loads). Shown beside the record's County. */
export function useAbstractLabels(ids: string[] | null | undefined): string {
  const { byId } = useAbstractIndex();
  return useMemo(() => {
    if (!ids || ids.length === 0) return "—";
    return ids.map((id) => { const e = byId.get(id); return e ? abstractEntryShortLabel(e) : id; }).join("; ");
  }, [ids, byId]);
}

/**
 * Cascading Survey selector — the last step of State → County → Abstract →
 * Survey. Options are the surveys of the currently-selected abstract(s) only.
 * While editing, each survey shows with its abstract so similarly-named
 * surveys are distinguishable; the stored value is just the survey name (so the
 * saved record displays the name alone).
 */
export function SurveyMultiPicker({ value, onChange, abstractIds }: {
  value: string[];
  onChange: (surveys: string[]) => void;
  abstractIds: string[];
}) {
  const { entries } = useAbstractIndex();
  const idSet = useMemo(() => new Set(abstractIds), [abstractIds]);

  const labels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const e of entries) {
      if (!idSet.has(e.id) || !e.survey || out[e.survey]) continue;
      out[e.survey] = `${surveyLabel(e.survey)} · ${isSectionLabel(e.abstract) ? `Sec ${sectionNumber(e.abstract)}` : `A-${abstractNumber(e.abstract)}`}`;
    }
    return out;
  }, [entries, idSet]);
  // A previously-saved survey whose abstract is no longer selected stays selected.
  const options = useMemo(() => [...new Set([...Object.keys(labels), ...value])], [labels, value]);

  return (
    <SearchableMultiSelect
      options={options}
      labels={labels}
      value={value}
      onChange={(next) => onChange([...new Set(next)])}
      placeholder={abstractIds.length === 0 ? "Select abstract(s) first" : "Select surveys…"}
    />
  );
}

/**
 * Searchable multi-select of abstracts (and Louisiana sections), limited to the
 * selected counties within the selected states (Texas when no state is chosen,
 * matching the county list) and locked until at least one county is chosen. Stores GIS ids; shows each as
 * "A-3 · W. Dwight Survey" (the county is already chosen — it's appended only
 * when several counties are selected, to tell same-numbered abstracts apart),
 * and ranks typed searches by abstract number (exact match first, then ascending).
 */
export function AbstractMultiPicker({
  value,
  onChange,
  counties,
  states = [],
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  counties: string[];
  /** The record's states — county names repeat across states (Sabine TX / Sabine LA). */
  states?: string[];
}) {
  const { entries, byId } = useAbstractIndex();
  const countySet = useMemo(() => new Set(counties.map((c) => c.toLowerCase())), [counties]);
  const stateSet = useMemo(() => new Set((states.length ? states : ["TX"]).map((s) => s.toUpperCase())), [states]);

  // The statewide index is large (300k+), so labels are built once per index
  // load and the scoped list is pre-sorted numerically once per county change.
  const multiCounty = counties.length > 1;
  const labels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const e of entries) {
      out[e.id] = multiCounty
        ? `${abstractEntryShortLabel(e)} · ${(e.state ?? "TX") === "TX" ? e.county : countyLabel(e.county, e.state)}`
        : abstractEntryShortLabel(e);
    }
    return out;
  }, [entries, multiCounty]);
  const scopedIds = useMemo(() => {
    const scoped = counties.length === 0 ? [] : entries.filter((e) => countySet.has(e.county.toLowerCase()) && stateSet.has((e.state ?? "TX").toUpperCase()));
    return rankAbstracts(scoped, "", (e) => ({ abstract: e.abstract, text: e.county })).map((e) => e.id);
  }, [entries, counties, countySet, stateSet]);
  // Already-selected abstracts stay valid options even outside the county scope.
  const options = useMemo(() => [...new Set([...scopedIds, ...value])], [scopedIds, value]);

  const filterOptions = useCallback((opts: readonly string[], query: string) =>
    query.trim()
      ? rankAbstracts(opts, query, (id) => ({ abstract: byId.get(id)?.abstract ?? id, text: labels[id] ?? id }))
      : [...opts], [byId, labels]);

  return (
    <SearchableMultiSelect
      options={options}
      labels={labels}
      value={value}
      onChange={onChange}
      filterOptions={filterOptions}
      disabled={counties.length === 0}
      placeholder={counties.length === 0 ? "Select a county first" : "Search abstract # or survey…"}
    />
  );
}
