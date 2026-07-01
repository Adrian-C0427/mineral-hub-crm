import { useEffect, useMemo, useState } from "react";

interface AbstractEntry { id: string; abstract: string; survey: string }

// Module-level cache so the index (~80KB) loads at most once per session.
let cache: AbstractEntry[] | null = null;
let inflight: Promise<AbstractEntry[]> | null = null;
function loadIndex(): Promise<AbstractEntry[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/data/leon-abstracts-index.json")
      .then((r) => r.json())
      .then((data: AbstractEntry[]) => { cache = data; return data; })
      .catch(() => { cache = []; return []; });
  }
  return inflight;
}

function display(e: AbstractEntry): string {
  return e.survey ? `${e.abstract} · ${e.survey}` : e.abstract;
}

export function useAbstractLabel(id: string | null | undefined): string {
  const [entries, setEntries] = useState<AbstractEntry[]>(cache ?? []);
  useEffect(() => { if (!cache) loadIndex().then(setEntries); }, []);
  return useMemo(() => {
    if (!id) return "—";
    const e = entries.find((x) => x.id === id);
    return e ? display(e) : id;
  }, [id, entries]);
}

/** Searchable single-select (Leon County) via a native datalist. */
export function AbstractPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const [entries, setEntries] = useState<AbstractEntry[]>(cache ?? []);
  const [text, setText] = useState("");

  useEffect(() => { loadIndex().then(setEntries); }, []);
  useEffect(() => {
    // Initialize the visible text from the current value once entries are available.
    if (value) {
      const e = entries.find((x) => x.id === value);
      if (e) setText(display(e));
    } else {
      setText("");
    }
  }, [value, entries]);

  const byDisplay = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) m.set(display(e), e.id);
    return m;
  }, [entries]);

  function commit(v: string) {
    setText(v);
    if (v.trim() === "") { onChange(null); return; }
    const id = byDisplay.get(v);
    if (id) onChange(id);
  }

  return (
    <>
      <input
        list="abstract-datalist"
        value={text}
        onChange={(e) => commit(e.target.value)}
        placeholder="Search Leon County abstracts…"
      />
      <datalist id="abstract-datalist">
        {entries.slice(0, 2000).map((e) => <option key={e.id} value={display(e)} />)}
      </datalist>
    </>
  );
}
