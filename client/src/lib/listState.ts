import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * List-page state (search text, filters) that survives leaving for a detail
 * page and returning with Back. The list component remounts on return, so
 * plain `useState` would reset it; this keeps a copy in sessionStorage under a
 * route-scoped key (per tab, gone when the tab closes). Same setter semantics
 * as `useState`; a key change (e.g. the Deals scope) swaps to that key's
 * remembered value.
 */
export function useListState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const storageKey = `mh-list:${key}`;
  const read = (): T => {
    try { const raw = sessionStorage.getItem(storageKey); return raw == null ? initial : (JSON.parse(raw) as T); } catch { return initial; }
  };
  const [value, setValue] = useState<T>(read);
  const keyRef = useRef(storageKey);
  useEffect(() => {
    if (keyRef.current !== storageKey) { keyRef.current = storageKey; setValue(read()); return; }
    try { sessionStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* storage unavailable — in-memory only */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, value]);
  return [value, setValue];
}
