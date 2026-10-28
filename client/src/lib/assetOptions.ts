/**
 * Mineral Asset selectors — the module-specific vocab (ownership, producing
 * and lease status) shared by the Create Asset form, the asset page and the
 * portfolio list so every screen offers the same choices. Deal-shared vocab
 * (asset types, royalty rates) lives in lib/options.ts and lib/royalty.ts.
 */
export const OWNERSHIP_TYPES = ["Mineral", "Royalty", "Overriding Royalty (ORRI)", "Working Interest", "NPRI", "Leasehold"];
export const OWNERSHIP_STATUSES = ["Active", "Leased", "Held by Production", "Encumbered", "Non-producing"];
export const PRODUCING_STATUSES = ["Producing", "Shut-in", "Non-producing", "Permitted"];
export const LEASE_STATUS_OPTIONS = ["Leased", "Held By Production", "Expired", "In Negotiation", "Unleased", "Top Lease", "Shut-in"];

/** Hold / For sale — the asset's lifecycle mode (SELL assets also appear in the Pipeline). */
export const ASSET_MODE_LABEL: Record<"HOLD" | "SELL", string> = { HOLD: "Hold", SELL: "For sale" };
