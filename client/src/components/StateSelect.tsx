import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { US_STATE_OPTIONS, US_STATE_LABELS } from "../lib/options";

/**
 * Single-value, searchable US state selector — the state counterpart to the
 * shared geographic pickers. Displays "Texas (TX)" and searches both the code
 * and the full name, matching how states are chosen everywhere else. Selecting a
 * state replaces the current one; removing the chip clears it.
 */
export function StateSelect({ value, onChange, placeholder = "Search states…" }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <SearchableMultiSelect
      options={[...US_STATE_OPTIONS]}
      labels={US_STATE_LABELS}
      value={value ? [value] : []}
      onChange={(vals) => onChange(vals.length ? vals[vals.length - 1] : "")}
      placeholder={placeholder}
    />
  );
}
