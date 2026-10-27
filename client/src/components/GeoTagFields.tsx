import type { ReactNode } from "react";
import { SearchableMultiSelect } from "./SearchableMultiSelect";
import { basinHint, basinOptions, formationHint, formationOptions, useAutoFill, useGeoCatalog, useGeoContext } from "../lib/geoContext";

/**
 * Basin + Formation fields that know where the record is. Given the record's
 * abstracts / counties / states, they ask GET /geo/context, order the options
 * by what applies there, say in one line how the answer was reached (abstract
 * footprint or county outline, confidence, well evidence) and — when
 * `autoFill` is on — fill in the suggested tags while the user has not typed
 * anything of their own. Every pick stays editable; nothing is ever locked.
 *
 * Renders two `.field` blocks so it drops into the existing form grids
 * (nd-grid3 / dd-grid) exactly where the two plain selects used to be.
 */
export function GeoTagFields({
  basins, onBasinsChange, formations, onFormationsChange,
  abstractIds, counties, states,
  autoFill = false,
  labels,
}: {
  basins: string[]; onBasinsChange: (v: string[]) => void;
  formations: string[]; onFormationsChange: (v: string[]) => void;
  abstractIds: readonly string[]; counties: readonly string[]; states: readonly string[];
  /** Fill empty fields from the suggestions (new records; edit forms whose fields are blank). */
  autoFill?: boolean;
  labels?: { basin?: ReactNode; formation?: ReactNode };
}) {
  const cat = useGeoCatalog();
  const { ctx, pending } = useGeoContext(abstractIds, counties, states);
  const autoB = useAutoFill(autoFill, ctx?.suggested.basins, basins, onBasinsChange);
  const autoF = useAutoFill(autoFill, ctx?.suggested.formations, formations, onFormationsChange);
  const hasGeo = abstractIds.length > 0 || counties.length > 0;
  const bHint = basinHint(ctx);
  const fHint = formationHint(ctx, counties.length === 1 ? counties[0] : undefined);
  return (
    <>
      <div className="field">
        <label>{labels?.basin ?? "Basin"}</label>
        <SearchableMultiSelect options={basinOptions(cat, ctx)} value={basins} onChange={onBasinsChange} placeholder={hasGeo ? "Suggested for this geography first…" : "Search basins…"} />
        <div className="geo-hint" aria-live="polite">
          {pending ? "Checking the basin outlines…" : bHint ? <>{autoB && <b>Filled in · </b>}{bHint}</> : hasGeo ? null : "Pick a county or abstract and the basin is suggested."}
        </div>
      </div>
      <div className="field">
        <label>{labels?.formation ?? "Formation"}</label>
        <SearchableMultiSelect options={formationOptions(cat, ctx)} value={formations} onChange={onFormationsChange} placeholder={hasGeo ? "Evidence for this geography first…" : "Search formations…"} />
        <div className="geo-hint" aria-live="polite">
          {pending ? "" : fHint ? <>{autoF && <b>Filled in · </b>}{fHint}</> : null}
        </div>
      </div>
    </>
  );
}
