import type { DealSummary } from "../types";

/**
 * One searchable haystack per deal/asset row, shared by the Deals pages and
 * Mineral Assets so search behaves identically everywhere. Covers every
 * indexed identifier a user might reach for: name, sellers, abstracts,
 * surveys, geography, buyer, owner, operator, wells, RRC, asset types,
 * ownership.
 */
export function dealSearchHaystack(d: DealSummary): string {
  return [
    d.name,
    ...(d.sellerNames ?? []),
    // Abstract ids are stored as gis keys (e.g. "TX-145-455"); include both the
    // raw id and a digits-only form so typing "455" or "A-455" both match.
    ...d.abstractIds,
    ...d.abstractIds.map((a) => a.replace(/[^0-9]/g, "")),
    ...d.surveys,
    ...d.counties,
    ...d.states,
    d.state,
    d.selectedBuyer?.name,
    d.selectedBuyer?.companyName,
    d.relationshipOwner?.name,
    ...d.assignees.map((a) => a.name),
    d.operator,
    ...d.wells,
    d.rrc,
    ...d.assetTypes,
    d.ownershipType,
    d.producingStatus,
  ]
    .filter(Boolean)
    .join(" \u0000 ")
    .toLowerCase();
}
