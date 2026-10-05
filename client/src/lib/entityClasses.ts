/** Colors for the research-derived behavioural entity classes (Terminal Hold,
 * Distributor, …). Shared by the Buyer Relationships badges and the Research
 * page. (Formerly exported by the retired NetworkGraph component.) These are
 * category (data) colours, so they stay fixed across themes. */
export const CLASS_COLORS: Record<string, string> = {
  TERMINAL_HOLD: "#22C55E",
  DISTRIBUTOR: "#3B82F6",
  AGGREGATOR: "#F59E0B",
  FEEDER: "#EC4899",
  PASS_THROUGH: "#8B5CF6",
  SELLER: "#A6A6A6",
  ONE_TIME_BUYER: "#06B6D4",
  UNCLASSIFIED: "#6E6E6E",
};

/** Colour for a class the table above doesn't know yet. */
export const CLASS_FALLBACK_COLOR = "#6E6E6E";
