import { useCallback, useState } from "react";

/**
 * Customize View — per-chart visualization type. Each chart that supports more
 * than one representation (e.g. bar vs line, or bar vs pie) gets a small
 * segmented control in its panel header. The choice is saved per user in
 * localStorage keyed by a stable chart id, so it survives reloads and is
 * independent across charts.
 */
export type ChartType = "bar" | "line" | "area" | "pie";

const KEY = (id: string) => `mh-charttype:${id}`;

/** Read/write a single chart's saved type, falling back to `fallback`. */
export function useChartType(id: string, allowed: ChartType[], fallback: ChartType): [ChartType, (t: ChartType) => void] {
  const [type, setTypeState] = useState<ChartType>(() => {
    try {
      const raw = localStorage.getItem(KEY(id));
      if (raw && (allowed as string[]).includes(raw)) return raw as ChartType;
    } catch { /* ignore */ }
    return allowed.includes(fallback) ? fallback : allowed[0];
  });
  const setType = useCallback((t: ChartType) => {
    setTypeState(t);
    try { localStorage.setItem(KEY(id), t); } catch { /* ignore */ }
  }, [id]);
  return [type, setType];
}

const LABELS: Record<ChartType, string> = { bar: "Bar", line: "Line", area: "Area", pie: "Pie" };

function Icon({ t }: { t: ChartType }) {
  const p = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (t) {
    case "bar": return <svg {...p}><line x1="6" y1="20" x2="6" y2="11" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="18" y1="20" x2="18" y2="14" /></svg>;
    case "line": return <svg {...p}><polyline points="3 17 9 11 13 15 21 6" /></svg>;
    case "area": return <svg {...p}><path d="M3 17l6-6 4 4 8-9v14H3z" /></svg>;
    case "pie": return <svg {...p}><path d="M12 2a10 10 0 1 0 10 10h-10z" /><path d="M12 2v10h10" /></svg>;
  }
}

/** Segmented icon control shown in a chart panel header. */
export function ChartTypeToggle({ type, options, onChange }: { type: ChartType; options: ChartType[]; onChange: (t: ChartType) => void }) {
  if (options.length < 2) return null;
  return (
    <div className="chart-type-toggle" role="group" aria-label="Chart type">
      {options.map((t) => (
        <button
          key={t}
          type="button"
          className={t === type ? "active" : ""}
          aria-pressed={t === type}
          title={`${LABELS[t]} chart`}
          onClick={() => onChange(t)}
        >
          <Icon t={t} />
        </button>
      ))}
    </div>
  );
}
