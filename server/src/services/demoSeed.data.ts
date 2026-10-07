/**
 * Static content for the demo / showcase workspace seeder (services/demoSeed.ts).
 *
 * Everything here is invented but credible Texas mineral-acquisition data:
 * company names are fictional (no real buyer firms), phone numbers sit in the
 * reserved fictional 555-01xx range, and every email address uses the
 * non-routable `.demo` TLD so nothing can ever reach a real mailbox. Operator
 * names in the curated fallback lists are public RRC operators (the same
 * names the live rrc.wells table would supply when it is present).
 */

export type Region = "EAST" | "EAGLE_FORD" | "PERMIAN";

export interface CountyInfo {
  name: string;
  /** 3-digit Texas county code (FIPS = RRC API county code). */
  fips: string;
  region: Region;
  basins: string[];
  formations: string[];
  /** Our acquisition cost range, $ per NMA. */
  costPerNma: [number, number];
  royaltyRates: string[];
  /** Curated fallback operators (used when rrc.wells is absent). */
  operators: string[];
  /** Curated fallback abstracts (used when gis.abstracts is absent). */
  abstracts: { abstract: string; survey: string }[];
  /** Nearby towns for local mailing addresses. */
  towns: { city: string; zip: string }[];
  areaCode: string;
}

export const COUNTIES: CountyInfo[] = [
  {
    name: "Leon", fips: "289", region: "EAST", basins: ["East Texas Basin"],
    formations: ["Haynesville", "Bossier", "Cotton Valley", "Woodbine"], costPerNma: [900, 2400],
    royaltyRates: ["1/8", "3/16", "1/5"],
    operators: ["Comstock Oil & Gas, LLC", "XTO Energy Inc.", "Enervest Operating, L.L.C."],
    abstracts: [
      { abstract: "A-455", survey: "J. M. Hidalgo Survey" }, { abstract: "A-28", survey: "Jose Maria Moya Survey" },
      { abstract: "A-612", survey: "Wm. Bartlett Survey" }, { abstract: "A-171", survey: "Pedro Gonzales Survey" },
      { abstract: "A-903", survey: "I&GN RR Co. Survey" }, { abstract: "A-338", survey: "Mary Hamilton Survey" },
    ],
    towns: [{ city: "Centerville", zip: "75833" }, { city: "Buffalo", zip: "75831" }, { city: "Jewett", zip: "75846" }, { city: "Normangee", zip: "77871" }],
    areaCode: "903",
  },
  {
    name: "Freestone", fips: "161", region: "EAST", basins: ["East Texas Basin"],
    formations: ["Cotton Valley", "Bossier", "Haynesville"], costPerNma: [350, 950],
    royaltyRates: ["1/8", "3/16"],
    operators: ["XTO Energy Inc.", "Sheridan Production Company, LLC", "Valence Operating Company"],
    abstracts: [
      { abstract: "A-17", survey: "Francisco Del Corral Survey" }, { abstract: "A-246", survey: "Wm. Steele Survey" },
      { abstract: "A-561", survey: "T&NO RR Co. Survey" }, { abstract: "A-133", survey: "Elijah Ray Survey" },
      { abstract: "A-409", survey: "James Chandler Survey" },
    ],
    towns: [{ city: "Fairfield", zip: "75840" }, { city: "Teague", zip: "75860" }, { city: "Wortham", zip: "76693" }],
    areaCode: "903",
  },
  {
    name: "Robertson", fips: "395", region: "EAST", basins: ["East Texas Basin"],
    formations: ["Haynesville", "Bossier", "Cotton Valley"], costPerNma: [1100, 2500],
    royaltyRates: ["3/16", "1/5", "1/4"],
    operators: ["Comstock Oil & Gas, LLC", "Aethon Energy Operating LLC", "XTO Energy Inc."],
    abstracts: [
      { abstract: "A-44", survey: "Maximo Moreno Survey" }, { abstract: "A-293", survey: "Hamilton Ledbetter Survey" },
      { abstract: "A-517", survey: "H&TC RR Co. Survey" }, { abstract: "A-160", survey: "Wm. Hearne Survey" },
      { abstract: "A-702", survey: "Sterling C. Robertson Survey" },
    ],
    towns: [{ city: "Hearne", zip: "77859" }, { city: "Franklin", zip: "77856" }, { city: "Calvert", zip: "77837" }],
    areaCode: "979",
  },
  {
    name: "Madison", fips: "313", region: "EAST", basins: ["East Texas Basin"],
    formations: ["Woodbine", "Eagle Ford", "Buda"], costPerNma: [450, 1500],
    royaltyRates: ["1/8", "3/16", "1/5"],
    operators: ["Navasota Resources LP", "Hawkwood Energy Operating, LLC", "Aethon Energy Operating LLC"],
    abstracts: [
      { abstract: "A-12", survey: "Joseph Rhodes Survey" }, { abstract: "A-187", survey: "Lewis Gooch Survey" },
      { abstract: "A-322", survey: "Andrew Allen Survey" }, { abstract: "A-96", survey: "T. J. Heard Survey" },
    ],
    towns: [{ city: "Madisonville", zip: "77864" }, { city: "Midway", zip: "75852" }],
    areaCode: "936",
  },
  {
    name: "Grimes", fips: "185", region: "EAST", basins: ["Gulf Coast Basin"],
    formations: ["Austin Chalk", "Eagle Ford", "Buda"], costPerNma: [500, 1600],
    royaltyRates: ["3/16", "1/5"],
    operators: ["Ranger Oil Corporation", "Magnolia Oil & Gas Operating LLC", "Hawkwood Energy Operating, LLC"],
    abstracts: [
      { abstract: "A-63", survey: "Jared E. Groce Survey" }, { abstract: "A-221", survey: "Wm. Burney Survey" },
      { abstract: "A-418", survey: "Elizabeth Millican Survey" }, { abstract: "A-5", survey: "Francis Holland Survey" },
    ],
    towns: [{ city: "Navasota", zip: "77868" }, { city: "Anderson", zip: "77830" }, { city: "Iola", zip: "77861" }],
    areaCode: "936",
  },
  {
    name: "Brazos", fips: "041", region: "EAST", basins: ["Gulf Coast Basin"],
    formations: ["Austin Chalk", "Eagle Ford", "Buda"], costPerNma: [500, 1500],
    royaltyRates: ["3/16", "1/5"],
    operators: ["Magnolia Oil & Gas Operating LLC", "Ranger Oil Corporation", "Navasota Resources LP"],
    abstracts: [
      { abstract: "A-54", survey: "Robert Millican Survey" }, { abstract: "A-147", survey: "Zeno Phillips Survey" },
      { abstract: "A-9", survey: "Thomas Caruthers Survey" }, { abstract: "A-270", survey: "S. A. Smith Survey" },
    ],
    towns: [{ city: "Bryan", zip: "77803" }, { city: "College Station", zip: "77845" }, { city: "Wellborn", zip: "77881" }],
    areaCode: "979",
  },
  {
    name: "Houston", fips: "225", region: "EAST", basins: ["East Texas Basin"],
    formations: ["Woodbine", "Austin Chalk", "Buda"], costPerNma: [300, 900],
    royaltyRates: ["1/8", "3/16"],
    operators: ["Hawkwood Energy Operating, LLC", "Navasota Resources LP", "Sheridan Production Company, LLC"],
    abstracts: [
      { abstract: "A-31", survey: "Daniel McLean Survey" }, { abstract: "A-388", survey: "J. W. Wright Survey" },
      { abstract: "A-702", survey: "Wm. Pierson Survey" }, { abstract: "A-140", survey: "Joseph Rice Survey" },
    ],
    towns: [{ city: "Crockett", zip: "75835" }, { city: "Grapeland", zip: "75844" }, { city: "Lovelady", zip: "75851" }],
    areaCode: "936",
  },
  {
    name: "Anderson", fips: "001", region: "EAST", basins: ["East Texas Basin"],
    formations: ["Cotton Valley", "Woodbine"], costPerNma: [300, 800],
    royaltyRates: ["1/8", "3/16"],
    operators: ["Valence Operating Company", "Sheridan Production Company, LLC", "XTO Energy Inc."],
    abstracts: [
      { abstract: "A-1", survey: "Jose Antonio Mansolo Survey" }, { abstract: "A-264", survey: "Wm. Ford Survey" },
      { abstract: "A-543", survey: "H. Hoover Survey" }, { abstract: "A-78", survey: "Jesse Walling Survey" },
    ],
    towns: [{ city: "Palestine", zip: "75801" }, { city: "Elkhart", zip: "75839" }, { city: "Frankston", zip: "75763" }],
    areaCode: "903",
  },
  {
    name: "Karnes", fips: "255", region: "EAGLE_FORD", basins: ["Gulf Coast Basin"],
    formations: ["Eagle Ford", "Austin Chalk", "Buda"], costPerNma: [6000, 12000],
    royaltyRates: ["1/5", "1/4"],
    operators: ["EOG Resources, Inc.", "ConocoPhillips Company", "Marathon Oil EF LLC"],
    abstracts: [
      { abstract: "A-198", survey: "Jose Antonio Navarro Survey" }, { abstract: "A-7", survey: "Juan Jose Flores Survey" },
      { abstract: "A-264", survey: "Wm. Pettus Survey" }, { abstract: "A-411", survey: "GC&SF RR Co. Survey" },
      { abstract: "A-92", survey: "Manuel Barrera Survey" },
    ],
    towns: [{ city: "Kenedy", zip: "78119" }, { city: "Karnes City", zip: "78118" }, { city: "Runge", zip: "78151" }],
    areaCode: "830",
  },
  {
    name: "Gonzales", fips: "177", region: "EAGLE_FORD", basins: ["Gulf Coast Basin"],
    formations: ["Eagle Ford", "Austin Chalk"], costPerNma: [2500, 6000],
    royaltyRates: ["1/5", "1/4"],
    operators: ["EOG Resources, Inc.", "BP America Production Company", "Penn Virginia Oil & Gas, L.P."],
    abstracts: [
      { abstract: "A-24", survey: "James Kerr Survey" }, { abstract: "A-310", survey: "Wm. Arrington Survey" },
      { abstract: "A-151", survey: "Byrd Lockhart Survey" }, { abstract: "A-488", survey: "B&B RR Co. Survey" },
    ],
    towns: [{ city: "Gonzales", zip: "78629" }, { city: "Nixon", zip: "78140" }, { city: "Waelder", zip: "78959" }],
    areaCode: "830",
  },
  {
    name: "La Salle", fips: "283", region: "EAGLE_FORD", basins: ["Maverick Basin"],
    formations: ["Eagle Ford", "Austin Chalk", "Buda"], costPerNma: [2000, 5000],
    royaltyRates: ["1/5", "1/4"],
    operators: ["Lewis Petro Properties, Inc.", "Devon Energy Production Co., L.P.", "Ovintiv USA Inc."],
    abstracts: [
      { abstract: "A-742", survey: "CCSD&RGNG RR Co. Survey" }, { abstract: "A-1013", survey: "J. Poitevent Survey" },
      { abstract: "A-386", survey: "I&GN RR Co. Survey" }, { abstract: "A-1188", survey: "Ysidro Benavides Survey" },
    ],
    towns: [{ city: "Cotulla", zip: "78014" }, { city: "Encinal", zip: "78019" }],
    areaCode: "830",
  },
  {
    name: "Dimmit", fips: "127", region: "EAGLE_FORD", basins: ["Maverick Basin"],
    formations: ["Eagle Ford", "Austin Chalk"], costPerNma: [2000, 4500],
    royaltyRates: ["1/5", "1/4"],
    operators: ["Chesapeake Operating, L.L.C.", "SilverBow Resources Operating, LLC", "Lewis Petro Properties, Inc."],
    abstracts: [
      { abstract: "A-1301", survey: "CCSD&RGNG RR Co. Survey" }, { abstract: "A-640", survey: "J. Poitevent Survey" },
      { abstract: "A-1112", survey: "GC&SF RR Co. Survey" }, { abstract: "A-275", survey: "Jose Maria Garza Survey" },
    ],
    towns: [{ city: "Carrizo Springs", zip: "78834" }, { city: "Asherton", zip: "78827" }, { city: "Catarina", zip: "78836" }],
    areaCode: "830",
  },
  {
    name: "Reeves", fips: "389", region: "PERMIAN", basins: ["Permian Basin", "Delaware Basin"],
    formations: ["Wolfcamp", "Bone Spring"], costPerNma: [4000, 15000],
    royaltyRates: ["3/16", "1/5", "1/4"],
    operators: ["Diamondback E&P LLC", "Callon Petroleum Operating Company", "Coterra Energy Operating Co."],
    abstracts: [
      { abstract: "A-4718", survey: "Sec. 14, Blk 56, T-6, T&P RR Co. Survey" }, { abstract: "A-5390", survey: "Sec. 22, Blk 4, H&GN RR Co. Survey" },
      { abstract: "A-1129", survey: "Sec. 8, Blk 57, T-7, T&P RR Co. Survey" }, { abstract: "A-6002", survey: "Sec. 31, Blk C-3, PSL Survey" },
    ],
    towns: [{ city: "Pecos", zip: "79772" }, { city: "Balmorhea", zip: "79718" }],
    areaCode: "432",
  },
  {
    name: "Martin", fips: "317", region: "PERMIAN", basins: ["Permian Basin", "Midland Basin"],
    formations: ["Wolfcamp", "Spraberry"], costPerNma: [12000, 25000],
    royaltyRates: ["1/5", "1/4"],
    operators: ["Pioneer Natural Resources USA, LLC", "Endeavor Energy Resources, L.P.", "Ovintiv USA Inc."],
    abstracts: [
      { abstract: "A-1032", survey: "Sec. 24, Blk 34, T-2-N, T&P RR Co. Survey" }, { abstract: "A-217", survey: "Sec. 7, Blk 36, T-1-N, T&P RR Co. Survey" },
      { abstract: "A-891", survey: "Sec. 40, Blk 35, T-1-N, T&P RR Co. Survey" }, { abstract: "A-1415", survey: "Sec. 3, Blk 37, T-2-N, T&P RR Co. Survey" },
    ],
    towns: [{ city: "Stanton", zip: "79782" }, { city: "Tarzan", zip: "79783" }],
    areaCode: "432",
  },
  {
    name: "Howard", fips: "227", region: "PERMIAN", basins: ["Permian Basin", "Midland Basin"],
    formations: ["Wolfcamp", "Spraberry"], costPerNma: [6000, 14000],
    royaltyRates: ["3/16", "1/5", "1/4"],
    operators: ["SM Energy Company", "Sabalo Operating, LLC", "Endeavor Energy Resources, L.P."],
    abstracts: [
      { abstract: "A-1218", survey: "Sec. 18, Blk 33, T-1-S, T&P RR Co. Survey" }, { abstract: "A-602", survey: "Sec. 30, Blk 32, T-2-N, T&P RR Co. Survey" },
      { abstract: "A-1544", survey: "Sec. 5, Blk 34, T-1-S, T&P RR Co. Survey" },
    ],
    towns: [{ city: "Big Spring", zip: "79720" }, { city: "Coahoma", zip: "79511" }],
    areaCode: "432",
  },
  {
    name: "Midland", fips: "329", region: "PERMIAN", basins: ["Permian Basin", "Midland Basin"],
    formations: ["Wolfcamp", "Spraberry"], costPerNma: [12000, 24000],
    royaltyRates: ["1/5", "1/4"],
    operators: ["Pioneer Natural Resources USA, LLC", "Diamondback E&P LLC", "Ovintiv USA Inc."],
    abstracts: [
      { abstract: "A-1106", survey: "Sec. 12, Blk 39, T-2-S, T&P RR Co. Survey" }, { abstract: "A-487", survey: "Sec. 26, Blk 40, T-1-S, T&P RR Co. Survey" },
      { abstract: "A-1750", survey: "Sec. 2, Blk 38, T-3-S, T&P RR Co. Survey" },
    ],
    towns: [{ city: "Midland", zip: "79705" }, { city: "Midland", zip: "79707" }],
    areaCode: "432",
  },
  {
    name: "Upton", fips: "461", region: "PERMIAN", basins: ["Permian Basin", "Midland Basin"],
    formations: ["Wolfcamp", "Spraberry"], costPerNma: [5000, 12000],
    royaltyRates: ["3/16", "1/5", "1/4"],
    operators: ["Ovintiv USA Inc.", "Pioneer Natural Resources USA, LLC", "Apache Corporation"],
    abstracts: [
      { abstract: "A-833", survey: "Sec. 10, Blk Y, CCSD&RGNG RR Co. Survey" }, { abstract: "A-1301", survey: "Sec. 44, Blk 1, MK&T RR Co. Survey" },
      { abstract: "A-292", survey: "Sec. 19, Blk 2, GC&SF RR Co. Survey" },
    ],
    towns: [{ city: "Rankin", zip: "79778" }, { city: "McCamey", zip: "79752" }],
    areaCode: "432",
  },
];

export const REGION_LABEL: Record<Region, string> = { EAST: "East Texas", EAGLE_FORD: "Eagle Ford", PERMIAN: "Permian" };

// Interest types: stored acronym (matches the client's ASSET_TYPE_OPTIONS) + deal-name label.
export const INTERESTS: { type: string; label: string }[] = [
  { type: "MI", label: "Mineral Interest" },
  { type: "NPRI", label: "NPRI" },
  { type: "RI", label: "Royalty Interest" },
  { type: "ORRI", label: "ORRI" },
];

// ---------------------------------------------------------------------------
// Team (the login user is OWNER; the rest have unusable random passwords)
// ---------------------------------------------------------------------------
export interface TeamMember {
  key: string;
  firstName: string;
  lastName: string;
  phone: string;
  orgRole: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  title: string;
  /** Email local part; the login user's email comes from the CLI instead. */
  emailLocal: string | null;
}

export const TEAM: TeamMember[] = [
  { key: "owner", firstName: "Jordan", lastName: "Hale", phone: "9795550101", orgRole: "OWNER", title: "Managing Partner", emailLocal: null },
  { key: "elena", firstName: "Elena", lastName: "Navarro", phone: "9795550114", orgRole: "ADMIN", title: "Director of Acquisitions", emailLocal: "elena.navarro" },
  { key: "travis", firstName: "Travis", lastName: "Boone", phone: "9365550127", orgRole: "MEMBER", title: "Land Manager", emailLocal: "travis.boone" },
  { key: "kayla", firstName: "Kayla", lastName: "Pruitt", phone: "9795550133", orgRole: "MEMBER", title: "Acquisitions Associate", emailLocal: "kayla.pruitt" },
  { key: "ben", firstName: "Ben", lastName: "Okafor", phone: "9795550146", orgRole: "MEMBER", title: "Title Analyst", emailLocal: "ben.okafor" },
  { key: "grace", firstName: "Grace", lastName: "Lindell", phone: "9795550158", orgRole: "VIEWER", title: "Controller", emailLocal: "grace.lindell" },
];

// ---------------------------------------------------------------------------
// Buyers (fictional mineral buyer companies)
// ---------------------------------------------------------------------------
export interface BuyerSpec {
  company: string;
  domain: string;
  first: string;
  last: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  areaCode: string;
  status: "HOT" | "WARM" | "COLD";
  regions: Region[];
  counties: string[];
  formations: string[];
  assetTypes: string[];
  minNma: number | null;
  maxNma: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  tags: string[];
  notes: string;
  active?: boolean;
  portalLead?: boolean;
}

export const BUYERS: BuyerSpec[] = [
  { company: "Caprock Royalty Partners", domain: "caprockroyalty.demo", first: "Wade", last: "Hollister", street: "500 W. Texas Ave., Suite 1200", city: "Midland", state: "TX", zip: "79701", areaCode: "432", status: "HOT", regions: ["PERMIAN"], counties: ["Martin", "Midland", "Howard", "Upton"], formations: ["Wolfcamp", "Spraberry"], assetTypes: ["MI", "RI", "NPRI"], minNma: 2, maxNma: 80, minPrice: 50_000, maxPrice: 2_500_000, tags: ["Permian", "Closes fast", "Repeat buyer"], notes: "Midland Basin focused. Prefers tracts under active Pioneer/Endeavor units. Typically responds within 48 hours and closes in under 3 weeks." },
  { company: "Trinity Basin Minerals", domain: "trinitybasinminerals.demo", first: "Lauren", last: "Esparza", street: "2100 Ross Ave., Suite 900", city: "Dallas", state: "TX", zip: "75201", areaCode: "214", status: "HOT", regions: ["EAST"], counties: ["Leon", "Robertson", "Freestone", "Madison"], formations: ["Haynesville", "Bossier", "Cotton Valley"], assetTypes: ["MI", "NPRI"], minNma: 10, maxNma: 400, minPrice: 15_000, maxPrice: 750_000, tags: ["East Texas", "Haynesville", "Repeat buyer"], notes: "Western Haynesville specialist. Will pay up for acreage inside the Comstock development area. Asks for division orders and recent check stubs up front." },
  { company: "Post Oak Mineral Holdings", domain: "postoakminerals.demo", first: "Grant", last: "Whitaker", street: "1800 Post Oak Blvd., Suite 410", city: "Houston", state: "TX", zip: "77056", areaCode: "713", status: "HOT", regions: ["EAST", "EAGLE_FORD"], counties: ["Grimes", "Brazos", "Madison", "Karnes", "Gonzales"], formations: ["Austin Chalk", "Eagle Ford"], assetTypes: ["MI", "RI"], minNma: 5, maxNma: 250, minPrice: 25_000, maxPrice: 1_500_000, tags: ["Eagle Ford", "Austin Chalk", "Closes fast"], notes: "Family office. Likes Austin Chalk re-development in Grimes/Brazos and core Karnes Eagle Ford. Title opinion required before funding." },
  { company: "Hackberry Creek Minerals", domain: "hackberrycreek.demo", first: "Darren", last: "Pope", street: "3700 Buffalo Speedway, Suite 600", city: "Houston", state: "TX", zip: "77098", areaCode: "713", status: "WARM", regions: ["EAGLE_FORD"], counties: ["Karnes", "Gonzales", "La Salle", "Dimmit"], formations: ["Eagle Ford", "Austin Chalk", "Buda"], assetTypes: ["MI", "RI", "ORRI"], minNma: 2, maxNma: 120, minPrice: 20_000, maxPrice: 900_000, tags: ["Eagle Ford", "Producing only"], notes: "Producing royalties only — wants 12+ months of pay history. Will look at ORRI if burdens are clean." },
  { company: "Red Mesa Royalty Partners", domain: "redmesaroyalty.demo", first: "Allison", last: "Crane", street: "303 Veterans Airpark Ln., Suite 2100", city: "Midland", state: "TX", zip: "79705", areaCode: "432", status: "WARM", regions: ["PERMIAN"], counties: ["Reeves", "Martin", "Howard"], formations: ["Wolfcamp", "Bone Spring", "Spraberry"], assetTypes: ["MI", "RI"], minNma: 5, maxNma: 160, minPrice: 75_000, maxPrice: 3_000_000, tags: ["Permian", "Delaware Basin"], notes: "Delaware Basin buyer; pays a premium for Reeves acreage with permits on file. Slower diligence (30–45 days)." },
  { company: "Cypress Bayou Mineral Co.", domain: "cypressbayou.demo", first: "Nathan", last: "Fontenot", street: "401 Edwards St., Suite 1500", city: "Shreveport", state: "LA", zip: "71101", areaCode: "318", status: "WARM", regions: ["EAST"], counties: ["Leon", "Robertson", "Freestone", "Anderson", "Houston"], formations: ["Haynesville", "Cotton Valley", "Woodbine"], assetTypes: ["MI", "NPRI", "RI"], minNma: 20, maxNma: 600, minPrice: 10_000, maxPrice: 500_000, tags: ["East Texas", "Haynesville"], notes: "Ark-La-Tex buyer branching into the western Haynesville. Comfortable with non-producing acreage near permits." },
  { company: "Ironwood Royalty Holdings", domain: "ironwoodroyalty.demo", first: "Megan", last: "Strickland", street: "6060 N. Central Expy., Suite 700", city: "Dallas", state: "TX", zip: "75206", areaCode: "214", status: "HOT", regions: ["PERMIAN", "EAGLE_FORD"], counties: ["Midland", "Martin", "Upton", "Karnes"], formations: ["Wolfcamp", "Spraberry", "Eagle Ford"], assetTypes: ["MI", "RI", "NPRI"], minNma: 1, maxNma: 60, minPrice: 40_000, maxPrice: 2_000_000, tags: ["Permian", "Eagle Ford", "Repeat buyer"], notes: "Institutional-backed aggregator. Wants a clean PSA, title packet and CDO. Has closed four deals with us." },
  { company: "Navasota Valley Minerals", domain: "navasotavalley.demo", first: "Cody", last: "Brannon", street: "4103 S. Texas Ave., Suite 210", city: "Bryan", state: "TX", zip: "77802", areaCode: "979", status: "WARM", regions: ["EAST"], counties: ["Brazos", "Grimes", "Madison", "Robertson", "Leon"], formations: ["Austin Chalk", "Eagle Ford", "Woodbine"], assetTypes: ["MI", "NPRI"], minNma: 5, maxNma: 200, minPrice: 5_000, maxPrice: 300_000, tags: ["East Texas", "Local"], notes: "Local Brazos Valley buyer. Small checks but very reliable; often takes the smaller heir interests others pass on." },
  { company: "Big Thicket Royalty", domain: "bigthicketroyalty.demo", first: "Rhonda", last: "Gaspard", street: "550 Fannin St., Suite 820", city: "Beaumont", state: "TX", zip: "77701", areaCode: "409", status: "COLD", regions: ["EAST"], counties: ["Houston", "Anderson", "Madison"], formations: ["Woodbine", "Cotton Valley"], assetTypes: ["MI"], minNma: 20, maxNma: 500, minPrice: 10_000, maxPrice: 250_000, tags: ["East Texas", "Slow to respond"], notes: "Has gone quiet since Q2. Still on the list for Woodbine acreage in Houston/Anderson." },
  { company: "Mesquite Flats Minerals", domain: "mesquiteflats.demo", first: "Javier", last: "Saenz", street: "8000 IH-10 West, Suite 600", city: "San Antonio", state: "TX", zip: "78230", areaCode: "210", status: "HOT", regions: ["EAGLE_FORD"], counties: ["Karnes", "La Salle", "Dimmit", "Gonzales"], formations: ["Eagle Ford", "Austin Chalk"], assetTypes: ["MI", "RI", "ORRI"], minNma: 2, maxNma: 100, minPrice: 15_000, maxPrice: 1_200_000, tags: ["Eagle Ford", "Closes fast"], notes: "South Texas specialist. Fast closer, will wire earnest money same week. Prefers EOG and ConocoPhillips operated units." },
  { company: "Stockton Plateau Royalty", domain: "stocktonplateau.demo", first: "Heath", last: "Calloway", street: "110 W. Louisiana Ave., Suite 300", city: "Midland", state: "TX", zip: "79701", areaCode: "432", status: "WARM", regions: ["PERMIAN"], counties: ["Upton", "Reeves", "Midland"], formations: ["Wolfcamp", "Spraberry", "Bone Spring"], assetTypes: ["MI", "RI", "ORRI"], minNma: 2, maxNma: 40, minPrice: 25_000, maxPrice: 800_000, tags: ["Permian"], notes: "Smaller Permian buyer; good fit for 2–20 NMA tracts. Ask for their updated buy box each quarter." },
  { company: "Llano Estacado Mineral Fund", domain: "llanoestacadofund.demo", first: "Priya", last: "Raman", street: "200 Crescent Ct., Suite 1100", city: "Dallas", state: "TX", zip: "75201", areaCode: "214", status: "WARM", regions: ["PERMIAN"], counties: ["Martin", "Howard", "Midland", "Reeves"], formations: ["Wolfcamp", "Spraberry"], assetTypes: ["MI", "RI"], minNma: 10, maxNma: 500, minPrice: 250_000, maxPrice: 10_000_000, tags: ["Permian", "Large checks"], notes: "Fund buyer; only engages above $250k. Needs a full data room (title, DOs, check stubs, production)." },
  { company: "Guadalupe Ridge Minerals", domain: "guadaluperidge.demo", first: "Colton", last: "Meyer", street: "1250 S. Capital of Texas Hwy., Bldg 3", city: "Austin", state: "TX", zip: "78746", areaCode: "512", status: "WARM", regions: ["EAGLE_FORD", "EAST"], counties: ["Gonzales", "Karnes", "Grimes", "Brazos"], formations: ["Eagle Ford", "Austin Chalk"], assetTypes: ["MI", "NPRI"], minNma: 5, maxNma: 150, minPrice: 20_000, maxPrice: 600_000, tags: ["Eagle Ford", "Austin Chalk"], notes: "Austin-based. Interested in Chalk upside in Grimes and Gonzales. Responsive by email, prefers calls for negotiation." },
  { company: "Tejas Crossing Royalty", domain: "tejascrossing.demo", first: "Monica", last: "Villarreal", street: "5500 Bandera Rd., Suite 104", city: "San Antonio", state: "TX", zip: "78238", areaCode: "210", status: "COLD", regions: ["EAGLE_FORD"], counties: ["Dimmit", "La Salle"], formations: ["Eagle Ford"], assetTypes: ["RI", "ORRI"], minNma: 5, maxNma: 80, minPrice: 10_000, maxPrice: 300_000, tags: ["Eagle Ford", "Price sensitive"], notes: "Bids low and rarely moves. Useful as a floor price check on western Eagle Ford packages." },
  { company: "Brushy Creek Mineral Partners", domain: "brushycreekmp.demo", first: "Seth", last: "Gilliam", street: "3001 RR 620 S., Suite 210", city: "Austin", state: "TX", zip: "78738", areaCode: "512", status: "WARM", regions: ["EAST", "PERMIAN"], counties: ["Leon", "Freestone", "Howard", "Upton"], formations: ["Haynesville", "Cotton Valley", "Wolfcamp"], assetTypes: ["MI", "NPRI", "RI"], minNma: 5, maxNma: 300, minPrice: 15_000, maxPrice: 700_000, tags: ["East Texas", "Permian"], notes: "Generalist with two regional desks. Lauren's former colleague runs the East Texas side." , portalLead: true },
  { company: "Blackland Prairie Royalties", domain: "blacklandprairie.demo", first: "Owen", last: "Teague", street: "700 Washington Ave., Suite 400", city: "Waco", state: "TX", zip: "76701", areaCode: "254", status: "WARM", regions: ["EAST"], counties: ["Robertson", "Leon", "Freestone", "Brazos"], formations: ["Haynesville", "Bossier", "Austin Chalk"], assetTypes: ["MI", "RI"], minNma: 10, maxNma: 320, minPrice: 20_000, maxPrice: 900_000, tags: ["East Texas", "Haynesville"], notes: "Central Texas buyer expanding east. Found us through the buyer portal in the spring.", portalLead: true },
  { company: "Comanche Springs Minerals", domain: "comanchesprings.demo", first: "Lacey", last: "Driscoll", street: "1 Marienfeld Pl., Suite 300", city: "Midland", state: "TX", zip: "79701", areaCode: "432", status: "HOT", regions: ["PERMIAN"], counties: ["Reeves", "Upton", "Martin"], formations: ["Wolfcamp", "Bone Spring", "Spraberry"], assetTypes: ["MI", "RI", "NPRI"], minNma: 1, maxNma: 50, minPrice: 30_000, maxPrice: 1_800_000, tags: ["Permian", "Delaware Basin", "Closes fast"], notes: "Aggressive on Reeves County Wolfcamp. Will pre-clear title in-house to shorten closing." },
  { company: "Whitetail Ridge Royalty", domain: "whitetailridge.demo", first: "Dustin", last: "Kemp", street: "1001 W. Loop S., Suite 750", city: "Houston", state: "TX", zip: "77027", areaCode: "713", status: "COLD", regions: ["EAST", "EAGLE_FORD"], counties: ["Grimes", "Madison", "Houston", "Gonzales"], formations: ["Woodbine", "Austin Chalk", "Eagle Ford"], assetTypes: ["MI"], minNma: 25, maxNma: 640, minPrice: 50_000, maxPrice: 1_000_000, tags: ["Austin Chalk"], notes: "Inactive this year after their fund closed. Keep on outreach for large Chalk packages only.", active: false },
];

// ---------------------------------------------------------------------------
// Contacts (sellers, heirs, prospects, landmen)
// ---------------------------------------------------------------------------
export const FIRST_NAMES = [
  "Dorothy", "Wayne", "Linda Sue", "Raymond", "Patricia", "Earl", "Martha", "Clifton", "Brenda", "Harold",
  "Juanita", "Gerald", "Carolyn", "Ricky", "Bobbie", "Lonnie", "Imogene", "Dwight", "Rosa", "Glenn",
  "Sharon", "Melvin", "Delores", "Curtis", "Nell", "Arturo", "Janice", "Roy Dale", "Peggy", "Floyd",
  "Teresa", "Calvin", "Wanda", "Mitchell", "Opal", "Rogelio", "Sandra", "Vernon", "Loretta", "Kenneth",
];
export const LAST_NAMES = [
  "Kimbrough", "Fulcher", "Tidwell", "Castillo", "Holcomb", "Bledsoe", "Gage", "Reyes", "Whitley", "Pruett",
  "Ochoa", "Satterwhite", "Cockrell", "Hensley", "Barrow", "McAdams", "Villegas", "Rountree", "Easley", "Garner",
  "Treadway", "Moncrief", "Zamora", "Lockett", "Birdwell", "Shackelford", "Nunley", "Ybarra", "Colquitt", "Durham",
  "Hargrove", "Pickens", "Sandoval", "Tullos", "Weatherby", "Alaniz", "Brumley", "Coker", "Ivey", "Strother",
];
export const STREETS = [
  "418 W. Elm St.", "9302 Hwy 79 E", "12 Pecan Hollow Dr.", "5106 Wildflower Ln.", "306 S. Commerce St.",
  "2207 FM 1119", "1408 County Road 311", "P.O. Box 412", "7731 Briar Forest Dr.", "915 Live Oak St.",
  "4420 Old Spanish Trl.", "P.O. Box 1187", "230 Bluebonnet Cir.", "6017 Post Oak Ln.", "1840 FM 977",
  "88 Cedar Ridge Rd.", "3305 Hackberry Ct.", "P.O. Box 76", "2611 Mockingbird Ln.", "540 County Road 4410",
];
// Out-of-area addresses (heirs who moved away).
export const DISTANT_TOWNS: { city: string; state: string; zip: string; areaCode: string }[] = [
  { city: "Houston", state: "TX", zip: "77019", areaCode: "713" }, { city: "Austin", state: "TX", zip: "78731", areaCode: "512" },
  { city: "Dallas", state: "TX", zip: "75214", areaCode: "214" }, { city: "San Antonio", state: "TX", zip: "78209", areaCode: "210" },
  { city: "Tyler", state: "TX", zip: "75703", areaCode: "903" }, { city: "Waco", state: "TX", zip: "76710", areaCode: "254" },
  { city: "Fort Worth", state: "TX", zip: "76107", areaCode: "817" }, { city: "Shreveport", state: "LA", zip: "71106", areaCode: "318" },
  { city: "Oklahoma City", state: "OK", zip: "73118", areaCode: "405" }, { city: "Denver", state: "CO", zip: "80206", areaCode: "720" },
];
export const CONTACT_SOURCES = ["Direct mail — Q2 2026", "Direct mail — Q3 2026", "Inbound call", "Landman referral", "Courthouse research", "Website inquiry", "Probate records", "Buyer referral"];

export const LANDMEN: { first: string; last: string; entity: string; city: string; zip: string; areaCode: string }[] = [
  { first: "Dale", last: "Montgomery", entity: "Montgomery Land Services", city: "Bryan", zip: "77802", areaCode: "979" },
  { first: "Charla", last: "Westbrook", entity: "Westbrook Title & Land", city: "Centerville", zip: "75833", areaCode: "903" },
  { first: "Hector", last: "Garza", entity: "Brush Country Land Co.", city: "Kenedy", zip: "78119", areaCode: "830" },
  { first: "Tanner", last: "Rhodes", entity: "Permian Field Land Services", city: "Midland", zip: "79701", areaCode: "432" },
];

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
export const DEAD_REASONS = [
  "Title defect — unresolved heirship break in the 1950s chain; seller would not fund an affidavit of heirship",
  "Seller backed out after a family dispute over the interest",
  "Operator released the lease; no buyer interest at the contract price",
  "Buyer financing fell through and the contract expired",
];

export const PORTAL_SUMMARIES = [
  "Producing mineral interest inside an active horizontal unit. Clean title chain, division orders in hand and 18 months of check stubs available in the data room.",
  "Non-producing acreage offsetting recent permits. Strong development upside with an active operator drilling two miles to the north.",
  "Royalty interest under a 1/4 lease with a top-tier operator. Six producing horizontals on the unit, steady monthly checks.",
  "Undivided mineral interest across two surveys. Lease expires next year — a buyer can capture the next lease bonus.",
  "Small, clean NPRI with long production history. Ideal add-on for a royalty portfolio; title opinion summary attached.",
];

export const EMAIL_TEMPLATES: { name: string; subject: string; body: string }[] = [
  {
    name: "New package — initial outreach",
    subject: "New acquisition package: {{deal}} ({{county}} County)",
    body: "Hi {{buyer}},\n\nWe just put {{deal}} under contract and wanted {{company}} to have the first look. The package includes the PSA summary, plat, title run sheet and the latest production we have.\n\nAsking price: {{askPrice}}.\n\nHappy to walk through it on a call this week — just reply with a good time.\n\nThanks,\n{{sender}}\nBrazos Ridge Minerals",
  },
  {
    name: "Follow-up — package review",
    subject: "Following up: {{deal}}",
    body: "Hi {{buyer}},\n\nChecking in on {{deal}}. Has your team had a chance to review the package? We have a couple of other groups looking at it, so I wanted to make sure {{company}} had what it needs before we set a call for offers.\n\nLet me know if you want the division orders or check stubs.\n\nBest,\n{{sender}}",
  },
  {
    name: "Price improvement",
    subject: "Price update on {{deal}}",
    body: "Hi {{buyer}},\n\nQuick update: we've adjusted the ask on {{deal}} in {{county}} County to {{askPrice}}. Title is clean through the current owner and we can close inside 30 days.\n\nIf this now fits {{company}}'s buy box, I'd love to get an offer from you this week.\n\nThanks,\n{{sender}}",
  },
  {
    name: "Call for best and final",
    subject: "Best and final offers due Friday — {{deal}}",
    body: "Hi {{buyer}},\n\nWe've received multiple offers on {{deal}} and are asking everyone for their best and final by Friday at 5 pm CT. Please include your proposed closing timeline and any conditions.\n\nThank you for your interest,\n{{sender}}\nBrazos Ridge Minerals",
  },
];

export const EXPENSE_CATEGORIES: { name: string; color: string; range: [number, number]; notes: string[] }[] = [
  { name: "Title & Curative", color: "#8B5CF6", range: [350, 2800], notes: ["Title run sheet — {deal}", "Affidavit of heirship prep — {deal}", "Curative: probate copies and recording — {deal}", "Title opinion summary — {deal}"] },
  { name: "Recording Fees", color: "#06B6D4", range: [26, 185], notes: ["Recording fees — mineral deed, {county} County", "E-recording: deed + memorandum, {county} County", "Recording: correction deed, {county} County"] },
  { name: "Travel", color: "#F59E0B", range: [45, 620], notes: ["Mileage — {county} County courthouse trip", "Hotel — {county} County records research", "Seller meeting — lunch and mileage, {county} County"] },
  { name: "Mailers & Marketing", color: "#EC4899", range: [450, 3200], notes: ["Direct mail campaign — {county} County owners", "Postage — follow-up postcards", "Printing — offer letters (1,200 pcs)"] },
  { name: "Data Subscriptions", color: "#3B82F6", range: [199, 1250], notes: ["Monthly production data subscription", "Online county records access", "Skip-trace credits"] },
  { name: "Legal", color: "#EF4444", range: [400, 3500], notes: ["PSA review — {deal}", "Estate/probate consult — {deal}", "Outside counsel: curative opinion — {deal}"] },
  { name: "Courthouse Research", color: "#22C55E", range: [40, 320], notes: ["Certified copies — {county} County Clerk", "Abstract plant fees — {county} County", "Probate file copies — {county} County"] },
];

// ---------------------------------------------------------------------------
// Well Analysis fallback (used only when rrc.wells is absent)
// ---------------------------------------------------------------------------
export interface FallbackWell {
  name: string;
  api: string; // 10-digit API, digits only (42 + county code + 5)
  operator: string;
  lease: string;
  field: string;
  formation: string;
  county: string;
  trajectory: "HORIZONTAL" | "VERTICAL";
  wellType: "OIL" | "GAS";
  firstProd: string; // YYYY-MM
  qiOil: number; // bbl/month
  qiGas: number; // mcf/month
  b: number;
  diAnnual: number; // nominal initial decline, fraction per year
  lat: number;
  lon: number;
}

export const FALLBACK_WELLS: FallbackWell[] = [
  { name: "HIDALGO UNIT #1H", api: "4228934512", operator: "Comstock Oil & Gas, LLC", lease: "HIDALGO UNIT", field: "Carthage (Haynesville)", formation: "Haynesville", county: "Leon", trajectory: "HORIZONTAL", wellType: "GAS", firstProd: "2023-03", qiOil: 0, qiGas: 610_000, b: 0.9, diAnnual: 0.78, lat: 31.268, lon: -96.019 },
  { name: "HIDALGO UNIT #2H", api: "4228934519", operator: "Comstock Oil & Gas, LLC", lease: "HIDALGO UNIT", field: "Carthage (Haynesville)", formation: "Haynesville", county: "Leon", trajectory: "HORIZONTAL", wellType: "GAS", firstProd: "2023-05", qiOil: 0, qiGas: 575_000, b: 0.9, diAnnual: 0.8, lat: 31.262, lon: -96.011 },
  { name: "LEDBETTER-HEARNE #1H", api: "4239532877", operator: "Comstock Oil & Gas, LLC", lease: "LEDBETTER-HEARNE", field: "Bald Prairie (Bossier)", formation: "Bossier", county: "Robertson", trajectory: "HORIZONTAL", wellType: "GAS", firstProd: "2022-09", qiOil: 0, qiGas: 520_000, b: 0.95, diAnnual: 0.74, lat: 31.071, lon: -96.312 },
  { name: "DEL CORRAL GAS UNIT #4", api: "4216131620", operator: "XTO Energy Inc.", lease: "DEL CORRAL GAS UNIT", field: "Teague (Cotton Valley)", formation: "Cotton Valley", county: "Freestone", trajectory: "VERTICAL", wellType: "GAS", firstProd: "2019-06", qiOil: 0, qiGas: 24_000, b: 0.5, diAnnual: 0.35, lat: 31.703, lon: -96.245 },
  { name: "GROCE RANCH #2H", api: "4218530344", operator: "Ranger Oil Corporation", lease: "GROCE RANCH", field: "Giddings (Austin Chalk)", formation: "Austin Chalk", county: "Grimes", trajectory: "HORIZONTAL", wellType: "OIL", firstProd: "2023-08", qiOil: 14_500, qiGas: 21_000, b: 1.0, diAnnual: 0.85, lat: 30.441, lon: -95.975 },
  { name: "MILLICAN A #3H", api: "4204132561", operator: "Magnolia Oil & Gas Operating LLC", lease: "MILLICAN A", field: "Giddings (Austin Chalk)", formation: "Austin Chalk", county: "Brazos", trajectory: "HORIZONTAL", wellType: "OIL", firstProd: "2022-11", qiOil: 12_800, qiGas: 18_500, b: 1.0, diAnnual: 0.82, lat: 30.468, lon: -96.198 },
  { name: "NAVARRO-FLORES #5H", api: "4225537109", operator: "EOG Resources, Inc.", lease: "NAVARRO-FLORES", field: "Eagleville (Eagle Ford-2)", formation: "Eagle Ford", county: "Karnes", trajectory: "HORIZONTAL", wellType: "OIL", firstProd: "2022-04", qiOil: 21_000, qiGas: 30_000, b: 1.1, diAnnual: 0.9, lat: 28.912, lon: -97.861 },
  { name: "PETTUS UNIT #12H", api: "4225537146", operator: "EOG Resources, Inc.", lease: "PETTUS UNIT", field: "Eagleville (Eagle Ford-2)", formation: "Eagle Ford", county: "Karnes", trajectory: "HORIZONTAL", wellType: "OIL", firstProd: "2023-01", qiOil: 18_400, qiGas: 26_000, b: 1.1, diAnnual: 0.88, lat: 28.884, lon: -97.832 },
  { name: "KERR-LOCKHART #2H", api: "4217733058", operator: "EOG Resources, Inc.", lease: "KERR-LOCKHART", field: "Eagleville (Eagle Ford-1)", formation: "Eagle Ford", county: "Gonzales", trajectory: "HORIZONTAL", wellType: "OIL", firstProd: "2021-10", qiOil: 16_200, qiGas: 9_800, b: 1.0, diAnnual: 0.86, lat: 29.391, lon: -97.402 },
  { name: "BLK 34 SEC 24 UNIT #4AH", api: "4231742815", operator: "Pioneer Natural Resources USA, LLC", lease: "BLK 34 SEC 24 UNIT", field: "Spraberry (Trend Area)", formation: "Wolfcamp", county: "Martin", trajectory: "HORIZONTAL", wellType: "OIL", firstProd: "2023-06", qiOil: 26_000, qiGas: 41_000, b: 1.1, diAnnual: 0.92, lat: 32.214, lon: -101.876 },
  { name: "BLK 34 SEC 24 UNIT #5SH", api: "4231742822", operator: "Pioneer Natural Resources USA, LLC", lease: "BLK 34 SEC 24 UNIT", field: "Spraberry (Trend Area)", formation: "Spraberry", county: "Martin", trajectory: "HORIZONTAL", wellType: "OIL", firstProd: "2023-07", qiOil: 22_500, qiGas: 33_000, b: 1.1, diAnnual: 0.9, lat: 32.209, lon: -101.869 },
  { name: "PECOS VALLEY 56-14 #2H", api: "4238937251", operator: "Diamondback E&P LLC", lease: "PECOS VALLEY 56-14", field: "Phantom (Wolfcamp)", formation: "Wolfcamp", county: "Reeves", trajectory: "HORIZONTAL", wellType: "OIL", firstProd: "2022-12", qiOil: 24_000, qiGas: 62_000, b: 1.05, diAnnual: 0.9, lat: 31.487, lon: -103.612 },
];

// ---------------------------------------------------------------------------
// Opportunities (prospects that have not gone under contract)
// ---------------------------------------------------------------------------
export const OPPORTUNITY_PLAN: { stage: string; reason?: string; convert?: boolean }[] = [
  { stage: "NEW_OPPORTUNITY" }, { stage: "NEW_OPPORTUNITY" }, { stage: "NEW_OPPORTUNITY" },
  { stage: "RESEARCHING" }, { stage: "RESEARCHING" }, { stage: "RESEARCHING" },
  { stage: "CONTACTED" }, { stage: "CONTACTED" }, { stage: "CONTACTED" },
  { stage: "INTERESTED" }, { stage: "INTERESTED" },
  { stage: "NEGOTIATING" },
  { stage: "NEGOTIATING", convert: true }, { stage: "NEGOTIATING", convert: true }, { stage: "NEGOTIATING", convert: true },
  { stage: "PASSED", reason: "Interest is a 1/64 NPRI — too small to market after closing costs" },
  { stage: "LOST", reason: "Seller accepted a competing cash offer from a local buyer" },
];

export const OPPORTUNITY_NOTES = [
  "Heir to the original grantee; three siblings share the interest equally.",
  "Owner received an unsolicited offer and wants a second opinion on value.",
  "Mailer response — wants to sell before year-end for tax reasons.",
  "Interest appears in the 1974 probate; need to confirm the chain before an offer.",
  "Leased to the operator in 2022; unit plat shows two producing laterals.",
  "Seller is open to selling half and keeping half.",
];
