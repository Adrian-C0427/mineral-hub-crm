import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

/**
 * The application's single tab bar. Every page-level tab strip (Deal page,
 * Mineral Asset Hold/Sell, Deals scopes, future modules) renders through this
 * component so height, padding, typography, and hover/active states stay
 * identical everywhere — and future styling updates apply app-wide.
 *
 * A tab with `to` renders as a router link; otherwise it's a button driven by
 * `onSelect`.
 */
export interface TabDef<K extends string = string> {
  key: K;
  label: ReactNode;
  /** Route target — renders a NavLink instead of a button. */
  to?: string;
  /** Optional tooltip (useful when labels are kept short). */
  title?: string;
  hidden?: boolean;
}

export function Tabs<K extends string>({ tabs, active, onSelect, style }: {
  tabs: TabDef<K>[];
  active: K;
  onSelect?: (key: K) => void;
  style?: React.CSSProperties;
}) {
  return (
    <div className="asset-tabs" role="tablist" style={style}>
      {tabs.filter((t) => !t.hidden).map((t) => {
        const cls = `tab ${active === t.key ? "active" : ""}`;
        return t.to ? (
          <NavLink key={t.key} to={t.to} end className={cls} role="tab" aria-selected={active === t.key} title={t.title}>{t.label}</NavLink>
        ) : (
          <button key={t.key} type="button" className={cls} role="tab" aria-selected={active === t.key} title={t.title} onClick={() => onSelect?.(t.key)}>{t.label}</button>
        );
      })}
    </div>
  );
}
