/**
 * The RRC datasets the ingestion pipeline is responsible for (Phases 1 & 2 of
 * the Well-Analysis data plan). Each entry carries the EXACT RRC dataset name,
 * its format, how the current download URL is obtained, which rrc.* table(s) it
 * feeds, and which Well-Analysis section(s) it populates.
 *
 * URL resolution: the RRC serves most sets behind rotating "permanent link"
 * ids on the catalog page, so we resolve the live URL at run time by matching
 * `pageLinkText` against the catalog HTML. A few sets (PDQ) have a stable link
 * we can hit directly via `directUrl`.
 */
export type RrcFormat = "csv" | "ascii" | "ebcdic" | "shapefile-zip" | "ascii-zip";

export interface DatasetSpec {
  id: string;              // stable internal id (also the loader-registry key)
  name: string;            // EXACT RRC dataset name as listed on the catalog
  format: RrcFormat;
  phase: 1 | 2;
  required: boolean;       // Phase-1 required vs Phase-2 recommended
  directUrl?: string;      // known stable link (mft.rrc.texas.gov/link/…)
  pageLinkText?: string;   // catalog anchor text to resolve the current link
  target: string;          // rrc.* table(s) it populates
  populates: string;       // Well-Analysis section(s)
  parser: string;          // "inline" or the tools/rrc script that decodes it
  countyScoped: boolean;   // whether it can be filtered to COUNTIES at parse time
}

export const DATASETS: DatasetSpec[] = [
  // ---- Phase 1: required core -------------------------------------------
  {
    id: "production_pdq",
    name: "Production Data Query Dump",
    format: "csv",
    phase: 1, required: true,
    directUrl: "https://mft.rrc.texas.gov/link/1f5ddb8d-329a-4459-b7f8-177b4f5ee60d",
    target: "rrc.production",
    populates: "Production History, Cumulative, Decline inputs, First-production date",
    parser: "inline (DSV filter)",
    countyScoped: true,
  },
  {
    id: "full_wellbore",
    name: "Full Wellbore",
    format: "ebcdic",
    phase: 1, required: true,
    pageLinkText: "Full Wellbore",
    target: "rrc.wells, rrc.wellbores",
    populates: "Header (API, well name/no, type), Wellbore, Formations, Plug date, Completion",
    parser: "tools/rrc/extract_dbf900.py + parse_dbf900.py",
    countyScoped: true,
  },
  {
    id: "drilling_permits",
    name: "Drilling Permit Master and Trailer - Daily File (Includes Latitudes and Longitudes)",
    format: "ascii",
    phase: 1, required: true,
    pageLinkText: "Drilling Permit Master and Trailer - Daily File",
    target: "rrc.permits",
    populates: "Permit History, Permit Status, Spud date, Surface location, Historical operator",
    parser: "tools/rrc/parse_daf802.py",
    countyScoped: true,
  },
  {
    id: "p5_organizations",
    name: "P5 Organization",
    format: "ascii",
    phase: 1, required: true,
    pageLinkText: "P5 Organization",
    target: "rrc.operators",
    populates: "Operator (current + historical), Offset operators",
    parser: "inline (fixed-width)",
    countyScoped: false,
  },
  {
    id: "field_names",
    name: "Oil & Gas Field Name & Numbers",
    format: "ascii",
    phase: 1, required: true,
    pageLinkText: "Oil & Gas Field Name & Numbers",
    target: "rrc.fields",
    populates: "Field, Reservoir",
    parser: "inline (fixed-width)",
    countyScoped: false,
  },
  {
    id: "oil_well_status",
    name: "Oil Well Status (26 Month W-10)",
    format: "ebcdic",
    phase: 1, required: true,
    pageLinkText: "Oil Well Status",
    target: "rrc.well_status",
    populates: "Well Status, Current operator (oil)",
    parser: "tools/rrc (W-10 decode)",
    countyScoped: true,
  },
  {
    id: "gas_well_status",
    name: "Gas Well Status (26 Month G-10)",
    format: "ebcdic",
    phase: 1, required: true,
    pageLinkText: "Gas Well Status",
    target: "rrc.well_status",
    populates: "Well Status, Current operator (gas)",
    parser: "tools/rrc/parse_gse10.py",
    countyScoped: true,
  },
  {
    id: "completions",
    name: "Completion Information in Data Format",
    format: "ascii-zip",
    phase: 1, required: true,
    pageLinkText: "Completion Information in Data Format",
    target: "rrc.completions",
    populates: "Completion Reports, Total depth, First production, P-15 status, Unit acreage",
    parser: "tools/rrc/parse_completions.py",
    countyScoped: true,
  },
  {
    id: "well_shapefiles",
    name: "Well Layers by County",
    format: "shapefile-zip",
    phase: 1, required: true,
    pageLinkText: "Well Layers by County",
    target: "rrc.wells (geometry)",
    populates: "Map / spatial (Nearby wells, Offset operators)",
    parser: "tools/rrc/build_wells.py",
    countyScoped: true,
  },

  // ---- Phase 2: recommended enrichment ----------------------------------
  {
    id: "horizontal_permits",
    name: "Horizontal Drilling Permits",
    format: "ascii",
    phase: 2, required: false,
    pageLinkText: "Horizontal Drilling Permits",
    target: "rrc.permits (horizontal flag)",
    populates: "Horizontal permits, lateral context",
    parser: "inline (fixed-width)",
    countyScoped: true,
  },
  {
    id: "statewide_api",
    name: "Statewide API Data",
    format: "ascii",
    phase: 2, required: false,
    pageLinkText: "Statewide API Data",
    target: "rrc.wells (cross-reference)",
    populates: "Header cross-checks (API, survey, lease, completion, plug)",
    parser: "inline (fixed-width)",
    countyScoped: true,
  },
  {
    id: "wellbore_query",
    name: "Wellbore Query Data",
    format: "ascii",
    phase: 2, required: false,
    pageLinkText: "Wellbore Query Data",
    target: "rrc.wells (validation)",
    populates: "Header cross-checks, search",
    parser: "inline",
    countyScoped: true,
  },
];

export function datasetById(id: string): DatasetSpec | undefined {
  return DATASETS.find((d) => d.id === id);
}

export function requiredDatasets(): DatasetSpec[] {
  return DATASETS.filter((d) => d.required);
}
