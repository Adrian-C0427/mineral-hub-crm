# Integration Ecosystem — July 2026 (post-cleanup)

The July 2026 cleanup replaced a broad catalog with a **small ecosystem where
every listed integration is fully functional in production**. The catalog
lives server-side in `server/src/domain/integrationCatalog.ts`; the UI renders
it verbatim, so this document and the running product can't drift apart
silently.

Ground rule unchanged: build on the existing **GitHub + Railway + Neon**
stack; add services only when those three genuinely can't cover the need.

## 1. Removed (2026-07 ecosystem cut)

Removed entirely — UI, catalog entries, OAuth registry entries, validators,
env vars, and backend logic. A Prisma migration
(`20260714090000_retire_integrations`) purges any stored per-org rows and
their encrypted credentials.

| Removed | Notes |
|---|---|
| Perplexity, OpenAI, Google Gemini | AI features standardize on Claude (deal summaries, outreach drafts, tract extraction — `services/ai.ts`). |
| Gmail | Inbound reply sync standardizes on Outlook; outbound email is Resend's job now. |
| Slack | Channel notifications standardize on Microsoft Teams. |
| Dropbox, Box | Document import standardizes on Google Drive + OneDrive. |
| Google Calendar | Deadline sync standardizes on Outlook Calendar. |
| Mailchimp | Marketing-list sync dropped from the roadmap. |
| Google Sign-In | Sign-in standardizes on Microsoft Entra ID + password. The `GOOGLE_CLIENT_*` env vars remain, used only by the Google Drive integration. |

Earlier removals (RRC "API", QGIS Server, placeholder cards, Mapbox/Google
Maps/ArcGIS, QuickBooks/Xero, Calendly, HubSpot, Salesforce, Okta) predate
this cut and stay removed.

## 2. The current catalog — what each integration actually does

### Email & Communication

| Provider | Status | What flows |
|---|---|---|
| **Resend** (API key) | **Primary email provider.** | ALL outbound email — buyer outreach, portal reminder digests, password resets — routes through `services/email.ts`, which prefers the org's connected Resend key, then the `RESEND_API_KEY`/`RESEND_FROM` env fallback, then SMTP. Connect validates the key against `GET /domains`, snapshots domain verification statuses (shown as chips on the card), requires a sender identity (fromEmail/fromName), and warns when the sender's domain isn't verified. Sync refreshes the domain snapshot. |
| SMTP (env) | Fallback transport. | Used only when no Resend credential exists — keeps self-hosted installs working. |
| Microsoft Outlook / 365 (OAuth) | Live. | Inbound reply sync (`services/emailInboundSync.ts`): inbox messages from known buyer emails become EMAIL_IN timeline entries + notifications. Scope narrowed to **Mail.Read** — sending is Resend's job. Hourly by default. |
| Microsoft Teams (webhook) | Live, with real traffic. | `services/notifyPush.ts` mirrors notifications (portal leads, portal offers, buyer email replies) to the connected channel as adaptive cards with an "Open in Mineral Hub" action. |

### AI & Automation

| Provider | Status | What flows |
|---|---|---|
| Claude (API key) | Live. | Deal summaries, outreach drafting, AI tract extraction (`services/ai.ts`), using the org's own key. |

### Storage & Documents

| Provider | Status | What flows |
|---|---|---|
| Object storage (env) | Live. | S3-compatible attachment storage with signed URLs. |
| Google Drive (OAuth) | Live. | Document import (`services/cloudDocs.ts` + `/api/files/cloud/*`): browse/search Drive from any Documents section and import files into the deal/buyer document manager (Docs/Sheets/Slides export as PDF). Same mime-sniff/size gates as direct uploads. Scope: **drive.readonly**. |
| Microsoft OneDrive (OAuth) | Live. | Same import flow via Microsoft Graph. Scope narrowed to **Files.Read**. |

### Productivity

| Provider | Status | What flows |
|---|---|---|
| Outlook Calendar (OAuth) | Live. | `services/outlookCalendarSync.ts` mirrors every active deal's deadlines (find-buyer-by, original closing, final closing — resolved by `domain/dates.ts`) as all-day events, creating/patching/deleting on each sync so the calendar tracks the pipeline. Daily by default. |

### Authentication

| Provider | Status | What flows |
|---|---|---|
| Microsoft Entra ID (env) | Live. | OIDC sign-in on the login page. |

## 3. Framework invariants (unchanged)

- **Catalog-driven**: adding a provider = one catalog entry + (for API-key
  providers) one validator in `services/integrationProviders.ts`.
- **Security**: credentials validated against the provider BEFORE storage;
  AES-256-GCM at rest (`INTEGRATION_SECRET_KEY`); never serialized to the
  client (masked hint only); admin-only routes (`manageApiIntegrations`);
  full audit trail in ActivityLog. Document import endpoints live under
  `/api/files/cloud/*` gated by `manageDocuments` — admins connect once, the
  team imports freely.
- **Scheduler** (`services/integrationSync.ts`): re-validates on the
  configured cadence and runs each provider's data pull (mailbox import,
  calendar reconcile, Resend domain refresh). Failures flip status to ERROR
  with the message recorded.

## 4. Production checklist

1. **Resend**: create an API key, verify the sending domain at
   resend.com/domains, connect in Settings → Integrations with the sender
   identity. Optionally set `RESEND_API_KEY` + `RESEND_FROM` on the API
   service as the instance-wide fallback for system email.
2. **Object storage**: set `S3_*` env vars (Cloudflare R2 recommended) —
   required for uploads and cloud document import.
3. **Microsoft**: one Entra app registration covers sign-in, Outlook inbox
   sync (Mail.Read), OneDrive import (Files.Read), and Calendar sync
   (Calendars.ReadWrite).
4. **Google**: the OAuth client now serves only Drive import
   (drive.readonly).
5. `INTEGRATION_SECRET_KEY` set (required in production by
   `assertProductionSecrets`).
