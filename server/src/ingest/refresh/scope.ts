import type { CountyScope } from "./dataset.js";

/**
 * The Texas counties the bundled RRC refresh covers. Adding a county here is
 * the whole scope change: the builder reads its well{code}.zip + surv{code}.zip,
 * the cycle script lists them for download, and the loader inserts its wells
 * at the next deploy. RRC's district ledgers in REFRESH_LEDGERS must cover the
 * county's district (gas gsf002l = districts 04–06; oil olf003l = 03, olf005l = 05–06).
 */
export const REFRESH_COUNTIES: CountyScope[] = [
  { code: "073", name: "Cherokee" },
  { code: "161", name: "Freestone" },
  { code: "203", name: "Harrison" },
  { code: "289", name: "Leon" },
];

export const REFRESH_LEDGERS = { gas: ["gsf002l.ebc.gz"], oil: ["olf003l.ebc.gz", "olf005l.ebc.gz"] } as const;
