# Integration Audit & Infrastructure Readiness — July 2026

A feasibility audit of every integration listed in **Settings → Integrations**,
plus the infrastructure decisions behind the resulting framework. Ground rule:
build on the existing **GitHub + Railway + Neon** stack; add services only when
those three genuinely can't cover the need.

The catalog itself now lives server-side in
`server/src/domain/integrationCatalog.ts` — the UI renders whatever that file
declares, so this document and the running product can't drift apart silently:
every provider below maps 1-to-1 to a catalog entry (or to a removal).

## 1. Audit results by provider

### Ready now — live credential validation implemented (12)

These authenticate with an API key or webhook URL, which the app can hold and
verify today. On connect, the credential is validated against the provider's
API **before** anything is stored, then encrypted at rest (AES-256-GCM). Test
and Sync re-validate on demand or on a schedule.

| Provider | Official method | Validation call |
|---|---|---|
| Claude (Anthropic) | REST API, API key | `GET /v1/models` (free) |
| OpenAI | REST API, API key | `GET /v1/models` (free) |
| Google Gemini | REST API, API key | `GET /v1beta/models` (free) |
| Perplexity | REST API (OpenAI-compatible), API key | 1-token `sonar` completion (~fractions of a cent; Perplexity has no free ping endpoint) |
| Mapbox | REST API, access token | `GET /tokens/v2` introspection (free) |
| Google Maps Platform | REST API, API key | Single geocode (in-body status handled) |
| ArcGIS Location Platform | REST API, API key | Single geocode |
| Calendly | REST API v2, personal access token | `GET /users/me` |
| HubSpot | Private-app access token (HubSpot's recommended method for single-account integrations) | `GET /account-info/v3/details` |
| Mailchimp | REST API, API key (datacenter suffix) | `GET /3.0/ping` |
| Slack | Incoming webhooks (officially supported) | URL-shape check + confirmation post to the channel |
| Microsoft Teams | **Power Automate Workflows webhook** — classic Office 365 connectors were retired by Microsoft in 2025, so the integration targets the supported replacement | URL-shape check + adaptive-card confirmation post |

### Built-in infrastructure — configured via environment variables (4)

Already implemented in the codebase as inert-until-configured services. The
Integrations page now reflects their **real** runtime status instead of a
tracked pretend-status, and Test performs a live check.

| Provider | Where it lives | Test performs |
|---|---|---|
| SMTP outbound email | `services/email.ts`, `SMTP_*` env vars | `transporter.verify()` against the mail server |
| Object storage (S3-compatible) | `services/s3.ts`, `S3_*` env vars | `HeadBucket` against the configured bucket |
| Google Sign-In | `services/oauth.ts`, `GOOGLE_CLIENT_*` | Reflects enabled-provider status |
| Microsoft Entra ID | `services/oauth.ts`, `MICROSOFT_CLIENT_*` | Reflects enabled-provider status |

### Supported, pending OAuth app registration (12)

All of these have official OAuth 2.0 APIs and fit the existing
provider-registry pattern in `services/oauth.ts` ("adding a provider is data,
not code"). What's missing is not code feasibility but **client credentials**:
each needs an app registration in the provider's console, a client id/secret
in Railway env vars, and scope-specific token handling. The UI now labels them
**"Setup required"** with a link to the registration console, and the connect
endpoint refuses honestly instead of recording a fake connection.

- **Microsoft Graph family** (Outlook mail, Outlook Calendar, OneDrive) — one
  Entra ID app registration covers all three plus sign-in; scopes per feature.
- **Google family** (Gmail, Google Calendar, Google Drive) — one Google Cloud
  OAuth client covers all three plus sign-in.
- **Dropbox, Box** — standard OAuth apps.
- **QuickBooks Online, Xero** — OAuth 2.0 with refresh tokens (both officially
  documented; QuickBooks tokens expire aggressively, so the refresh plumbing
  below is a prerequisite).
- **Salesforce** — connected app, OAuth 2.0.
- **Okta** — plain OIDC; one entry in the oauth.ts registry once an Okta app
  exists.

When these are enabled, tokens should be stored with the same AES-256-GCM
encryption (`services/secrets.ts`), refresh tokens included, and refreshed
server-side ahead of expiry — the storage shape (`config._secret`) already
accommodates a JSON token bundle.

### Removed — cannot be implemented as listed (5)

| Removed | Why |
|---|---|
| Texas RRC "API key" | **The RRC has no public API.** Its data ships as bulk mainframe files and GIS exports. The app already integrates RRC data the correct way: the `tools/rrc/` pipeline (dbf900/daf802/gse10 parsers) and Research → Data & Imports. An "API key" entry was unimplementable and misleading. |
| QGIS / QGIS Server | Desktop GIS + self-hosted map server, not a SaaS you connect with a credential. The map stack (MapLibre + static GeoJSON + optional Mapbox/ArcGIS/Google) covers the need. |
| Custom API Integration | A placeholder with no defined behavior. Extension points belong in the roadmap items below, not as a fake connectable card. |
| API Keys (platform feature) | Issuing keys for *our* API is a real roadmap item, but it's a platform capability, not a third-party integration — it was removed from the catalog until it exists. |
| Webhooks (platform feature) | Same reasoning: outbound webhooks are feasible (Express + fetch + HMAC signatures) and worth building, but shouldn't be listed as connectable before they work. |

## 2. Infrastructure evaluation (GitHub + Railway + Neon)

**Sufficient as-is for the integration framework.** Nothing in this audit
requires a new always-on service:

| Need | Covered by | Notes |
|---|---|---|
| Secrets management | **Railway env vars** + AES-256-GCM at rest in Neon | Provider credentials users paste in are encrypted with `INTEGRATION_SECRET_KEY` (falls back to a key derived from `JWT_SECRET` — set the dedicated var in production so JWT rotation doesn't orphan stored credentials). OAuth client secrets stay in env vars, never in the DB. A dedicated secrets manager (Vault, Doppler) is not justified at this team size. |
| Background jobs / scheduling | **In-process scheduler** (`services/integrationSync.ts`) | Railway runs one long-lived container, so a 15-minute `setInterval` tick covers scheduled re-validation. If job volume ever grows (real data syncs, retries with backoff), the next step is a Neon-backed job table + worker loop — still no new service. Railway cron is available for heavier isolated jobs. |
| Audit logging | **Existing `ActivityLog` table in Neon** | Connect/disconnect/config/test/sync events are logged with the acting user and surface in the dashboard activity feed. No new infrastructure. |
| Webhook receiving (future) | **Express on Railway** | Public HTTPS endpoint already exists; adding `/api/hooks/:provider` routes is code, not infrastructure. |
| Logging & monitoring | **Railway logs** | Adequate today. If uptime alerting becomes a need, a free-tier external ping (UptimeRobot/Better Stack) is the cheapest add. |
| Rate-limit management / retries | Per-provider code | Validators carry 8s timeouts; sync failures record `lastError` + status ERROR rather than retry-storming. Backoff policies belong next to each future data-sync implementation. |
| Email service | **Existing SMTP integration** | Works with any provider (Gmail SMTP, Resend, Postmark, SES) purely via env vars. If deliverability/analytics matter later, Resend or Postmark via SMTP creds requires zero code change. |

**The one genuine gap: object storage.** GitHub, Railway, and Neon cannot
serve it —

- **Why needed:** deal/buyer file attachments (`FileAttachment` model and
  `routes/files.ts` are already built and waiting on configuration).
- **Why the current stack can't:** Railway containers have ephemeral
  filesystems (files vanish on redeploy); Neon is a relational store — blobs
  in Postgres bloat backups and saturate the connection pool; GitHub is
  version control, not user-file storage.
- **What it solves:** durable, private file storage with signed, expiring
  download URLs (already implemented in `services/s3.ts`).
- **Recommendation:** **Cloudflare R2** via the existing S3-compatible client
  (`S3_ENDPOINT` override) — zero egress fees and ~free at this scale; AWS S3
  or Backblaze B2 are drop-in alternates. This is configuration, not code:
  set `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`
  on the Railway API service, then the Integrations page's "Object storage"
  card flips to Connected and its Test button proves the bucket reachable.

## 3. The standardized framework (implemented)

Every integration now flows through one modular pipeline — adding a provider
is a catalog entry plus (for API-key providers) one validator function:

- **Catalog** (`domain/integrationCatalog.ts`) — provider metadata, auth type,
  implementation status; served to the client, which renders it verbatim.
- **Consistent UX** — Connected / Error / Not connected / Setup required
  status, Connect/Disconnect, live connection validation, last-sync time,
  manual "Sync now", automatic hourly/daily scheduling, per-provider
  configuration (schedule + notes), and error reporting on the card.
- **Security** — credentials validated before storage; AES-256-GCM at rest;
  never serialized to the client (masked hint only, last 4 chars); admin-only
  routes (`manageApiIntegrations` permission); full audit trail in
  ActivityLog (connection, disconnection, configuration, tests, syncs, with
  actor attribution).
- **Scheduler** (`services/integrationSync.ts`) — background re-validation on
  the configured cadence; failures flip status to ERROR with the message
  recorded, visible in UI and activity feed.

### Verified

- 128 server tests pass, including new coverage for encryption round-trip,
  tamper rejection, masking, and catalog invariants (every live provider has
  a validator; removed providers stay removed).
- Live checks against real provider APIs: a bad Anthropic key is rejected by
  Anthropic (HTTP 401) and never stored; malformed Slack/Teams URLs are
  rejected by shape; planned providers refuse connection with instructions;
  unconfigured storage/SMTP report exactly which env vars to set.
- Full lifecycle exercised end-to-end: encrypted storage (ciphertext in Neon,
  no plaintext), masked serialization, live test → ERROR status + lastError,
  disconnect purges the credential, audit rows written.

## 4. Roadmap (in dependency order)

1. **Configure object storage** (R2/S3 env vars) — unblocks file attachments;
   no code needed.
2. **Set `INTEGRATION_SECRET_KEY`** on Railway — decouples credential
   encryption from JWT rotation.
3. **Register the Google + Microsoft OAuth apps** — one registration each
   unlocks sign-in plus six planned integrations (mail, calendar, drive).
4. **OAuth token plumbing** — extend `services/oauth.ts` with offline-access
   token storage (encrypted via `services/secrets.ts`) and pre-expiry refresh;
   then flip Gmail/Outlook/Calendars/Drive/OneDrive to `live`.
5. **Accounting + CRM OAuth providers** (QuickBooks, Xero, Salesforce) once 4
   exists.
6. **Platform capabilities** — outbound webhooks (HMAC-signed) and API keys
   for programmatic access, as first-class features rather than catalog cards.
