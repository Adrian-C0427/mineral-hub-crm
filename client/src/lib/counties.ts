// Implemented Texas counties. Adding a county = one entry here + its static
// GIS assets in public/data ({key}-abstracts.geojson, {key}-abstracts-index.json,
// and optionally {key}-wells.geojson / {key}-wellbores.geojson).
export interface CountyDef { key: string; name: string; fips: string }

export const COUNTIES: CountyDef[] = [
  { key: "leon", name: "Leon", fips: "289" },
  { key: "freestone", name: "Freestone", fips: "161" },
];

/** County keys that currently have well/wellbore GIS layers available. */
export const COUNTIES_WITH_WELLS = ["leon", "freestone"];

/** County keys with a {key}-production.json monthly-production asset. */
export const COUNTIES_WITH_PRODUCTION = ["leon", "freestone"];
