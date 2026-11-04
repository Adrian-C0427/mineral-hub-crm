# Navigation performance & the "Something went wrong" flash — 2026-11-04

What was slow, why, what changed, and the measurements. Plain numbers from
production (Chrome, signed in, warm app, Texas → Railway `sfo`).

## 1. Baseline (before)

Every page refetched everything it shows on every visit, with a spinner
until the slowest request returned.

| Navigation | Requests | Slowest | Time to content |
|---|---|---|---|
| Dashboard → Deals | `/deals?visibility=all` **1.81 s**, `/users` 0.70 s, then `/auth/table-prefs` 0.51 s (serial) | 1.8 s | **≈ 2.4 s** |
| Deals → Dashboard | `/dashboard?period=YTD` **1.43 s**, `/users` 0.63 s | 1.4 s | ≈ 1.5 s |
| → Buyers | `/buyers` 0.96 s, `/users` 0.42 s | 1.0 s | ≈ 1.0 s |
| → Contacts | `/contacts` 0.68 s, `/users` 0.50 s, lists 0.56 s | 0.7 s | ≈ 0.9 s |
| Contacts → Deals (second visit) | `/deals` **1.45 s**, `/users` 0.49 s | 1.5 s | ≈ 1.5 s — nothing reused |

Railway's own numbers for the API over 48 h: p50 ≈ 200–280 ms even for
trivial endpoints (`/api/notifications` p50 270 ms), `/api/auth/me` p50
460–520 ms, `/api/deals` p50 0.7–1.2 s, `/api/dashboard` p50 1.0–1.7 s.
**Zero 5xx responses in 48 h; nothing new in Sentry.** CPU and memory flat.

## 2. Root causes

1. **The database is far from the API, and routes talked to it one query at
   a time.** The API runs in Railway `sfo`; Neon is in `us-east-2`. A single
   round trip measured **≈ 60–70 ms** (`SELECT 1`), a cold pooled connection
   ≈ 1 s. Any request pays one trip for the session user lookup, then one per
   query in the handler — and Prisma's default relation loading issues
   **one SQL statement per `include` relation, sequentially**. Measured:
   the deals list was **9 statements** (1.1 s from a quiet client; 1.4–1.8 s
   in production), the buyers list 6, the dashboard about **9 sequential
   awaits** (stages, deal batch, follow-ups, activity, history, offers, tasks).
   That, not CPU or data volume, is the latency.
2. **Nothing was cached on the client.** `/users` (a 6-row team list) was
   fetched by Deals, Buyers, Contacts, Dashboard, Calendar, Expenses… on
   every visit; `/deals` was refetched on every return to the page; a revisit
   showed the full spinner again.
3. **The "Something went wrong" popup is the route error boundary during a
   redeploy.** Pages are code-split; after a deploy, a tab opened earlier
   requests a chunk file that no longer exists, React throws, the boundary
   rendered its "Something went wrong loading this page" panel, and
   `componentDidCatch` immediately reloaded the page — so the panel flashed
   for a moment and vanished, followed by the full "Loading Mineral Hub…"
   screen. With **25 deploys since 25 Oct**, this was happening often. It is
   not a server failure (the API served no 5xx at all).
4. **First visits to lazy pages showed "Loading…"** while their chunk
   downloaded (Contacts, Calendar, Research, Files…), and those un-downloaded
   chunks are exactly the ones a redeploy breaks.

## 3. What changed

Server (`server/`):
- **`relationJoins`** (Prisma preview feature) with `relationLoadStrategy:
  "join"` on the hot reads — deals list, deal detail, buyers list and detail,
  contacts list, every dashboard read: one SQL statement each instead of one
  per relation. Verified locally with Prisma query logging: deals list
  **9 → 1** statement.
- **Dashboard**: all nine reads run concurrently in one `Promise.all` (was
  sequential). Notifications: list and unread count concurrently.
- **Session user cache** (`middleware/auth.ts`): the per-request user lookup
  is cached in memory for 10 s per user, saving one database trip on every
  request. Evicted at once on password change/reset, member status or role
  change, removal from the organization, and owner transfer (and the
  `sessionEpoch` check still runs against the cached row, so an evicted
  token stops within 10 s at the latest).

Client (`client/`):
- **`lib/queryCache.ts`**: a session read cache with stale-while-revalidate
  and request de-duplication. Deals, Buyers, Contacts, Dashboard, the
  pipeline board rows, the stages list, notifications polling and every
  `/users` lookup go through it. A revisit renders the last response
  instantly and refreshes behind it; lookups (`/users`, pipelines,
  table prefs) stay fresh for 5 minutes, lists for 15 s. Writes still
  refetch through the page's existing `load()`; the cache is cleared on
  sign-out and session expiry.
- **Route chunk prefetch**: once signed in and idle, the browser downloads
  the code for every sidebar page (Map excluded: 300 KB most sessions never
  open). First visits no longer show "Loading…", and a tab survives a
  redeploy because it already holds the chunks it needs.
- **Error boundary**: a stale-chunk error now shows a quiet "Updating to the
  latest version…" line while the one-shot reload happens; the error panel
  appears only if the chunk still fails *after* the reload (a genuine
  problem). Real render errors are unchanged and still visible.

Nothing about what the server returns, what a page shows, permissions or
data relationships changed. No schema or data migration (the Prisma change
is a generator flag).

## 4. After (local sandbox, same code; production numbers added after deploy)

- Deals → Buyers → Deals: the second Deals visit rendered its rows
  immediately (no spinner), with one background refresh request.
- Deals list: 1 SQL statement (was 9). Dashboard: one concurrent batch (was
  7 sequential awaits + stages).
- Server test suite: all pass; client: 172 pass; `tsc` clean.

### Production after deploy

_To be measured with the same Chrome procedure (resource timings per
navigation) once the merge is live, and appended here._

## 5. Still open / recommendations

- **Region:** the single largest fixed cost left is the ~65 ms per database
  round trip between Railway `sfo` and Neon `us-east-2`. Moving the API
  service to a US-east Railway region (a Railway setting, no code) would
  roughly halve every remaining response time. Worth doing.
- `/api/auth/me` on boot still does the session lookup + org + prefs; with
  the session cache it is one trip cheaper. The boot "Loading Mineral Hub…"
  screen is bounded by that one request.
- Research and Map pages keep their own loaders (many filtered requests);
  they were not the navigation complaint and are untouched.
- Sentry envelopes are sent on every navigation (performance tracing);
  harmless but they show up in the network tab as `/api/…/envelope`.
