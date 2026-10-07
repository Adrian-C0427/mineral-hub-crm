import { prisma } from "../db.js";
import { findDemoOrg, seedDemoOrg } from "./demoSeed.js";
import { demoLoginConfig } from "./demo.js";

/**
 * Nightly demo reset (opt-in: DEMO_AUTO_RESET=true). Once a day, at
 * DEMO_RESET_HOUR_UTC (default 8 = 3 AM Central), the demo workspace is wiped
 * and reseeded so every prospect starts from the same polished dataset.
 * Touches ONLY the isDemo org (seedDemoOrg re-asserts that before deleting);
 * its Research/Map reference data is read live from the reference org and is
 * never copied or reset. Requires DEMO_USER_PASSWORD (the demo login keeps it).
 */
const TICK_MS = 10 * 60 * 1000;

export function startDemoResetScheduler(): void {
  if (process.env.DEMO_AUTO_RESET !== "true") return;
  const hour = Number.isInteger(Number(process.env.DEMO_RESET_HOUR_UTC)) ? Number(process.env.DEMO_RESET_HOUR_UTC) : 8;
  let lastRunDay: string | null = null;
  let running = false;

  const tick = async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (running || now.getUTCHours() !== hour || lastRunDay === day) return;
    const password = process.env.DEMO_USER_PASSWORD;
    if (!password || password.length < 12) {
      console.warn("[demo] nightly reset skipped: DEMO_USER_PASSWORD is not set (min 12 chars)");
      lastRunDay = day;
      return;
    }
    const demo = await findDemoOrg(prisma);
    if (!demo) { lastRunDay = day; return; }
    running = true;
    lastRunDay = day;
    try {
      const { counts } = await seedDemoOrg(prisma, {
        referenceOrgId: demo.referenceOrgId,
        demoUserEmail: demoLoginConfig().email,
        demoUserPassword: password,
        log: () => {},
      });
      console.log(`[demo] nightly reset done (${Object.values(counts as Record<string, number>).reduce((a: number, b: number) => a + Number(b), 0)} rows)`);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick().catch((e) => console.error("[demo] nightly reset failed:", e instanceof Error ? e.message : e)), TICK_MS).unref();
}
