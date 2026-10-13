/**
 * The comparison pill on Reports KPI tiles ("+12%", "−3.5 pts"): one rule for
 * the Deals and SMS views. Counts and money compare as a relative change; rates
 * (response rate, opt-out rate) as a point difference — 30% vs 25% is "+5 pts",
 * not "+20%".
 */
import { pct } from "./format";

export type DeltaKind = "relative" | "points";

export interface DeltaView {
  /** Signed, formatted change ("" sign when flat). */
  text: string;
  /** good = an improvement, bad = worse, flat = no visible change. */
  tone: "good" | "bad" | "flat";
}

/** A rate difference (0.053) as points to one decimal ("5.3 pts", "1 pt"). */
const pts1 = (r: number) => {
  const v = Number((r * 100).toFixed(1));
  return `${v} ${v === 1 ? "pt" : "pts"}`;
};

/**
 * `d` is the change from the server (relative ratio or rate difference);
 * `invert` marks metrics where up is bad (expenses, opt-outs, time to reply).
 * Anything that rounds to 0.0 shows unsigned and neutral, never a coloured "+0%".
 */
export function deltaView(d: number, opts: { kind?: DeltaKind; invert?: boolean } = {}): DeltaView {
  const flat = Math.abs(d) < 0.0005;
  const up = d > 0;
  const fmt = opts.kind === "points" ? pts1 : pct;
  return {
    text: `${flat ? "" : up ? "+" : "−"}${fmt(Math.abs(d))}`,
    tone: flat ? "flat" : (opts.invert ? !up : up) ? "good" : "bad",
  };
}
