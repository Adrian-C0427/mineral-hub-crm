import { useEffect } from "react";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { AbstractMultiPicker } from "./AbstractPicker";
import { US_STATE_OPTIONS, countiesForStates } from "../lib/options";

/**
 * The single, canonical geographic hierarchy used everywhere in the app:
 *
 *     State → County → Abstract
 *
 * - State: searchable multi-select over all 50 U.S. states (+ DC).
 * - County: searchable multi-select, options limited to the selected states;
 *   selections outside those states are auto-pruned when the states change.
 * - Abstract: searchable multi-select limited to the selected counties;
 *   auto-pruned by AbstractMultiPicker as counties change. Optional — omit
 *   `onAbstractsChange` to hide it (buy-boxes/filters that don't scope to a
 *   single abstract).
 *
 * Using this one component guarantees identical component, validation,
 * search/multi-select behaviour, dependencies, and UX in Deals, Buyer Profiles,
 * Mineral Assets, the Buyer Portal, and anywhere geography is entered.
 *
 * `countyOptions` may be overridden (e.g. a map/research view that should only
 * offer counties that actually have data) while keeping the same UX + cascade.
 */
export function GeoFields({
  states, onStatesChange,
  counties, onCountiesChange,
  abstractIds, onAbstractsChange,
  countyOptions,
  disabled,
  labels,
}: {
  states: string[];
  onStatesChange: (v: string[]) => void;
  counties: string[];
  onCountiesChange: (v: string[]) => void;
  abstractIds?: string[];
  onAbstractsChange?: (v: string[]) => void;
  /** Override the county option list (defaults to counties of the selected states). */
  countyOptions?: string[];
  disabled?: boolean;
  labels?: { state?: string; county?: string; abstract?: string };
}) {
  const availableCounties = countyOptions ?? countiesForStates(states);

  // Cascade pruning: drop any selected county no longer valid for the chosen
  // states (unless the caller supplies its own option list).
  useEffect(() => {
    if (countyOptions) return;
    const valid = new Set(availableCounties);
    const pruned = counties.filter((c) => valid.has(c));
    if (pruned.length !== counties.length) onCountiesChange(pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states.join("|")]);

  return (
    <>
      <div className="field">
        <label>{labels?.state ?? "State"}</label>
        <SearchableMultiSelect
          options={[...US_STATE_OPTIONS]}
          value={states}
          onChange={disabled ? () => {} : onStatesChange}
          placeholder="Search states…"
        />
      </div>
      <div className="field">
        <label>{labels?.county ?? "County"}</label>
        <SearchableMultiSelect
          options={availableCounties}
          value={counties}
          onChange={disabled ? () => {} : onCountiesChange}
          placeholder={states.length || countyOptions ? "Search counties…" : "Select a state first"}
        />
      </div>
      {onAbstractsChange && (
        <div className="field">
          <label>{labels?.abstract ?? "Abstract"}</label>
          <AbstractMultiPicker value={abstractIds ?? []} counties={counties} onChange={disabled ? () => {} : onAbstractsChange} />
        </div>
      )}
    </>
  );
}
