import { prisma } from "../db.js";
import type { Prisma } from "@prisma/client";

/**
 * Writes a pre-rendered summary string to ActivityLog. This feed powers the
 * dashboard "Recent activity" widget, so the summary is rendered at write time.
 */
export async function logActivity(
  params: {
    eventType: string;
    summary: string;
    organizationId?: string | null;
    actorUserId?: string | null;
    dealId?: string | null;
    buyerId?: string | null;
  },
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await tx.activityLog.create({
    data: {
      eventType: params.eventType,
      summary: params.summary,
      organizationId: params.organizationId ?? null,
      actorUserId: params.actorUserId ?? null,
      dealId: params.dealId ?? null,
      buyerId: params.buyerId ?? null,
    },
  });
}
