/**
 * Bespoke navigation icon set.
 *
 * One construction system across the whole set — 24×24 grid, 1.6px strokes,
 * round caps/joins, no fills except deliberate accents — so the sidebar reads as
 * a single, considered family rather than a grab-bag of stock glyphs. Each glyph
 * is tuned to its section's meaning (a decline curve for Well Analysis, a gem
 * for Mineral Assets, a compass for Research, sliders for Settings…).
 *
 * Every component takes a lucide-compatible `size` prop so it drops into the
 * existing sidebar markup unchanged.
 */
import type { ReactNode } from "react";

export type NavIcon = (props: { size?: number }) => JSX.Element;

/** Shared frame: keeps stroke weight, caps, and colour identical everywhere. */
function Glyph({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden focusable="false"
    >
      {children}
    </svg>
  );
}

/** Dashboard — an asymmetric bento grid: an overview composed of tiles. */
export const DashboardIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <rect x="3" y="3" width="7.6" height="8.4" rx="1.6" />
    <rect x="13.4" y="3" width="7.6" height="5" rx="1.6" />
    <rect x="3" y="14.6" width="7.6" height="6.4" rx="1.6" />
    <rect x="13.4" y="11" width="7.6" height="10" rx="1.6" />
  </Glyph>
);

/** Deals — a price/offer tag: the acquisition opportunity. */
export const DealsIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <path d="M12.7 2.7A2 2 0 0 0 11.3 2H4.2A2.2 2.2 0 0 0 2 4.2v7.1a2 2 0 0 0 .6 1.4l8.6 8.6a2.3 2.3 0 0 0 3.3 0l6.5-6.5a2.3 2.3 0 0 0 0-3.3Z" />
    <circle cx="7.4" cy="7.4" r="1.3" />
  </Glyph>
);

/** Mineral Assets — a brilliant-cut gem: owned mineral value. */
export const AssetsIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <path d="M12 2.5 19.6 9 12 21.5 4.4 9Z" />
    <path d="M4.4 9h15.2" />
    <path d="M8.7 2.5 12 9l3.3-6.5" />
    <path d="M12 9v12.5" />
  </Glyph>
);

/** Pipeline — staged progress along a track (first stages filled). */
export const PipelineIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <path d="M5.5 12h13" />
    <circle cx="5.5" cy="12" r="2.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="2.4" />
  </Glyph>
);

/** Buyers — a small group of people. */
export const BuyersIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.6 20v-1a5.4 5.4 0 0 1 10.8 0v1" />
    <path d="M16 5.3a3.2 3.2 0 0 1 0 5.4" />
    <path d="M18.2 14.4a5.4 5.4 0 0 1 3.2 4.6V20" />
  </Glyph>
);

/** Map — a folded trifold field map. */
export const MapNavIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <path d="M3 6.6 9 4l6 2.6 6-2.6v13.4L15 20l-6-2.6L3 20Z" />
    <path d="M9 4v13.4" />
    <path d="M15 6.6V20" />
  </Glyph>
);

/** Research — a compass: market exploration & intelligence. */
export const ResearchIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M15.7 8.3 13.4 13.4 8.3 15.7 10.6 10.6Z" />
  </Glyph>
);

/** Well Analysis — a hyperbolic decline curve on a light axis. */
export const WellAnalysisIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <path d="M4.5 3.5v16.5H21" opacity="0.5" />
    <path d="M7 7.5C9.6 14.2 12.6 16.1 18.5 16.8" />
    <circle cx="7" cy="7.5" r="1.35" fill="currentColor" stroke="none" />
  </Glyph>
);

/** Reports — ascending bars. */
export const ReportsIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <rect x="4" y="12" width="3.4" height="8" rx="1" />
    <rect x="10.3" y="8" width="3.4" height="12" rx="1" />
    <rect x="16.6" y="4" width="3.4" height="16" rx="1" />
  </Glyph>
);

/** Expenses — a receipt. */
export const ExpensesIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <path d="M6 3h12v17.5l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3Z" />
    <path d="M9.5 8h5" />
    <path d="M9.5 11.5h5" />
    <path d="M9.5 15h3" />
  </Glyph>
);

/** Buyer Portal — a storefront: the public marketplace. */
export const PortalIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <path d="M3 9 5 4h14l2 5" />
    <path d="M3 9h18" />
    <path d="M4.6 9v11h14.8V9" />
    <path d="M10 20v-6h4v6" />
  </Glyph>
);

/** Settings — horizontal sliders: precise controls. */
export const SettingsNavIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <path d="M4 6.5h4" />
    <path d="M11 6.5h9" />
    <path d="M9.5 4.5v4" />
    <path d="M4 12.5h9" />
    <path d="M16 12.5h4" />
    <path d="M14.5 10.5v4" />
    <path d="M4 18.5h5" />
    <path d="M12 18.5h8" />
    <path d="M10.5 16.5v4" />
  </Glyph>
);

/** Notifications — a bell (used in the sidebar footer). */
export const BellIcon: NavIcon = (p) => (
  <Glyph {...p}>
    <path d="M18 8.5a6 6 0 1 0-12 0c0 6-2.2 7.5-2.2 7.5h16.4S18 14.5 18 8.5" />
    <path d="M10.3 20a2 2 0 0 0 3.4 0" />
  </Glyph>
);
