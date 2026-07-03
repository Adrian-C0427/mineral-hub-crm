import { useEffect, useMemo, useState } from "react";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { api } from "../api/client";

interface AbstractEntry { id: string; abstract: string; survey: string; county: string; countyFips: string }

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

function display(e: AbstractEntry): string {
  return e.survey ? `${e.abstract} · ${e.survey}` : e.abstract;
}

export function useAbstractLabels(ids: string[] | null | undefined): string {
  const [entries, setEntries] = useState<AbstractEntry[]>(cache ?? []);
  useEffect(() => { if (!cache) loadIndex().then(setEntries); }, []);
  return useMemo(() => {
    if (!ids || ids.length === 0) return "—";
    return ids.map((id) => {
      const e = entries.find((x) => x.id === id);
      return e ? e.abstract : id;
    }).join(", ");
  }, [ids, entries]);
}

/**
 * Searchable multi-select of abstracts, filtered by the deal's selected counties.
 * (For the Leon POC every abstract is Leon; when no county is chosen we show all
 * available so the picker still works. Statewide, options narrow to selected counties.)
 */
export function AbstractMultiPicker({
  value,
  onChange,
  counties,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  counties: string[];
}) {
  const [entries, setEntries] = useState<AbstractEntry[]>(cache ?? []);
  useEffect(() => { loadIndex().then(setEntries); }, []);

  const countySet = useMemo(() => new Set(counties.map((c) => c.toLowerCase())), [counties]);

  // Options shown to the user: display strings, filtered by selected counties.
  const { options, idByDisplay, displayById } = useMemo(() => {
    const filtered = counties.length === 0 ? entries : entries.filter((e) => countySet.has(e.county.toLowerCase()));
    const options: string[] = [];
    const idByDisplay = new Map<string, string>();
    const displayById = new Map<string, string>();
    for (const e of filtered) {
      const d = display(e);
      options.push(d);
      idByDisplay.set(d, e.id);
    }
    // include already-selected values' displays even if outside current county filter
    for (const e of entries) displayById.set(e.id, display(e));
    return { options, idByDisplay, displayById };
  }, [entries, counties, countySet]);

  // The multi-select works in display strings; map to/from ids.
  const selectedDisplays = value.map((id) => displayById.get(id) ?? id);

  function onSelChange(nextDisplays: string[]) {
    const ids = nextDisplays.map((d) => idByDisplay.get(d)).filter((x): x is string => !!x);
    onChange(ids);
  }

  // Ensure currently-selected displays are always valid options too.
  const allOptions = useMemo(() => {
    const set = new Set(options);
    for (const d of selectedDisplays) set.add(d);
    return [...set];
  }, [options, selectedDisplays]);

  return (
    <SearchableMultiSelect
      options={allOptions}
      value={selectedDisplays}
      onChange={onSelChange}
      placeholder={counties.length === 0 ? "Search abstracts…" : "Search abstracts in selected county…"}
    />
  );
}
