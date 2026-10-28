// Pipeline stages are customizable per org, so a stage is just its key. The
// seven built-in keys below are the defaults; CLOSED and DEAD are permanent.
export type Stage = string;
export interface PipelineStage { id: string; key: string; label: string; position: number; isTerminal: boolean; color?: string | null }

export type Priority = "HIGH" | "MEDIUM" | "LOW";
export type Relationship = "HOT" | "WARM" | "COLD";
export type BuyerStatus =
  | "CONTACTED" | "NO_RESPONSE" | "INTERESTED" | "REVIEWING" | "OFFER_RECEIVED" | "NEGOTIATING" | "ACCEPTED" | "PASSED" | "CLOSED";
export type CommKind = "EMAIL_OUT" | "EMAIL_IN" | "PHONE" | "MEETING" | "NOTE" | "NEGOTIATION" | "STATUS_CHANGE";

export interface TimelineEntry {
  id: string;
  kind: CommKind;
  subject: string | null;
  body: string | null;
  occurredAt: string;
  createdBy: UserRef | null;
  threadId: string | null;
}

export interface DealSummary {
  id: string;
  name: string;
  /** Pipeline the deal belongs to; null = the org's default pipeline. */
  pipelineId?: string | null;
  counties: string[];
  state: string | null;
  states: string[];
  acreageNma: number | null;
  nra: number | null;
  abstractIds: string[];
  sellerNames: string[];
  operator: string | null;
  /** Custom Documents folder list (empty = module defaults). */
  docFolders?: string[];
  askPrice: number | null;
  ourPrice: number | null;
  ourCostPerNma?: number | null;
  ourCostPerNra?: number | null;
  askPricePerNma?: number | null;
  askPricePerNra?: number | null;
  /** Contracted days to close; beyond 30 extends the auto Find Buyer By. */
  daysToClose?: number | null;
  /** Accepted offer, else best offer (the basis of profitEst); null = no offers. */
  buyerPurchasePrice?: number | null;
  assetTypes: string[];
  stage: Stage;
  publishedToPortal?: boolean;
  portalSlug?: string | null;
  daysInStage: number;
  priority: Priority;
  profitEst: number | null;
  /** Ask price − Our Cost − closing costs (what we'd make selling at our ask); null without both prices. */
  profitAtAsk?: number | null;
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
  /** Manual "Closing with buyer" date (never calculated). */
  buyerClosingDate?: string | null;
  selectedBuyer: { id: string; name: string; companyName: string } | null;
  selectedOfferId: string | null;
  relationshipOwner: UserRef | null;
  assignees: UserRef[];
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
  /** Set when the deal is hidden from the Deals list's default view (Hide deal).
   *  Visibility only — nothing else about the deal changes. */
  hiddenAt?: string | null;
}

/** Deals list visibility: which deals the list and its metrics include. */
export type DealsVisibility = "ACTIVE" | "HIDDEN" | "ALL";

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
  states: string[]; counties: string[]; assetTypes: string[];
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
  assignedTeamMember: { id: string; name: string; avatarColor?: string | null } | null;
  timeline: TimelineEntry[];
}

/** A person as the API shows them everywhere (owner, assignee, creator…): the shared avatar's data. */
export interface UserRef { id: string; name: string; firstName?: string | null; lastName?: string | null; avatarColor?: string | null }
export interface UserLite extends UserRef { email?: string; role?: string; }

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
  assignedTeamMember: { id: string; name: string; avatarColor?: string | null } | null;
  /** The shared Contact this seller is linked to (source of truth for the shared fields). */
  contact?: { id: string; name: string } | null;
  dateAdded: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Opportunities — lightweight prospects that live in OPPORTUNITIES-kind
// pipelines (never Deals). Converting one creates a Deal from its data.
// ---------------------------------------------------------------------------
export type PipelineKind = "DEALS" | "OPPORTUNITIES";
export type ConvertMode = "MANUAL" | "AUTO";
export type OppActivityKind = "NOTE" | "CALL" | "EMAIL" | "TEXT" | "MEETING" | "SYSTEM";

/** Board row (GET /opportunities?pipelineId=…). */
export interface OppSummary {
  id: string;
  name: string;
  pipelineId: string;
  stage: Stage;
  currentStageEnteredAt: string;
  owner: UserRef | null;
  contactId: string | null;
  sellerName: string | null;
  companyName: string | null;
  state: string | null;
  county: string | null;
  abstract: string | null;
  survey: string | null;
  estAcres: number | null;
  estNma: number | null;
  estNra: number | null;
  source: string | null;
  lastActivityAt: string | null;
  /** Calendar day at UTC midnight (same convention as task due dates). */
  nextFollowUpDate: string | null;
  convertedDealId: string | null;
  convertedAt: string | null;
  closeReason: string | null;
  createdAt: string;
}

export interface OppStageHistoryRow {
  id: string;
  fromStage: Stage;
  toStage: Stage;
  reason: string | null;
  changedBy: UserRef | null;
  createdAt: string;
}

export interface OppActivityRow {
  id: string;
  kind: OppActivityKind | string;
  body: string;
  createdBy: UserRef | null;
  createdAt: string;
}

/** Full record (GET /opportunities/:id). */
export interface Opp extends OppSummary {
  phone: string | null;
  email: string | null;
  notes: string | null;
  contact: OppContact | null;
  convertedDeal: { id: string; name: string; stage: Stage } | null;
  stageHistory: OppStageHistoryRow[];
  activities: OppActivityRow[];
  /** Documents (current versions) and the customized folder list (empty = defaults). */
  files: OppFile[];
  docFolders: string[];
}

/**
 * A contact's mineral interest (GET /contacts/:id/minerals): the deal they are
 * a seller on, or their not-yet-converted prospect — the record itself, not a
 * copy. `status` is the deal's SYSTEM status from its stage key.
 */
export interface ContactMineralInterest {
  kind: "deal" | "opportunity";
  id: string;
  dealId?: string;
  opportunityId?: string;
  name: string;
  status: "UNDER_CONTRACT" | "CLOSED" | "DEAD" | "PROSPECT";
  stage: string;
  pipelineId: string | null;
  recordType?: string;
  currentStageEnteredAt: string;
  states: string[];
  counties: string[];
  abstractIds: string[];
  surveys: string[];
  assetTypes?: string[];
  grossAcres: number | null;
  acreageNma: number | null;
  nra: number | null;
  royaltyRate?: string | null;
  operator?: string | null;
  rrc?: string | null;
  leaseStatus?: string | null;
  leaseStatuses?: string[];
  leaseInfo?: string | null;
  leaseEffectiveDate?: string | null;
  leaseExpirationDate?: string | null;
  ownershipPercent?: number | null;
  isPrimary?: boolean;
  dateUnderContract?: string | null;
  originalClosingDate?: string | null;
  closedDate?: string | null;
  owner: UserRef | null;
}

/** The linked seller Contact as the opportunity shows it. */
export interface OppContact {
  id: string; firstName: string; lastName: string; entityName: string | null; phone: string | null; email: string | null;
  preferredContact?: string | null;
  mailingStreet?: string | null; mailingCity?: string | null; mailingState?: string | null; mailingZip?: string | null;
}

export interface OppFile {
  id: string; category: string; folder: string; filename: string; mimeType: string; sizeBytes: number;
  uploadedBy: UserRef | null; createdAt: string; updatedAt?: string; versionCount?: number;
}

/** One time an accepted offer set the deal's asking price (deal detail → Asking price history). */
export interface AskPriceHistoryRow {
  id: string; at: string; summary: string; actor: UserRef | null;
  before: { askPrice: number | null; askPricePerNma: number | null; askPricePerNra: number | null } | null;
  after: { askPrice: number | null; askPricePerNma: number | null; askPricePerNra: number | null } | null;
  offerId: string | null; offerAmount: number | null; buyerId: string | null; buyerName: string | null;
  /** A legacy deal with no Our Price kept its previous asking price as Our Price. */
  ourPriceKeptFromAsk: number | null;
}

/** One "Extended +N days" action on a deal's Contract timeline (deal detail). */
export interface ContractExtension {
  id: string;
  fromDate: string;
  toDate: string;
  days: number;
  extendedBy: (Omit<UserRef, "name"> & { name: string | null }) | null;
  createdAt: string;
}
