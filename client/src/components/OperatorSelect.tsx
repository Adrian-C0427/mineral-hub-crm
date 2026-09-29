import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Select, type SelectOption } from "./Select";

interface OperatorOption { name: string; wells: number }

/**
 * Searchable operator picker scoped to the deal's location: options are only
 * the operators with activity in the selected state(s) AND county(ies) (RRC
 * wells, imported permits, the org's own deals). A name outside the list can
 * still be typed — well coverage doesn't exist for every county.
 */
export function OperatorSelect({ states, counties, value, onChange, ariaLabel = "Operator" }: {
  states: string[];
  counties: string[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
}) {
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const scoped = states.length > 0 && counties.length > 0;
  const statesKey = states.join(","), countiesKey = counties.join(",");

  useEffect(() => {
    if (!scoped) { setOptions([]); return; }
    let live = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      const qs = new URLSearchParams({ states: statesKey, counties: countiesKey });
      api.get<OperatorOption[]>(`/deals/operator-options?${qs}`)
        .then((rows) => { if (live) setOptions(rows.map((o) => ({ value: o.name, label: o.name, hint: o.wells ? `${o.wells.toLocaleString()} well${o.wells === 1 ? "" : "s"}` : undefined }))); })
        .catch(() => { if (live) setOptions([]); })
        .finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; window.clearTimeout(t); };
  }, [scoped, statesKey, countiesKey]);

  return (
    <Select
      options={options}
      value={value}
      onChange={onChange}
      searchable
      creatable
      clearable
      ariaLabel={ariaLabel}
      placeholder={scoped ? "Search operators…" : "Select a state and county first"}
      searchPlaceholder={scoped ? "Search or type an operator…" : "Type an operator name…"}
      emptyText={!scoped ? "Pick a state and county to see their operators" : loading ? "Loading operators…" : "No operators on record here — type a name"}
    />
  );
}
