# Mineral Hub CRM

A CRM for a mineral-rights wholesaling business: track deals from contract to
close, manage buyer relationships, auto-match buyers to deals, and report on
profitability. Ships with an **empty database** and one bootstrapped Owner user.

- **`server/`** — Express + Prisma + PostgreSQL API (TypeScript, ESM)
- **`client/`** — Vite + React + TypeScript SPA

Frontend and backend deploy as **two separate services** (e.g. two Railway
subdomains). The API sets `SameSite=None; Secure` cookies and locks CORS to the
frontend origin so cookie auth works cross-origin.

---

## Features

- **Dashboard** — Active Deals, Projected Profit, Closed Profit YTD, Avg Deal
  Size, Offers Pending; overdue banner, active-by-stage, follow-ups, activity
  feed, top buyers YTD, profit-by-month chart.
- **Pipeline** — Kanban (Under Contract → Preparing Package → Sent to Buyers →
  Negotiating → Closing → Closed → Dead) with drag-and-drop stage changes.
- **Deals** — filterable, fully sortable table; deal detail with editable
  characteristics, contract timeline, marketing log, live match recommendations,
  and document uploads.
- **Buyers** — simplified list + inline CSV import wizard; full buyer profiles
  with buy-box criteria, deal history, tags.
- **Reports** — closed-deal report with period chips, totals, and Win Rate.

### Core logic (single source of truth)
- **Deadline math** — `server/src/domain/dates.ts`. Find Buyer By = Under
  Contract + 15 days; Final Closing = Original Closing + 15 days; manual
  overrides win until reverted. Configurable in `server/src/config.ts`.
- **Priority** (computed live, never stored) — `server/src/domain/priority.ts`.
- **Matching engine** (live, weighted to 100) — `server/src/domain/matching.ts`.
- **Metrics** (close rate, net profit, gross fee, win rate) —
  `server/src/domain/metrics.ts`.

---

## Local development

### Prerequisites
- Node 20+
- A PostgreSQL database
- (Optional) an S3 bucket for file uploads

### 1. Backend
```bash
cd server
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, S3_* (optional)
npm install
npx prisma migrate deploy     # create tables in an empty DB (applies prisma/migrations)
npm run bootstrap:admin       # create the single Owner user (interactive)
npm run dev                   # http://localhost:4000
```

### 2. Frontend
```bash
cd client
npm install
npm run dev                   # http://localhost:5173 (proxies /api -> :4000)
```

Sign in with the Owner credentials you created.

### Tests
```bash
cd server && npm test         # domain logic unit tests (dates, priority, matching, metrics)
```

---

## Deploying to Railway

Three services in one project: **Postgres**, **API** (`server/`), **Frontend**
(`client/`). Each app service uses its subdirectory as its root; the `railway.json`
in each subdir defines build/start commands.

### Environment variables

**API service** (`server/`):
| Var | Value |
| --- | --- |
| `DATABASE_URL` | reference the Postgres service's connection URL |
| `JWT_SECRET` | long random string |
| `NODE_ENV` | `production` |
| `COOKIE_CROSS_SITE` | `true` |
| `CORS_ORIGINS` | the frontend's public URL, e.g. `https://<frontend>.up.railway.app` |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | for file uploads |

**Frontend service** (`client/`):
| Var | Value |
| --- | --- |
| `VITE_API_BASE` | the API's public URL, e.g. `https://<api>.up.railway.app` (inlined at build) |

> `VITE_API_BASE` is read at **build time** — redeploy the frontend after changing it.

### After first deploy
Run the admin bootstrap once against the production DB (Railway shell or locally
with the prod `DATABASE_URL`):
```bash
ADMIN_NAME="You" ADMIN_EMAIL="you@co.com" ADMIN_PASSWORD="<strong>" npm run bootstrap:admin
```

### Database migrations

The schema is applied on each API start via `node scripts/migrate-deploy.mjs`,
which runs `prisma migrate deploy` (forward-only, never destructive). A database
that predates migration history (built by the old `prisma db push` flow) is
baselined automatically on its first deploy: the `0_init` migration is marked
as already applied, then any newer migrations run.

**Changing the schema:** edit `prisma/schema.prisma`, then generate a migration
instead of pushing:

```bash
cd server
npx prisma migrate dev --name describe_your_change   # against your dev DATABASE_URL
```

Commit the generated folder under `prisma/migrations/` — production applies it
on the next deploy. Never use `db push` against production; it bypasses history
and can silently drop data on destructive changes (this bit us once converting
scalars to arrays).
