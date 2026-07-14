// Sentry must initialize before Express/route modules load — keep this first.
import "./instrument.js";
import { createApp } from "./app.js";
import { env, assertProductionSecrets } from "./config.js";
import { ensureUsersHaveOrganizations } from "./services/org.js";
import { backfillBuyerStatus } from "./services/backfill.js";
import { startIntegrationScheduler } from "./services/integrationSync.js";
import { startPortalReminderScheduler } from "./services/portalReminders.js";
import { startDealAlertScheduler } from "./services/dealAlerts.js";

// Fail closed: in production, refuse to boot with default/missing secret keys.
assertProductionSecrets();

const app = createApp();

// Background re-validation of connected integrations on their configured schedule.
startIntegrationScheduler();

// Periodic reminder digest of unactioned buyer-portal offers/leads.
startPortalReminderScheduler();
startDealAlertScheduler();

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
