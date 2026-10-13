-- HighLevel (LeadConnector) SMS mirror for Reports. ADDITIVE ONLY: two new
-- tables and their indexes. No existing table, column or row is touched; the
-- tables start empty and are filled by the HighLevel sync once an admin
-- connects HighLevel and starts the import.

-- CreateTable
CREATE TABLE "HighLevelContact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "hlId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "phoneDigits" TEXT,
    "email" TEXT,
    "source" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assignedToHlUserId" TEXT,
    "smsOptedOut" BOOLEAN NOT NULL DEFAULT false,
    "hlDateAdded" TIMESTAMP(3),
    "hlDateUpdated" TIMESTAMP(3),
    "deletedInHl" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3),
    "firstOutboundAt" TIMESTAMP(3),
    "touches" INTEGER NOT NULL DEFAULT 0,
    "unconfirmedTouches" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT,
    "outcomeAt" TIMESTAMP(3),
    "responseSeconds" INTEGER,
    "creditedHlUserId" TEXT,
    "outboundTotal" INTEGER NOT NULL DEFAULT 0,
    "inboundTotal" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "summaryDirty" BOOLEAN NOT NULL DEFAULT true,
    "summaryWindowDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HighLevelContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HighLevelMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "hlId" TEXT NOT NULL,
    "hlContactId" TEXT NOT NULL,
    "conversationId" TEXT,
    "direction" TEXT NOT NULL,
    "messageType" TEXT,
    "status" TEXT,
    "source" TEXT,
    "hlUserId" TEXT,
    "optOut" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HighLevelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HighLevelContact_organizationId_firstOutboundAt_idx" ON "HighLevelContact"("organizationId", "firstOutboundAt");

-- CreateIndex
CREATE INDEX "HighLevelContact_organizationId_phoneDigits_idx" ON "HighLevelContact"("organizationId", "phoneDigits");

-- CreateIndex
CREATE INDEX "HighLevelContact_organizationId_summaryDirty_idx" ON "HighLevelContact"("organizationId", "summaryDirty");

-- CreateIndex
CREATE INDEX "HighLevelContact_organizationId_fetchedAt_idx" ON "HighLevelContact"("organizationId", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HighLevelContact_organizationId_hlId_key" ON "HighLevelContact"("organizationId", "hlId");

-- CreateIndex
CREATE INDEX "HighLevelMessage_organizationId_sentAt_idx" ON "HighLevelMessage"("organizationId", "sentAt");

-- CreateIndex
CREATE INDEX "HighLevelMessage_organizationId_hlContactId_sentAt_idx" ON "HighLevelMessage"("organizationId", "hlContactId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "HighLevelMessage_organizationId_hlId_key" ON "HighLevelMessage"("organizationId", "hlId");

-- AddForeignKey
ALTER TABLE "HighLevelContact" ADD CONSTRAINT "HighLevelContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HighLevelMessage" ADD CONSTRAINT "HighLevelMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

