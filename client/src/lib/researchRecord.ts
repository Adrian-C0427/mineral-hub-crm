/**
 * County master-file fields of a Research transaction, as people read them.
 * Mirrors server/src/domain/researchFields.ts (flags, share basis).
 */

export const DOC_FLAGS = [
  "correction", "certified-copy", "amendment", "gift", "stipulation", "outside-master-list", "estate-or-trust-seller",
] as const;

export const DOC_FLAG_LABEL: Record<string, string> = {
  correction: "Correction",
  "certified-copy": "Certified copy",
  amendment: "Amendment",
  gift: "Gift",
  stipulation: "Stipulation of interest",
  "outside-master-list": "Outside the master list",
  "estate-or-trust-seller": "Estate or trust seller",
};

/** Flags that keep a record out of buyer acquisition counts and matching. */
export const NON_ACQUISITION_FLAGS = new Set(["correction", "certified-copy", "amendment", "gift", "stipulation", "outside-master-list"]);

export const SHARE_BASIS_LABEL: Record<string, string> = {
  absolute: "Shares of the whole interest",
  "of-conveyed": "Each buyer's split of what was sold",
  unknown: "Shares don't reconcile with percent sold",
};

/** "50%", "12.5%", "42.4266%". */
export function fmtPct(n: number): string {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}%`;
}

/** Percent sold as shown: the number, or the cell as recorded when it lists several values. */
export function percentSoldText(r: { percentSold?: number | null; percentSoldRaw?: string | null }): string {
  if (r.percentSold != null) return fmtPct(r.percentSold);
  return r.percentSoldRaw ?? "";
}

/** County clerk index abbreviations, word by word. */
const ABBR: Record<string, string> = {
  CONVEYNC: "Conveyance", CONVEYN: "Conveyance", CONV: "Conveyance", MIN: "Mineral", MNRL: "Mineral", MINRL: "Mineral",
  ROY: "Royalty", ASG: "Assignment", ASGMT: "Assignment", ASGN: "Assignment", ORR: "Overriding Royalty", ORRI: "Overriding Royalty Interest",
  INTR: "Interest", COR: "Correction", CORR: "Correction", AMD: "Amended", TRSTEE: "Trustee", PROD: "Production",
  PAYMNT: "Payment", "W/D": "Warranty Deed", "Q/C": "Quitclaim", "P/ASGMT": "Partial Assignment", DEED: "Deed",
};
const SMALL = new Set(["OF", "AND", "THE", "TO"]);

/**
 * A readable label for an instrument type as the clerk recorded it:
 * "MINERAL CONVEYNC" → "Mineral Conveyance", "C C MINERAL DEED" → "Certified Copy Mineral Deed".
 * A type already written out in mixed case is returned as written.
 */
export function docTypeLabel(raw: string | null | undefined): string {
  const t = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  if (/[a-z]/.test(t)) return t;
  const words = t.replace(/\bC C\b/g, "CERTIFIED COPY").replace(/\bCC\b/g, "CERTIFIED COPY").split(" ");
  return words.map((w, i) => {
    if (ABBR[w]) return ABBR[w];
    if (w === "&") return "&";
    if (i > 0 && SMALL.has(w)) return w.toLowerCase();
    return w.split(/([/&-])/).map((p) => (/^[A-Z]/.test(p) ? p[0] + p.slice(1).toLowerCase() : p)).join("");
  }).join(" ");
}
