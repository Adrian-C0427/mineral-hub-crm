/**
 * Integration catalog — the single source of truth for which third-party
 * integrations the app offers, how each authenticates, and how far its
 * implementation has gotten. The client renders this catalog verbatim
 * (GET /api/integrations/catalog); adding a provider is one entry here plus,
 * if it takes an API key, a validator in services/integrationProviders.ts.
 *
 * 2026-07 ecosystem cut (docs/integrations-audit.md): the roadmap moved to a
 * small set of integrations that are each FULLY functional in production.
 * Removed entirely: Perplexity, Gmail, Slack, OpenAI, Gemini, Dropbox, Box,
 * Google Calendar, Mailchimp, and Google Sign-In. Every remaining entry does
 * real work the moment it is connected:
 *  - Resend delivers all outbound email (primary provider; SMTP is fallback).
 *  - Teams receives deal/portal notifications on its webhook.
 *  - Outlook, OneDrive and Google Drive are connected per team member
 *    (`personal`, routes/accounts.ts): a mail client and two file managers.
 *  - Outlook Calendar mirrors deal deadlines as calendar events.
 *  - Claude powers deal summaries and outreach drafts.
 *  - HighLevel (LeadConnector) mirrors the org's texting history READ-ONLY
 *    for Reports → SMS performance (services/highlevel/).
 *
 * `implementation` is what the UI keys its honesty off:
 *  - "live"    — connect stores an encrypted credential and we validate it
 *                against the provider's API right now.
 *  - "env"     — built-in service configured via environment variables on the
 *                API host (Railway); status reflects the real runtime config.
 *  - "oauth"   — connect runs the integration OAuth flow (services/
 *                integrationOAuth.ts); connectable once the provider's client
 *                credentials are set, otherwise shown as "Setup required".
 */

export type IntegrationAuth = "apikey" | "webhook" | "oauth" | "env";
export type ImplementationStatus = "live" | "env" | "oauth";

export interface ProviderDef {
  key: string;
  name: string;
  category: string;
  auth: IntegrationAuth;
  implementation: ImplementationStatus;
  description: string;
  /** Label for the secret input (apikey/webhook providers). */
  secretLabel?: string;
  /** Placeholder / format hint shown under the secret input. */
  secretHint?: string;
  /** Where an admin creates the credential or app registration. */
  setupUrl?: string;
  /** Whether periodic sync (scheduled re-validation + data pull) applies. */
  syncable?: boolean;
  /** Connected per team member (routes/accounts.ts), not once for the org. */
  personal?: boolean;
}

export const INTEGRATION_CATALOG: ProviderDef[] = [
  // --- Email & Communication ---
  {
    key: "resend", name: "Resend", category: "Email & Communication", auth: "apikey", implementation: "live",
    description: "Primary email delivery for the whole app — buyer outreach, portal notifications, reminders, invitations, and password resets all send through Resend once connected. Verify your sending domain at Resend, paste an API key, and set the sender identity; the key and domain status are validated live.",
    secretLabel: "Resend API key", secretHint: "re_…", setupUrl: "https://resend.com/api-keys", syncable: true,
  },
  {
    key: "smtp", name: "SMTP (fallback email)", category: "Email & Communication", auth: "env", implementation: "env",
    description: "Fallback outbound email through your own mail server, used only when Resend is not connected. Configured with SMTP_* environment variables on the API service; status reflects the live configuration.",
  },
  {
    key: "outlook", name: "Microsoft Outlook / 365", category: "Email & Communication", auth: "oauth", implementation: "oauth",
    description: "Each team member connects their own Outlook / Microsoft 365 mailbox. Read, reply to and forward email inside the CRM; send from your own address with your Outlook signature (it lands in your Sent Items); attach documents; and keep conversations with contacts, buyers, deals and opportunities on their records. Microsoft Graph with Mail.ReadWrite and Mail.Send.",
    setupUrl: "https://portal.azure.com", syncable: true, personal: true,
  },
  {
    key: "teams", name: "Microsoft Teams", category: "Email & Communication", auth: "webhook", implementation: "live",
    description: "Deal and portal notifications (new portal leads, offers, buyer email replies) post to a Teams channel via a Power Automate Workflows webhook. Paste the workflow URL; connecting posts a confirmation card.",
    secretLabel: "Workflow webhook URL", secretHint: "https://….logic.azure.com/workflows/…",
    setupUrl: "https://support.microsoft.com/office/creating-a-workflow-from-a-channel-in-teams",
  },
  {
    key: "highlevel", name: "HighLevel (LeadConnector)", category: "Email & Communication", auth: "apikey", implementation: "live",
    description: "Brings your HighLevel texting history into Reports → SMS performance: how many texts went out, who replied, how fast, who opted out, and which lists, tags and team members get the best response. Mineral Hub never sends texts and never stores their wording; it only reads from HighLevel — unless you turn on HighLevel tags in Configure, which lets it add and remove its own SMS and Acquisition tags (nothing else). Works with white-label HighLevel accounts such as XLeads.",
    secretLabel: "Private Integration key", secretHint: "pit-…",
    setupUrl: "https://help.gohighlevel.com/support/solutions/articles/155000003054-private-integrations-everything-you-need-to-know",
    syncable: true,
  },

  // --- AI & Automation ---
  {
    key: "claude", name: "Claude (Anthropic)", category: "AI & Automation", auth: "apikey", implementation: "live",
    description: "Draft outreach and summarize deals with Anthropic Claude. The key is verified against the Anthropic API when you connect.",
    secretLabel: "Anthropic API key", secretHint: "sk-ant-…", setupUrl: "https://console.anthropic.com/settings/keys", syncable: true,
  },

  // --- Storage & Documents ---
  {
    key: "storage", name: "Object storage (S3-compatible)", category: "Storage & Documents", auth: "env", implementation: "env",
    description: "Deal and buyer file attachments in S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2). Configured with S3_* environment variables on the API service; uploads/downloads use short-lived signed URLs.",
  },
  {
    key: "googledrive", name: "Google Drive", category: "Storage & Documents", auth: "oauth", implementation: "oauth",
    description: "Each team member connects their own Google Drive: browse, search, upload, organize and preview files (Docs, Sheets and Slides included), and link them to deals, opportunities, contacts, buyers and mineral assets without copying them. Google Drive API, drive scope (Workspace-internal app).",
    setupUrl: "https://console.cloud.google.com/apis/credentials", syncable: true, personal: true,
  },
  {
    key: "onedrive", name: "Microsoft OneDrive", category: "Storage & Documents", auth: "oauth", implementation: "oauth",
    description: "Each team member connects their own OneDrive: browse, search, upload, organize and preview files, and link them to deals, opportunities, contacts, buyers and mineral assets without copying them. Microsoft Graph with Files.ReadWrite (the same Entra ID app registration as Microsoft sign-in).",
    setupUrl: "https://portal.azure.com", syncable: true, personal: true,
  },

  // --- Productivity ---
  {
    key: "outlookcalendar", name: "Outlook Calendar", category: "Productivity", auth: "oauth", implementation: "oauth",
    description: "Mirrors deal deadlines — find-buyer-by, closing, and extended closing dates — as events on your Outlook calendar, kept up to date on each sync (Calendars.ReadWrite via Microsoft Graph).",
    setupUrl: "https://portal.azure.com", syncable: true,
  },

  // --- Authentication ---
  {
    key: "entra", name: "Microsoft Entra ID", category: "Authentication", auth: "env", implementation: "env",
    description: "Single sign-on with Microsoft Entra ID (OpenID Connect). Configured with MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET on the API service; status reflects the live configuration.",
  },
];

export const providerByKey = (key: string): ProviderDef | undefined =>
  INTEGRATION_CATALOG.find((p) => p.key === key);

/**
 * Providers retired in the 2026-07 ecosystem cut. Kept only so startup can
 * purge any credential rows an org stored while they existed.
 */
export const RETIRED_PROVIDERS = [
  "perplexity", "gmail", "slack", "openai", "gemini", "dropbox", "box",
  "googlecalendar", "mailchimp", "googlesignin",
] as const;
