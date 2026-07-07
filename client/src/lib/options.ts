// Option lists for searchable multi-select buy-box fields.
import { US_STATE_COUNTIES } from "./usCounties";

export const ASSET_TYPE_OPTIONS = ["RI", "ORRI", "NPRI", "WI", "MI"] as const;

// Display labels: the industry acronyms stay as stored values, but pickers show
// the expansion so newer team members aren't guessing what NPRI means.
export const ASSET_TYPE_LABELS: Record<string, string> = {
  RI: "Royalty Interest (RI)",
  ORRI: "Overriding Royalty Interest (ORRI)",
  NPRI: "Non-Participating Royalty Interest (NPRI)",
  WI: "Working Interest (WI)",
  MI: "Mineral Interest (MI)",
};

// All U.S. states + DC (2-letter codes; consistent with existing stored values).
export const US_STATE_OPTIONS = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE",
  "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
  "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

// Full state names for picker display + search — typing "Texas" must find TX.
const STATE_NAME: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
export const US_STATE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_NAME).map(([code, name]) => [code, `${name} (${code})`]),
);

// Recognized Texas producing basins / structural provinces (comprehensive).
export const TEXAS_BASIN_OPTIONS = [
  "Permian Basin",
  "Delaware Basin",
  "Midland Basin",
  "Central Basin Platform",
  "Northwest Shelf",
  "Eastern Shelf",
  "Ozona Arch",
  "Val Verde Basin",
  "Marfa Basin",
  "Marathon Fold Belt",
  "Palo Duro Basin",
  "Dalhart Basin",
  "Anadarko Basin",
  "Hardeman Basin",
  "Bend Arch",
  "Fort Worth Basin",
  "East Texas Basin",
  "North Texas (Muenster Arch)",
  "Sabine Uplift",
  "Ark-La-Tex",
  "Gulf Coast Basin",
  "Maverick Basin",
  "Rio Grande Embayment",
  "Burgos Basin",
  "San Marcos Arch",
  "Llano Uplift",
];

// Recognized Texas formations / producing intervals (comprehensive, roughly
// grouped by province: Permian, Fort Worth/Bend, East TX/Gulf Coast, etc.).
export const TEXAS_FORMATION_OPTIONS = [
  // Permian (Delaware / Midland)
  "Wolfcamp", "Spraberry", "Dean", "Bone Spring", "Avalon", "Brushy Canyon",
  "Cherry Canyon", "Bell Canyon", "Cline", "Clearfork", "San Andres", "Grayburg",
  "Yates", "Seven Rivers", "Queen", "Glorieta", "Leonard", "Strawn", "Atoka",
  "Morrow", "Fusselman", "Devonian", "Mississippian", "Ellenburger", "Barnett (Permian)",
  "Wichita-Albany",
  // Fort Worth / Bend Arch
  "Barnett", "Marble Falls", "Bend Conglomerate", "Caddo", "Conglomerate",
  // Anadarko / Panhandle
  "Granite Wash", "Cleveland", "Tonkawa", "Council Grove", "Brown Dolomite",
  "Red Cave", "Hugoton",
  // East Texas / North Louisiana
  "Haynesville", "Bossier", "Cotton Valley", "Travis Peak", "Pettet", "Rodessa",
  "James Lime", "Sligo", "Pettit", "Woodbine", "Sub-Clarksville", "Paluxy", "Buda",
  "Georgetown", "Edwards",
  // Gulf Coast / South Texas
  "Eagle Ford", "Austin Chalk", "Buda (Gulf Coast)", "Olmos", "San Miguel",
  "Escondido", "Wilcox", "Vicksburg", "Frio", "Yegua", "Jackson", "Queen City",
  "Tom Green", "Miocene",
  // Miscellaneous / statewide
  "Canyon", "Strawn (North TX)", "Gardner", "Palo Pinto", "Smithwick",
];

// ---------------------------------------------------------------------------
// Geographic relationships: which basins/formations are valid in a county.
// County-level mapping (Abstract-level associations are the long-term goal;
// county is the practical fallback). Used to SUGGEST valid basins/formations
// from the selected geography — selections outside the map are still allowed,
// so partial coverage never blocks data entry.
// ---------------------------------------------------------------------------

// County → basins. Broad regional assignment covering the main plays.
const PERMIAN_DELAWARE = ["Reeves", "Loving", "Ward", "Winkler", "Pecos", "Culberson", "Jeff Davis"];
const PERMIAN_MIDLAND = ["Midland", "Martin", "Howard", "Glasscock", "Reagan", "Upton", "Andrews", "Ector", "Crane", "Dawson", "Borden", "Sterling", "Irion", "Regan"];
const FORT_WORTH = ["Tarrant", "Johnson", "Wise", "Denton", "Parker", "Hood", "Somervell", "Erath", "Palo Pinto", "Jack", "Montague"];
const EAST_TEXAS = ["Leon", "Freestone", "Anderson", "Angelina", "Cherokee", "Houston", "Limestone", "Madison", "Panola", "Robertson", "San Augustine", "Shelby", "Nacogdoches", "Rusk", "Gregg", "Harrison", "Smith", "Henderson", "Navarro"];
const EAGLE_FORD = ["Karnes", "DeWitt", "Gonzales", "La Salle", "McMullen", "Dimmit", "Webb", "Atascosa", "Live Oak", "Frio", "Wilson", "Maverick", "Zavala"];
const ANADARKO_PANHANDLE = ["Hemphill", "Roberts", "Ochiltree", "Lipscomb", "Wheeler", "Hutchinson", "Gray", "Moore", "Potter"];

function invert(map: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [value, counties] of Object.entries(map)) for (const c of counties) (out[c] ??= []).push(value);
  return out;
}

const BASIN_COUNTIES: Record<string, string[]> = {
  "Delaware Basin": PERMIAN_DELAWARE, "Permian Basin": [...PERMIAN_DELAWARE, ...PERMIAN_MIDLAND],
  "Midland Basin": PERMIAN_MIDLAND, "Fort Worth Basin": FORT_WORTH,
  "East Texas Basin": EAST_TEXAS, "Maverick Basin": ["Maverick", "Dimmit", "Zavala", "La Salle", "Webb"],
  "Gulf Coast Basin": EAGLE_FORD, "Anadarko Basin": ANADARKO_PANHANDLE,
};
const FORMATION_COUNTIES: Record<string, string[]> = {
  "Wolfcamp": [...PERMIAN_DELAWARE, ...PERMIAN_MIDLAND], "Spraberry": PERMIAN_MIDLAND,
  "Bone Spring": PERMIAN_DELAWARE, "Wolfcamp (Delaware)": PERMIAN_DELAWARE,
  "Barnett": FORT_WORTH, "Bend Conglomerate": FORT_WORTH, "Marble Falls": FORT_WORTH,
  "Haynesville": EAST_TEXAS, "Bossier": EAST_TEXAS, "Cotton Valley": EAST_TEXAS,
  "Travis Peak": EAST_TEXAS, "Woodbine": EAST_TEXAS, "Rodessa": EAST_TEXAS,
  "Eagle Ford": EAGLE_FORD, "Austin Chalk": [...EAGLE_FORD, ...EAST_TEXAS], "Buda": EAGLE_FORD,
  "Granite Wash": ANADARKO_PANHANDLE, "Cleveland": ANADARKO_PANHANDLE,
};

const COUNTY_BASINS = invert(BASIN_COUNTIES);
const COUNTY_FORMATIONS = invert(FORMATION_COUNTIES);

/** Basins geographically associated with the selected counties (sorted, unique).
 *  Empty when no counties are selected or none have a mapping. */
export function basinsForCounties(counties: string[]): string[] {
  const out = new Set<string>();
  for (const c of counties) for (const b of COUNTY_BASINS[c] ?? []) out.add(b);
  return [...out].sort();
}
/** Formations geographically associated with the selected counties. */
export function formationsForCounties(counties: string[]): string[] {
  const out = new Set<string>();
  for (const c of counties) for (const f of COUNTY_FORMATIONS[c] ?? []) out.add(f);
  return [...out].sort();
}

// All 254 Texas counties, alphabetical.
export const TEXAS_COUNTY_OPTIONS: string[] = [
  "Anderson", "Andrews", "Angelina", "Aransas", "Archer", "Armstrong", "Atascosa", "Austin",
  "Bailey", "Bandera", "Bastrop", "Baylor", "Bee", "Bell", "Bexar", "Blanco", "Borden", "Bosque",
  "Bowie", "Brazoria", "Brazos", "Brewster", "Briscoe", "Brooks", "Brown", "Burleson", "Burnet",
  "Caldwell", "Calhoun", "Callahan", "Cameron", "Camp", "Carson", "Cass", "Castro", "Chambers",
  "Cherokee", "Childress", "Clay", "Cochran", "Coke", "Coleman", "Collin", "Collingsworth",
  "Colorado", "Comal", "Comanche", "Concho", "Cooke", "Coryell", "Cottle", "Crane", "Crockett",
  "Crosby", "Culberson",
  "Dallam", "Dallas", "Dawson", "Deaf Smith", "Delta", "Denton", "DeWitt", "Dickens", "Dimmit",
  "Donley", "Duval",
  "Eastland", "Ector", "Edwards", "El Paso", "Ellis", "Erath",
  "Falls", "Fannin", "Fayette", "Fisher", "Floyd", "Foard", "Fort Bend", "Franklin", "Freestone",
  "Frio",
  "Gaines", "Galveston", "Garza", "Gillespie", "Glasscock", "Goliad", "Gonzales", "Gray", "Grayson",
  "Gregg", "Grimes", "Guadalupe",
  "Hale", "Hall", "Hamilton", "Hansford", "Hardeman", "Hardin", "Harris", "Harrison", "Hartley",
  "Haskell", "Hays", "Hemphill", "Henderson", "Hidalgo", "Hill", "Hockley", "Hood", "Hopkins",
  "Houston", "Howard", "Hudspeth", "Hunt", "Hutchinson",
  "Irion",
  "Jack", "Jackson", "Jasper", "Jeff Davis", "Jefferson", "Jim Hogg", "Jim Wells", "Johnson",
  "Jones",
  "Karnes", "Kaufman", "Kendall", "Kenedy", "Kent", "Kerr", "Kimble", "King", "Kinney", "Kleberg",
  "Knox",
  "La Salle", "Lamar", "Lamb", "Lampasas", "Lavaca", "Lee", "Leon", "Liberty", "Limestone",
  "Lipscomb", "Live Oak", "Llano", "Loving", "Lubbock", "Lynn",
  "Madison", "Marion", "Martin", "Mason", "Matagorda", "Maverick", "McCulloch", "McLennan",
  "McMullen", "Medina", "Menard", "Midland", "Milam", "Mills", "Mitchell", "Montague", "Montgomery",
  "Moore", "Morris", "Motley",
  "Nacogdoches", "Navarro", "Newton", "Nolan", "Nueces",
  "Ochiltree", "Oldham", "Orange",
  "Palo Pinto", "Panola", "Parker", "Parmer", "Pecos", "Polk", "Potter", "Presidio",
  "Rains", "Randall", "Reagan", "Real", "Red River", "Reeves", "Refugio", "Roberts", "Robertson",
  "Rockwall", "Runnels", "Rusk",
  "Sabine", "San Augustine", "San Jacinto", "San Patricio", "San Saba", "Schleicher", "Scurry",
  "Shackelford", "Shelby", "Sherman", "Smith", "Somervell", "Starr", "Stephens", "Sterling",
  "Stonewall", "Sutton", "Swisher",
  "Tarrant", "Taylor", "Terrell", "Terry", "Throckmorton", "Titus", "Tom Green", "Travis", "Trinity",
  "Tyler",
  "Upshur", "Upton", "Uvalde",
  "Val Verde", "Van Zandt", "Victoria",
  "Walker", "Waller", "Ward", "Washington", "Webb", "Wharton", "Wheeler", "Wichita", "Wilbarger",
  "Willacy", "Williamson", "Wilson", "Winkler", "Wise", "Wood",
  "Yoakum", "Young",
  "Zapata", "Zavala",
];

/**
 * Counties available per state. Populated for states the app has data for
 * (Texas today); other states resolve to an empty list until their county data
 * is added. Drives the State → County dependency in the geographic hierarchy.
 */
// Nationwide state -> county lists (US Census TIGER, all 50 states + DC). TX
// keeps its curated list (drives the map's abstract hierarchy); every other
// state comes from the generated dataset.
export const STATE_COUNTIES: Record<string, readonly string[]> = {
  ...US_STATE_COUNTIES,
  TX: TEXAS_COUNTY_OPTIONS,
};

/** Union of counties for the selected states (sorted, de-duplicated). Empty
 * until at least one state is chosen — prevents invalid county selections. */
export function countiesForStates(states: string[]): string[] {
  if (!states.length) return [];
  const out = new Set<string>();
  for (const s of states) for (const c of STATE_COUNTIES[s] ?? []) out.add(c);
  return [...out].sort();
}

/** Reorder `all` so geographically-suggested options come first (deduped),
 *  keeping the rest available. Lets forms surface valid basins/formations for
 *  the selected geography without hiding anything. */
export function suggestFirst(all: readonly string[], suggested: string[]): string[] {
  if (!suggested.length) return [...all];
  const set = new Set(suggested);
  const head = suggested.filter((s) => all.includes(s));
  const tail = all.filter((o) => !set.has(o));
  return [...head, ...tail];
}
