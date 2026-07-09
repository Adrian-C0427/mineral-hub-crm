// Pipeline stages are customizable per org, so a stage is just its key. The
// seven built-in keys below are the defaults; CLOSED and DEAD are permanent.
export type Stage = string;
export interface PipelineStage { id: string; key: string; label: string; position: number; isTerminal: boolean }

export type Priority = "HIGH" | "MEDIUM" | "LOW";
export type Relationship = "HOT" | "WARM" | "COLD";
export type BuyerStatus =
  | "CONTACTED" | "INTERESTED" | "REVIEWING" | "OFFER_RECEIVED" | "NEGOTIATING" | "PASSED" | "CLOSED";
export type CommKind = "EMAIL_OUT" | "EMAIL_IN" | "PHONE" | "MEETING" | "NOTE" | "NEGOTIATION" | "STATUS_CHANGE";

export interface TimelineEntry {
  id: string;
  kind: CommKind;
  subject: string | null;
  body: string | null;
  occurredAt: string;
  createdBy: string | null;
  threadId: string | null;
}

export interface DealSummary {
  id: string;
  name: string;
  counties: string[];
  state: string | null;
  states: string[];
  acreageNma: number | null;
  nra: number | null;
  abstractIds: string[];
  askPrice: number | null;
  ourPrice: number | null;
  assetTypes: string[];
  basins: string[];
  formations: string[];
  stage: Stage;
  publishedToPortal?: boolean;
  portalSlug?: string | null;
  daysInStage: number;
  priority: Priority;
  profitEst: number | null;
  isOverdue: boolean;
  dateUnderContract: string | null;
  originalClosingDate: string | null;
  findBuyerByDate: string | null;
  finalClosingDate: string | null;
  findBuyerByIsOverridden: boolean;
  finalClosingIsOverridden: boolean;
  findBuyerByAuto: string | null;
  finalClosingAuto: string | null;
  closedDate: string | null;
  selectedBuyer: { id: string; name: string; companyName: string } | null;
  selectedOfferId: string | null;
  relationshipOwner: { id: string; name: string } | null;
  assignees: { id: string; name: string }[];
  estimatedClosingCosts: number | null;
  // Record discriminator + owned-asset fields (null/undefined for opportunities).
  recordType: RecordType;
  assetMode: AssetMode | null;
  acquisitionDate: string | null;
  purchasePrice: number | null;
  currentValue: number | null;
  bookValue: number | null;
  ownershipStatus: string | null;
  ownershipType: string | null;
  workingInterest: number | null;
  netRevenueInterest: number | null;
  surveys: string[];
  wells: string[];
  producingStatus: string | null;
  rrc: string | null;
  royaltyIncomeAnnual: number | null;
  // Current-lease redesign.
  leaseStatuses: string[];
  royaltyRate: string | null;
  leaseEffectiveDate: string | null;
  leaseExpirationDate: string | null;
  // Deprecated (kept on the type for back-compat; no longer shown in the UI).
  leaseStatus: string | null;
  leaseInfo: string | null;
  divisionOrdersNote: string | null;
  taxInfo: string | null;
  roiSinceAcquisition: number | null;
  unrealizedGainLoss: number | null;
  // Multi-asset grouping: parentDealId is set on a child asset; assetCount is the
  // number of child assets on a package (present on list rows). agg* are the
  // package's rolled-up totals (own + children) for display; equal the own value
  // when there are no children.
  parentDealId?: string | null;
  assetCount?: number;
  aggNra?: number | null;
  aggAcreageNma?: number | null;
  aggOurPrice?: number | null;
  aggAskPrice?: number | null;
}

/** Compact child-asset summary shown within its parent package on the deal page. */
export interface AssetChild {
  id: string;
  name: string;
  stage: Stage;
  counties: string[];
  states: string[];
  assetTypes: string[];
  nra: number | null;
  ourPrice: number | null;
  askPrice: number | null;
  operator: string | null;
  rrc: string | null;
  publishedToPortal: boolean;
  portalSlug: string | null;
  selectedBuyer: { id: string; name: string } | null;
}

export type RecordType = "OPPORTUNITY" | "OWNED_ASSET";
export type AssetMode = "HOLD" | "SELL";

export interface RevenueEntry {
  id: string;
  month: string;
  amount: number;
  kind: string;
  operator: string | null;
  note: string | null;
}

export interface BuyBox {
  states: string[]; counties: string[]; basins: string[]; formations: string[]; assetTypes: string[];
  minAcreage: number | null; maxAcreage: number | null; minPrice: number | null; maxPrice: number | null;
}

export interface MatchCriterion { key: string; label: string; weight: number; matched: boolean; detail: string; }

export interface MatchRec {
  rank: number;
  buyerId: string;
  buyerName: string;
  companyName: string;
  matchPercent: number;
  matching: MatchCriterion[];
  nonMatching: MatchCriterion[];
  /** How many buy-box criteria this buyer actually specified / matched. */
  criteriaSpecified: number;
  criteriaSpecifiedMatched: number;
  owners: string[];
  previousDealsClosed: number;
  lastContactDate: string | null;
  stale: boolean;
}

export interface BuyerActivityRow {
  id: string;
  buyerId: string;
  buyerName: string;
  companyName: string;
  matchPercent: number;
  dateSent: string | null;
  status: BuyerStatus;
  responseReceived: boolean;
  offerAmount: number | null;
  lastActivityDate: string | null;
  nextFollowUpDate: string | null;
  notes: string | null;
  sentBy: string | null;
  assignedTeamMember: { id: string; name: string } | null;
  timeline: TimelineEntry[];
}

export interface UserLite { id: string; name: string; email?: string; role?: string; }

export type SellerType = "INDIVIDUAL" | "TRUST" | "LLC" | "CORPORATION" | "ESTATE" | "PARTNERSHIP" | "OTHER";

export interface Seller {
  id: string;
  isPrimary: boolean;
  ownershipPercent: number | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  companyName: string | null;
  trustName: string | null;
  sellerType: SellerType;
  primaryPhone: string | null;
  secondaryPhone: string | null;
  email: string | null;
  preferredContactMethod: string | null;
  mailingAddress: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
  physicalAddress: string | null;
  physicalCity: string | null;
  physicalState: string | null;
  physicalZip: string | null;
  internalNotes: string | null;
  preferredCommunicationNotes: string | null;
  /** Only present when the caller holds viewSellerTaxId; otherwise hasTaxId flags existence. */
  taxId?: string | null;
  hasTaxId: boolean;
  assignedTeamMember: { id: string; name: string } | null;
  dateAdded: string;
  updatedAt: string;
}
