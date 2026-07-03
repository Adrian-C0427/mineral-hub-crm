/**
 * Integration catalog — the single source of truth for which third-party
 * integrations the app offers, how each authenticates, and how far its
 * implementation has gotten. The client renders this catalog verbatim
 * (GET /api/integrations/catalog); adding a provider is one entry here plus,
 * if it takes an API key, a validator in services/integrationProviders.ts.
 *
 * Every entry survived the 2026-07 feasibility audit (docs/integrations-audit.md):
 * it has an officially supported integration method and is practical to run on
 * the GitHub + Railway + Neon stack. Providers that failed the audit (RRC
 * "API" — RRC publishes bulk files, not an API; QGIS Server — self-hosted GIS,
 * not a SaaS connection; the placeholder "Custom API Integration") were removed.
 *
 * `implementation` is what the UI keys its honesty off:
 *  - "live"    — connect stores an encrypted credential and we validate it
 *                against the provider's API right now.
 *  - "env"     — built-in service configured via environment variables on the
 *                API host (Railway); status reflects the real runtime config.
 *  - "oauth"   — connect runs the integration OAuth flow (services/
 *                integrationOAuth.ts); connectable once the provider's client
 *                credentials are set, otherwise shown as "Setup required".
 *  - "planned" — officially supported but not yet wired; connect is disabled.
 */

export type IntegrationAuth = "apikey" | "webhook" | "oauth" | "env";
export type ImplementationStatus = "live" | "env" | "oauth" | "planned";

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
  /** Whether periodic sync (scheduled re-validation) applies. */
  syncable?: boolean;
}

export const INTEGRATION_CATALOG: ProviderDef[] = [
  // --- Email & Communication ---
  {
    key: "smtp", name: "SMTP (outbound email)", category: "Email & Communication", auth: "env", implementation: "env",
    description: "Outbound deal emails through your mail server. Configured with SMTP_* environment variables on the API service; status reflects the live configuration.",
  },
  {
    key: "outlook", name: "Microsoft Outlook / 365", category: "Email & Communication", auth: "oauth", implementation: "oauth",
    description: "Send deal emails and sync replies via Microsoft Graph. Requires an Entra ID app registration (Mail.Send / Mail.Read) — the same registration used for Microsoft sign-in.",
    setupUrl: "https://portal.azure.com",
  },
  {
    key: "gmail", name: "Gmail / Google Workspace", category: "Email & Communication", auth: "oauth", implementation: "oauth",
    description: "Send and receive deal emails through the Gmail API. Requires a Google Cloud OAuth client with gmail.send scope — the same client used for Google sign-in.",
    setupUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    key: "slack", name: "Slack", category: "Email & Communication", auth: "webhook", implementation: "live",
    description: "Push deal and buyer notifications to a Slack channel via an incoming webhook — Slack's officially supported lightweight integration. Paste the webhook URL; connecting posts a confirmation message to the channel.",
    secretLabel: "Incoming webhook URL", secretHint: "https://hooks.slack.com/services/…",
    setupUrl: "https://api.slack.com/messaging/webhooks",
  },
  {
    key: "teams", name: "Microsoft Teams", category: "Email & Communication", auth: "webhook", implementation: "live",
    description: "Post notifications to a Teams channel via a Power Automate Workflows webhook (Microsoft retired classic Office 365 connectors in 2025; Workflows is the supported replacement). Connecting posts a confirmation card.",
    secretLabel: "Workflow webhook URL", secretHint: "https://….logic.azure.com/workflows/…",
    setupUrl: "https://support.microsoft.com/office/creating-a-workflow-from-a-channel-in-teams",
  },

  // --- AI & Automation ---
  {
    key: "claude", name: "Claude (Anthropic)", category: "AI & Automation", auth: "apikey", implementation: "live",
    description: "Draft outreach, summarize deals, and assist research with Anthropic Claude. The key is verified against the Anthropic API when you connect.",
    secretLabel: "Anthropic API key", secretHint: "sk-ant-…", setupUrl: "https://console.anthropic.com/settings/keys", syncable: true,
  },
  {
    key: "openai", name: "OpenAI", category: "AI & Automation", auth: "apikey", implementation: "live",
    description: "AI drafting and analysis via OpenAI models. The key is verified when you connect.",
    secretLabel: "OpenAI API key", secretHint: "sk-…", setupUrl: "https://platform.openai.com/api-keys", syncable: true,
  },
  {
    key: "gemini", name: "Google Gemini", category: "AI & Automation", auth: "apikey", implementation: "live",
    description: "AI assistance via the Gemini API. The key is verified when you connect.",
    secretLabel: "Gemini API key", setupUrl: "https://aistudio.google.com/apikey", syncable: true,
  },
  {
    key: "perplexity", name: "Perplexity", category: "AI & Automation", auth: "apikey", implementation: "live",
    description: "Research and answer generation via the Perplexity API. Validation issues a minimal 1-token request (fractions of a cent).",
    secretLabel: "Perplexity API key", secretHint: "pplx-…", setupUrl: "https://www.perplexity.ai/settings/api", syncable: true,
  },

  // --- GIS & Mapping ---
  {
    key: "mapbox", name: "Mapbox", category: "GIS & Mapping", auth: "apikey", implementation: "live",
    description: "Alternate basemaps and geocoding. The access token is verified via Mapbox's token introspection endpoint.",
    secretLabel: "Mapbox access token", secretHint: "pk.… (public) or sk.… (secret)", setupUrl: "https://account.mapbox.com/access-tokens/", syncable: true,
  },
  {
    key: "googlemaps", name: "Google Maps Platform", category: "GIS & Mapping", auth: "apikey", implementation: "live",
    description: "Geocoding and mapping via Google Maps Platform. Validation runs a single geocode request.",
    secretLabel: "Maps API key", setupUrl: "https://console.cloud.google.com/google/maps-apis/credentials", syncable: true,
  },
  {
    key: "arcgis", name: "ArcGIS Location Platform", category: "GIS & Mapping", auth: "apikey", implementation: "live",
    description: "Esri geocoding and feature services via an ArcGIS Location Platform API key. Validation runs a single geocode request.",
    secretLabel: "ArcGIS API key", setupUrl: "https://location.arcgis.com/", syncable: true,
  },

  // --- Storage & Documents ---
  {
    key: "storage", name: "Object storage (S3-compatible)", category: "Storage & Documents", auth: "env", implementation: "env",
    description: "Deal and buyer file attachments in S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2). Configured with S3_* environment variables on the API service; uploads/downloads use short-lived signed URLs.",
  },
  {
    key: "googledrive", name: "Google Drive", category: "Storage & Documents", auth: "oauth", implementation: "oauth",
    description: "Attach deal documents from Google Drive. Requires the Google OAuth client plus drive.file scope.",
    setupUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    key: "onedrive", name: "Microsoft OneDrive", category: "Storage & Documents", auth: "oauth", implementation: "oauth",
    description: "Attach documents from OneDrive via Microsoft Graph (Files.Read). Uses the same Entra ID app registration as Microsoft sign-in.",
    setupUrl: "https://portal.azure.com",
  },
  {
    key: "dropbox", name: "Dropbox", category: "Storage & Documents", auth: "oauth", implementation: "oauth",
    description: "Attach documents from Dropbox. Requires a Dropbox App Console OAuth app.",
    setupUrl: "https://www.dropbox.com/developers/apps",
  },
  {
    key: "box", name: "Box", category: "Storage & Documents", auth: "oauth", implementation: "oauth",
    description: "Attach documents from Box. Requires a Box developer OAuth app.",
    setupUrl: "https://app.box.com/developers/console",
  },

  // --- Productivity ---
  {
    key: "calendly", name: "Calendly", category: "Productivity", auth: "apikey", implementation: "live",
    description: "Book buyer calls and sync scheduled meetings via the Calendly API. Uses a personal access token, verified when you connect.",
    secretLabel: "Personal access token", setupUrl: "https://calendly.com/integrations/api_webhooks", syncable: true,
  },
  {
    key: "googlecalendar", name: "Google Calendar", category: "Productivity", auth: "oauth", implementation: "oauth",
    description: "Sync closing dates and follow-ups to Google Calendar (calendar.events scope on the Google OAuth client).",
    setupUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    key: "outlookcalendar", name: "Outlook Calendar", category: "Productivity", auth: "oauth", implementation: "oauth",
    description: "Sync deadlines and follow-ups via Microsoft Graph (Calendars.ReadWrite).",
    setupUrl: "https://portal.azure.com",
  },

  // --- Accounting & Finance ---
  {
    key: "quickbooks", name: "QuickBooks Online", category: "Accounting & Finance", auth: "oauth", implementation: "oauth",
    description: "Sync expenses and revenue with QuickBooks Online. Requires an Intuit developer app (OAuth 2.0 + refresh tokens).",
    setupUrl: "https://developer.intuit.com",
  },
  {
    key: "xero", name: "Xero", category: "Accounting & Finance", auth: "oauth", implementation: "oauth",
    description: "Sync expenses and revenue with Xero. Requires a Xero developer app (OAuth 2.0).",
    setupUrl: "https://developer.xero.com/app/manage",
  },

  // --- CRM & Marketing ---
  {
    key: "hubspot", name: "HubSpot", category: "CRM & Marketing", auth: "apikey", implementation: "live",
    description: "Sync buyers and activity with HubSpot using a private-app access token — HubSpot's officially recommended method for single-account integrations. Verified when you connect.",
    secretLabel: "Private app access token", secretHint: "pat-…", setupUrl: "https://developers.hubspot.com/docs/api/private-apps", syncable: true,
  },
  {
    key: "mailchimp", name: "Mailchimp", category: "CRM & Marketing", auth: "apikey", implementation: "live",
    description: "Sync buyer lists for email campaigns. The key is verified against Mailchimp's ping endpoint (the datacenter is read from the key suffix).",
    secretLabel: "Mailchimp API key", secretHint: "…-us14 (datacenter suffix required)", setupUrl: "https://admin.mailchimp.com/account/api/", syncable: true,
  },
  {
    key: "salesforce", name: "Salesforce", category: "CRM & Marketing", auth: "oauth", implementation: "oauth",
    description: "Sync buyers and deals with Salesforce. Requires a Salesforce connected app (OAuth 2.0).",
    setupUrl: "https://developer.salesforce.com",
  },

  // --- Authentication ---
  {
    key: "googlesignin", name: "Google Sign-In", category: "Authentication", auth: "env", implementation: "env",
    description: "Single sign-on with Google (OpenID Connect). Configured with GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the API service; status reflects the live configuration.",
  },
  {
    key: "entra", name: "Microsoft Entra ID", category: "Authentication", auth: "env", implementation: "env",
    description: "Single sign-on with Microsoft Entra ID (OpenID Connect). Configured with MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET on the API service; status reflects the live configuration.",
  },
  {
    key: "okta", name: "Okta", category: "Authentication", auth: "oauth", implementation: "oauth",
    description: "Single sign-on with Okta (OpenID Connect). Fits the existing OIDC provider registry — enabling it is an Okta app registration plus one provider entry.",
    setupUrl: "https://developer.okta.com",
  },
];

export const providerByKey = (key: string): ProviderDef | undefined =>
  INTEGRATION_CATALOG.find((p) => p.key === key);
