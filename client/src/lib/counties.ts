// Implemented Texas counties. Abstract data lives in PostGIS (imported via
// server/src/scripts/importGis.ts) and streams to the map as vector tiles;
// adding a county = fetch (tools/otls/fetch_abstracts.py) + import + one entry
// here. Well/wellbore layers are still static assets in public/data (phase B).
export interface CountyDef { key: string; name: string; fips: string }

export const COUNTIES: CountyDef[] = [
  { key: "leon", name: "Leon", fips: "289" },
  { key: "freestone", name: "Freestone", fips: "161" },
  // Batch 1 (2026-07-03): the contiguous block of counties bordering Leon/Freestone.
  { key: "anderson", name: "Anderson", fips: "001" },
  { key: "houston", name: "Houston", fips: "225" },
  { key: "madison", name: "Madison", fips: "313" },
  { key: "robertson", name: "Robertson", fips: "395" },
  { key: "limestone", name: "Limestone", fips: "293" },
  // Phase A (2026-07-03): East Texas / Haynesville priority counties.
  { key: "cherokee", name: "Cherokee", fips: "073" },
  { key: "angelina", name: "Angelina", fips: "005" },
  { key: "sanaugustine", name: "San Augustine", fips: "405" },
  { key: "panola", name: "Panola", fips: "365" },
  { key: "shelby", name: "Shelby", fips: "419" },
];

/** County keys that currently have well/wellbore GIS layers available. */
export const COUNTIES_WITH_WELLS = ["leon", "freestone"];

/** County keys with a {key}-production.json monthly-production asset. */
export const COUNTIES_WITH_PRODUCTION = ["leon", "freestone"];
