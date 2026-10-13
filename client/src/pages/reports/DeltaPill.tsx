import { deltaView, type DeltaKind } from "../../lib/reportDelta";

/** The comparison pill beside a Reports KPI value (Deals and SMS views). */
export function DeltaPill({ d, kind = "relative", invert = false, neutral = false }: { d: number; kind?: DeltaKind; invert?: boolean; neutral?: boolean }) {
  const v = deltaView(d, { kind, invert, neutral });
  return (
    <span className={`rp-delta ${v.tone}`} title={kind === "points" ? "Change vs the comparison period, in percentage points" : "Change vs the comparison period"}>
      {v.text}
    </span>
  );
}
