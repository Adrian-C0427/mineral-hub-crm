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
 *  - Outlook imports inbound buyer replies onto deal timelines.
 *  - Outlook Calendar mirrors deal deadlines as calendar events.
 *  - Google Drive / OneDrive import files into the document manager.
 *  - Claude powers deal summaries and outreach drafts.
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
    description: "Sync inbound buyer replies from your Outlook inbox — emails from known buyer addresses land on the deal timeline, mark the outreach as answered, and raise a notification. Requires an Entra ID app registration with the Mail.Read scope (the same registration used for Microsoft sign-in).",
    setupUrl: "https://portal.azure.com", syncable: true,
  },
  {
    key: "teams", name: "Microsoft Teams", category: "Email & Communication", auth: "webhook", implementation: "live",
    description: "Deal and portal notifications (new portal leads, offers, buyer email replies) post to a Teams channel via a Power Automate Workflows webhook. Paste the workflow URL; connecting posts a confirmation card.",
    secretLabel: "Workflow webhook URL", secretHint: "https://….logic.azure.com/workflows/…",
    setupUrl: "https://support.microsoft.com/office/creating-a-workflow-from-a-channel-in-teams",
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
    description: "Import documents from Google Drive straight into a deal's document manager — browse or search your Drive from the Documents section and pull files in without downloading them first. Requires the Google Cloud OAuth client with the drive.readonly scope.",
    setupUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    key: "onedrive", name: "Microsoft OneDrive", category: "Storage & Documents", auth: "oauth", implementation: "oauth",
    description: "Import documents from OneDrive into a deal's document manager via Microsoft Graph (Files.Read). Uses the same Entra ID app registration as Microsoft sign-in.",
    setupUrl: "https://portal.azure.com",
  },

  // --- Productivity ---
  {
    key: "outlookcalendar", name: "Outlook Calendar", category: "Productivity", auth: "oauth", implementation: "oauth",
    description: "Mirrors deal deadlines — find-buyer-by, original closing, and final closing dates — as events on your Outlook calendar, kept up to date on each sync (Calendars.ReadWrite via Microsoft Graph).",
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
