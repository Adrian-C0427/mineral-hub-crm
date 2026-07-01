export type Stage =
  | "UNDER_CONTRACT" | "PREPARING_PACKAGE" | "SENT_TO_BUYERS"
  | "NEGOTIATING" | "CLOSING" | "CLOSED" | "DEAD";

export type Priority = "HIGH" | "MEDIUM" | "LOW";
export type Relationship = "HOT" | "WARM" | "COLD";
export type ResponseStatus = "PENDING" | "INTERESTED" | "NOT_INTERESTED" | "PASSED" | "OFFER_MADE";

export interface DealSummary {
  id: string;
  name: string;
  county: string | null;
  state: string | null;
  acreageNma: number | null;
  nra: number | null;
  abstractId: string | null;
  askPrice: number | null;
  assetType: string | null;
  basin: string | null;
  formation: string | null;
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
  responseStatus: ResponseStatus;
  offerAmount: number | null;
  lastActivityDate: string | null;
  notes: string | null;
}

export interface UserLite { id: string; name: string; email?: string; role?: string; }
