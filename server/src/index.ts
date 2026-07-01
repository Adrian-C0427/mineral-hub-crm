import { createApp } from "./app.js";
import { env } from "./config.js";
import { ensureUsersHaveOrganizations } from "./services/org.js";
import { backfillBuyerStatus } from "./services/backfill.js";

const app = createApp();

// Idempotent backfill so every existing user has an organization (multi-tenancy).
ensureUsersHaveOrganizations().catch((e) =>
  console.error("Org backfill failed:", e instanceof Error ? e.message : e),
);

// Idempotent backfill of the new buyer pipeline status from legacy responseStatus.
backfillBuyerStatus().catch((e) =>
  console.error("Buyer status backfill failed:", e instanceof Error ? e.message : e),
);

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Mineral Hub API listening on :${env.PORT} (${env.NODE_ENV})`);
});
