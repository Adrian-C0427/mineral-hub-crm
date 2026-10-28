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

/** States the platform actively supports today. County pickers default to
 * these when NO state is selected, so users go straight to County → Abstract
 * without a redundant State step. When more states come online, extending this
 * list (or selecting states explicitly) reintroduces state-based scoping with
 * no structural change. */
export const SUPPORTED_STATES = ["TX"] as const;

/** Union of counties for the selected states (sorted, de-duplicated). With no
 * state selected, falls back to the supported states' counties — County is the
 * primary geographic selection; State remains an optional narrower. */
export function countiesForStates(states: string[]): string[] {
  const source = states.length ? states : [...SUPPORTED_STATES];
  const out = new Set<string>();
  for (const s of source) for (const c of STATE_COUNTIES[s] ?? []) out.add(c);
  return [...out].sort();
}
