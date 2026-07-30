-- Portal listing analytics: anonymous view/download events per published deal.
CREATE TABLE "PortalEvent" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileId" TEXT,
    "visitorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PortalEvent_dealId_kind_createdAt_idx" ON "PortalEvent"("dealId", "kind", "createdAt");
CREATE INDEX "PortalEvent_dealId_visitorId_idx" ON "PortalEvent"("dealId", "visitorId");

ALTER TABLE "PortalEvent" ADD CONSTRAINT "PortalEvent_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
