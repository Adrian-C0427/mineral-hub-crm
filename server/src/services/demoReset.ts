import { prisma } from "../db.js";
import { verifyPassword, hashPassword } from "../auth/password.js";
import { findDemoOrg, seedDemoOrg, resolveReferenceOrg, MIN_DEMO_PASSWORD_LENGTH } from "./demoSeed.js";
import { demoLoginConfig } from "./demo.js";

/**
 * Demo workspace lifecycle on the API service, driven by env vars so it can be
 * set up from the Railway dashboard with no shell access:
 *   DEMO_USER_PASSWORD   the shared demo login password
 *   DEMO_REFERENCE_ORG   exact name (or id) of the org whose Research/Map data
 *                        the demo reads — needed only to CREATE the demo
 *   DEMO_AUTO_RESET=true nightly reseed at DEMO_RESET_HOUR_UTC (default 8)
 * Everything here touches ONLY the isDemo org (seedDemoOrg re-asserts that
 * before deleting) and never writes to the reference org.
 */
const TICK_MS = 10 * 60 * 1000;

function demoPassword(): string | null {
  const p = process.env.DEMO_USER_PASSWORD;
  return p && p.length >= MIN_DEMO_PASSWORD_LENGTH ? p : null;
}

/**
 * On boot: create the demo workspace if it doesn't exist yet (needs
 * DEMO_REFERENCE_ORG + DEMO_USER_PASSWORD), or — if it exists — keep the demo
 * login's password in sync with DEMO_USER_PASSWORD, so changing the variable
 * on Railway changes the login without a reseed. Runs in the background and
 * never blocks or crashes startup.
 */
export async function ensureDemoWorkspace(): Promise<void> {
  const password = demoPassword();
  const refKey = process.env.DEMO_REFERENCE_ORG?.trim();
  if (!password) {
    if (process.env.DEMO_USER_PASSWORD) console.warn(`[demo] DEMO_USER_PASSWORD must be at least ${MIN_DEMO_PASSWORD_LENGTH} characters — demo setup skipped`);
    return;
  }
  const demo = await findDemoOrg(prisma);
  if (!demo) {
    if (!refKey) return;
    const ref = await resolveReferenceOrg(prisma, refKey);
    console.log(`[demo] creating the demo workspace (reference org: ${ref.name})`);
    const { counts } = await seedDemoOrg(prisma, {
      referenceOrgId: ref.id, demoUserEmail: demoLoginConfig().email, demoUserPassword: password, log: () => {},
    });
    console.log(`[demo] demo workspace created (${Object.values(counts as Record<string, number>).reduce((a: number, b: number) => a + Number(b), 0)} rows)`);
    return;
  }
  const user = await prisma.user.findFirst({
    where: { email: demoLoginConfig().email, organizationId: demo.id },
    select: { id: true, passwordHash: true },
  });
  if (user && !(await verifyPassword(password, user.passwordHash))) {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password), sessionEpoch: { increment: 1 } },
    });
    console.log("[demo] demo login password updated from DEMO_USER_PASSWORD");
  }
}

export function startDemoResetScheduler(): void {
  void ensureDemoWorkspace().catch((e) => console.error("[demo] setup failed:", e instanceof Error ? e.message : e));
  if (process.env.DEMO_AUTO_RESET !== "true") return;
  const hour = Number.isInteger(Number(process.env.DEMO_RESET_HOUR_UTC)) ? Number(process.env.DEMO_RESET_HOUR_UTC) : 8;
  let lastRunDay: string | null = null;
  let running = false;

  const tick = async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (running || now.getUTCHours() !== hour || lastRunDay === day) return;
    lastRunDay = day;
    const password = demoPassword();
    if (!password) {
      console.warn(`[demo] nightly reset skipped: DEMO_USER_PASSWORD is not set (min ${MIN_DEMO_PASSWORD_LENGTH} chars)`);
      return;
    }
    const demo = await findDemoOrg(prisma);
    if (!demo) return;
    running = true;
    try {
      const { counts } = await seedDemoOrg(prisma, {
        referenceOrgId: demo.referenceOrgId, demoUserEmail: demoLoginConfig().email, demoUserPassword: password, log: () => {},
      });
      console.log(`[demo] nightly reset done (${Object.values(counts as Record<string, number>).reduce((a: number, b: number) => a + Number(b), 0)} rows)`);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick().catch((e) => console.error("[demo] nightly reset failed:", e instanceof Error ? e.message : e)), TICK_MS).unref();
}
