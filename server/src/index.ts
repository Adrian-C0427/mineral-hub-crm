// Sentry must initialize before Express/route modules load — keep this first.
import "./instrument.js";
import { createApp } from "./app.js";
import { env, assertProductionSecrets } from "./config.js";
import { ensureUsersHaveOrganizations } from "./services/org.js";
import { backfillBuyerStatus } from "./services/backfill.js";
import { startIntegrationScheduler } from "./services/integrationSync.js";
import { startPortalReminderScheduler } from "./services/portalReminders.js";
import { startDealAlertScheduler } from "./services/dealAlerts.js";
import { startDemoResetScheduler } from "./services/demoReset.js";
import { backfillTransactionInterests } from "./services/researchInterestBackfill.js";
import { ensureGisRegions } from "./services/gisRegions.js";
import { ensureSonrisWells } from "./services/sonrisWells.js";
import { clearGisCaches } from "./routes/gis.js";

// Fail closed: in production, refuse to boot with default/missing secret keys.
assertProductionSecrets();

const app = createApp();

// Background re-validation of connected integrations on their configured schedule.
startIntegrationScheduler();

// Periodic reminder digest of unactioned buyer-portal offers/leads.
startPortalReminderScheduler();
startDealAlertScheduler();
// Demo/showcase workspace: created on first boot from env (DEMO_REFERENCE_ORG +
// DEMO_USER_PASSWORD), login kept in sync, optional nightly reseed (DEMO_AUTO_RESET).
startDemoResetScheduler();

// Idempotent backfill so every existing user has an organization (multi-tenancy).
ensureUsersHaveOrganizations().catch((e) =>
  console.error("Org backfill failed:", e instanceof Error ? e.message : e),
);

// Idempotent backfill of the new buyer pipeline status from legacy responseStatus.
backfillBuyerStatus().catch((e) =>
  console.error("Buyer status backfill failed:", e instanceof Error ? e.message : e),
);

// Idempotent, lossless: conveyed-interest shares written into recorded party
// names ("ABC MINERALS LLC – 50%") become their own data on older records.
backfillTransactionInterests().catch((e) =>
  console.error("Conveyed-interest backfill failed:", e instanceof Error ? e.message : e),
);

// Idempotent, additive: Louisiana Haynesville parishes + PLSS sections, bundled
// with the server, upserted into the gis schema when missing or out of date
// (Texas rows are never touched). Then the bundled Louisiana WELL data (Red
// River Parish wells, bores, unit production) into the sonris schema — run
// after, not alongside, since both create gis.dataset_version on a first boot.
// Tiles/reference lists cached while either ran are dropped after.
ensureGisRegions()
  .then((loaded) => { if (loaded) clearGisCaches(); })
  .catch((e) => console.error("GIS region load failed:", e instanceof Error ? e.message : e))
  .then(() => ensureSonrisWells())
  .then((ready) => { if (ready) clearGisCaches(); })
  .catch((e) => console.error("Louisiana well load failed:", e instanceof Error ? e.message : e));

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Mineral Hub API listening on :${env.PORT} (${env.NODE_ENV})`);
});
