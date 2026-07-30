// Redesigned navigation icon set (Dashboard reference) — geometric, rounded,
// consistent 1.7 stroke. Each component mirrors the lucide-react call shape
// (accepts `size`) so Sidebar treats both families interchangeably.
// Pipeline intentionally stays on its original lucide icon (user request).
import type { SVGProps } from "react";

interface NavIconProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> { size?: number | string }

function base({ size = 17, ...rest }: NavIconProps) {
  return {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.7,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    style: { flexShrink: 0 }, ...rest,
  };
}

export function DashboardIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <rect x="3" y="3" width="8" height="8" rx="2.5" />
      <rect x="13" y="3" width="8" height="5" rx="2.5" />
      <rect x="13" y="10" width="8" height="11" rx="2.5" />
      <rect x="3" y="13" width="8" height="8" rx="2.5" />
    </svg>
  );
}

export function DealsIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <path d="M14 3h6a1 1 0 0 1 1 1v6L11 20l-7-7L14 3z" />
      <circle cx="16.5" cy="7.5" r="1.6" />
    </svg>
  );
}

export function MineralsIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3l7 4.5v9L12 21l-7-4.5v-9L12 3z" />
      <path d="M12 3v18M5 7.5l7 4.5 7-4.5" />
    </svg>
  );
}

export function BuyersIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16 4.6a3.4 3.4 0 0 1 0 6.8M18.5 14.6c1.9 1 2.5 2.8 2.5 5.4" />
    </svg>
  );
}

export function ContactsIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="M4 8h16M9 13a2 2 0 1 0 4 0 2 2 0 0 0-4 0zM8 18c.6-1.5 1.7-2.2 3-2.2s2.4.7 3 2.2" />
    </svg>
  );
}

export function MapPinIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 21s-6.5-5.3-6.5-10a6.5 6.5 0 0 1 13 0c0 4.7-6.5 10-6.5 10z" />
      <circle cx="12" cy="11" r="2.4" />
    </svg>
  );
}

export function ResearchIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21M8 10.5h5M10.5 8v5" />
    </svg>
  );
}

export function WellsIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 21h16M8 21V9a4 4 0 0 1 8 0v12" />
      <path d="M12 3v2M12 9v2M12 15v2" strokeWidth={2} />
    </svg>
  );
}

export function ReportsIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" strokeWidth={2} />
    </svg>
  );
}

export function ExpensesIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15 9.2c-.6-.9-1.7-1.4-3-1.4-1.8 0-3 .9-3 2.1s1.2 1.8 3 2.1c1.8.3 3 .9 3 2.1s-1.2 2.1-3 2.1c-1.3 0-2.4-.5-3-1.4M12 6v1.8M12 16.2V18" />
    </svg>
  );
}

export function PortalIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3 10l9-6 9 6v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9z" />
      <path d="M9.5 21v-6h5v6" />
    </svg>
  );
}

export function SettingsGearIcon(p: NavIconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 7.08 4.14l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
    </svg>
  );
}
