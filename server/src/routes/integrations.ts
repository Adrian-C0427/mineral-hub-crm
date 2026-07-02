import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";

export const integrationsRouter = Router();
// The integrations hub is admin-only.
integrationsRouter.use(requireAuth, requireOrg, requirePermission("manageApiIntegrations"));

function serialize(i: {
  provider: string; status: string; config: unknown; connectedAt: Date | null; lastSyncAt: Date | null; lastError: string | null; updatedAt: Date;
}) {
  return {
    provider: i.provider,
    status: i.status,
    config: i.config ?? null,
    connectedAt: i.connectedAt,
    lastSyncAt: i.lastSyncAt,
    lastError: i.lastError,
    updatedAt: i.updatedAt,
  };
}

// Stored per-org state for every integration the org has touched. The catalog
// (available providers) lives in the client registry; the UI merges the two.
integrationsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.integration.findMany({ where: { organizationId: orgId(req) } });
    res.json(rows.map(serialize));
  }),
);

const connectSchema = z.object({ config: z.record(z.unknown()).optional() });

integrationsRouter.post(
  "/:provider/connect",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { config } = connectSchema.parse(req.body);
    const provider = req.params.provider;
    const cfg = (config ?? undefined) as never;
    const row = await prisma.integration.upsert({
      where: { organizationId_provider: { organizationId: orgId(req), provider } },
      create: { organizationId: orgId(req), provider, status: "CONNECTED", connectedAt: new Date(), config: cfg, lastError: null },
      update: { status: "CONNECTED", connectedAt: new Date(), config: cfg, lastError: null },
    });
    res.json(serialize(row));
  }),
);

integrationsRouter.post(
  "/:provider/disconnect",
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = req.params.provider;
    const row = await prisma.integration.upsert({
      where: { organizationId_provider: { organizationId: orgId(req), provider } },
      create: { organizationId: orgId(req), provider, status: "NOT_CONNECTED" },
      update: { status: "NOT_CONNECTED", connectedAt: null },
    });
    res.json(serialize(row));
  }),
);

// Update non-secret config (labels, sync schedule, etc.).
integrationsRouter.patch(
  "/:provider",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { config } = z.object({ config: z.record(z.unknown()) }).parse(req.body);
    const provider = req.params.provider;
    const existing = await prisma.integration.findUnique({
      where: { organizationId_provider: { organizationId: orgId(req), provider } },
    });
    if (!existing) throw new HttpError(404, "Integration not configured");
    const row = await prisma.integration.update({
      where: { id: existing.id },
      data: { config: config as never },
    });
    res.json(serialize(row));
  }),
);

// Connection test — placeholder until per-provider auth is wired. Records the
// attempt so the UI can show a last-tested result.
integrationsRouter.post(
  "/:provider/test",
  asyncHandler(async (req: AuthedRequest, res) => {
    const provider = req.params.provider;
    const existing = await prisma.integration.findUnique({
      where: { organizationId_provider: { organizationId: orgId(req), provider } },
    });
    if (!existing || existing.status !== "CONNECTED") {
      return res.json({ ok: false, message: "Connect this integration before testing." });
    }
    res.json({ ok: true, message: "Connection tracking is active. Live credential validation is coming for this provider." });
  }),
);
