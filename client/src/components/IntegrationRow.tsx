import type { ReactNode } from "react";
import {
  Asterisk, Calendar, Cloud, Database, Folder, Inbox, Lock, Mail, MessageSquare, Send, ShieldCheck, Sparkles, Users, type LucideIcon,
} from "lucide-react";

/**
 * Settings → Integrations, the design's row layout: integrations sit as rows
 * in grouped panels. Each row: its own icon, the name with its connection type
 * (and any extra label), a two-line description, a status (dot + label), and
 * the actions on the right; details (accounts, figures) sit underneath.
 */

export const INTEGRATION_ICON: Record<string, LucideIcon> = {
  resend: Mail, smtp: Send, outlook: Inbox, teams: Users, highlevel: MessageSquare,
  claude: Asterisk, storage: Database, googledrive: Folder, onedrive: Cloud,
  outlookcalendar: Calendar, entra: ShieldCheck,
};

export const CATEGORY_ICON: Record<string, LucideIcon> = {
  "Email & Communication": Mail, "AI & Automation": Sparkles,
  "Storage & Documents": Folder, "Productivity": Calendar, "Authentication": Lock, "Team connections": Users,
};

/** The design's group order. */
export const CATEGORY_ORDER = ["Email & Communication", "AI & Automation", "Storage & Documents", "Productivity", "Authentication"];

export type RowTone = "connected" | "setup" | "error" | "off";

export function RowStatus({ tone, label, title }: { tone: RowTone; label: string; title?: string }) {
  return <span className={`ig-status ${tone}`} title={title}><i aria-hidden="true" />{label}</span>;
}

export function IntegrationGroup({ category, count, children }: { category: string; count: number; children: ReactNode }) {
  const Icon = CATEGORY_ICON[category] ?? Sparkles;
  return (
    <section className="ig-group" aria-label={category}>
      <h4 className="ig-group-label"><Icon size={13} aria-hidden="true" /> {category} <span className="ig-group-count">{count}</span></h4>
      <div className="ig-panel">{children}</div>
    </section>
  );
}

export function IntegrationRow({ iconKey, name, chips, description, tone, statusLabel, statusTitle, actions, children }: {
  iconKey: string;
  name: string;
  /** Connection type first ("API key", "OAuth 2.0", …), then any extra labels. */
  chips: string[];
  description: string;
  tone: RowTone;
  statusLabel: string;
  statusTitle?: string;
  actions?: ReactNode;
  /** Details under the row (accounts, figures, messages). */
  children?: ReactNode;
}) {
  const Icon = INTEGRATION_ICON[iconKey] ?? Sparkles;
  return (
    <div className="ig-row">
      <div className="ig-row-main">
        <span className="ig-icon" aria-hidden="true"><Icon size={17} /></span>
        <div className="ig-text">
          <div className="ig-name">
            <span>{name}</span>
            {chips.map((c) => <span key={c} className="ig-chip">{c}</span>)}
          </div>
          <p className="ig-desc" title={description}>{description}</p>
        </div>
        <div className="ig-side">
          <RowStatus tone={tone} label={statusLabel} title={statusTitle} />
          {actions && <div className="ig-actions">{actions}</div>}
        </div>
      </div>
      {children && <div className="ig-details">{children}</div>}
    </div>
  );
}
