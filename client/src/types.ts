export type Stage =
  | "UNDER_CONTRACT" | "PREPARING_PACKAGE" | "SENT_TO_BUYERS"
  | "NEGOTIATING" | "CLOSING" | "CLOSED" | "DEAD";

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
  acreageNma: number | null;
  nra: number | null;
  abstractIds: string[];
  askPrice: number | null;
  ourPrice: number | null;
  assetTypes: string[];
  basins: string[];
  formations: string[];
  stage: Stage;
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
  selectedBuyer: { id: string; name: string; companyName: string } | null;
  selectedOfferId: string | null;
  relationshipOwner: { id: string; name: string } | null;
  estimatedClosingCosts: number | null;
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
