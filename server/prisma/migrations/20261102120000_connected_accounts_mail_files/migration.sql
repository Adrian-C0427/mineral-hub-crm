-- Personal connected accounts (Outlook mail, OneDrive, Google Drive), synced
-- and CRM-sent email, email ↔ record links, imported Outlook signatures, and
-- cloud files linked to records (docs/integrations-outlook-drive.md).
--
-- ADDITIVE ONLY: seven new tables, plus one nullable "emailMessageId" column
-- on "DealBuyerMessage" and on "ContactActivity" (empty for every existing
-- row). No existing table, column or row is changed or removed.

-- AlterTable
ALTER TABLE "DealBuyerMessage" ADD COLUMN     "emailMessageId" TEXT;

-- AlterTable
ALTER TABLE "ContactActivity" ADD COLUMN     "emailMessageId" TEXT;

-- CreateTable
CREATE TABLE "ConnectedAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "tokens" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'IDLE',
    "syncState" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "autoLinkEmail" BOOLEAN NOT NULL DEFAULT true,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderSubscription" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "clientStateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "internetMessageId" TEXT,
    "conversationId" TEXT,
    "direction" TEXT NOT NULL,
    "folder" TEXT,
    "subject" TEXT,
    "fromAddress" TEXT,
    "fromName" TEXT,
    "toRecipients" JSONB NOT NULL DEFAULT '[]',
    "ccRecipients" JSONB NOT NULL DEFAULT '[]',
    "bodyPreview" TEXT,
    "bodyHtml" TEXT,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "sendStatus" TEXT,
    "sendError" TEXT,
    "clientRequestId" TEXT,
    "notBefore" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "outbox" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "recordKey" TEXT NOT NULL,
    "contactId" TEXT,
    "dealId" TEXT,
    "opportunityId" TEXT,
    "buyerId" TEXT,
    "source" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSignature" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "defaultNew" BOOLEAN NOT NULL DEFAULT false,
    "defaultReply" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSignatureAsset" (
    "id" TEXT NOT NULL,
    "signatureId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSignatureAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudFileLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerFileId" TEXT NOT NULL,
    "driveId" TEXT,
    "name" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" BIGINT,
    "webUrl" TEXT,
    "providerModifiedAt" TIMESTAMP(3),
    "origin" TEXT NOT NULL,
    "sourceAttachmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "folder" TEXT NOT NULL DEFAULT 'Other',
    "recordKey" TEXT NOT NULL,
    "contactId" TEXT,
    "dealId" TEXT,
    "opportunityId" TEXT,
    "buyerId" TEXT,
    "createdByUserId" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudFileLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectedAccount_userId_provider_idx" ON "ConnectedAccount"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_organizationId_provider_providerAccountId_key" ON "ConnectedAccount"("organizationId", "provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSubscription_subscriptionId_key" ON "ProviderSubscription"("subscriptionId");

-- CreateIndex
CREATE INDEX "ProviderSubscription_expiresAt_idx" ON "ProviderSubscription"("expiresAt");

-- CreateIndex
CREATE INDEX "EmailMessage_organizationId_conversationId_idx" ON "EmailMessage"("organizationId", "conversationId");

-- CreateIndex
CREATE INDEX "EmailMessage_sendStatus_notBefore_idx" ON "EmailMessage"("sendStatus", "notBefore");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_accountId_providerMessageId_key" ON "EmailMessage"("accountId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_accountId_clientRequestId_key" ON "EmailMessage"("accountId", "clientRequestId");

-- CreateIndex
CREATE INDEX "EmailLink_contactId_idx" ON "EmailLink"("contactId");

-- CreateIndex
CREATE INDEX "EmailLink_dealId_idx" ON "EmailLink"("dealId");

-- CreateIndex
CREATE INDEX "EmailLink_opportunityId_idx" ON "EmailLink"("opportunityId");

-- CreateIndex
CREATE INDEX "EmailLink_buyerId_idx" ON "EmailLink"("buyerId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailLink_messageId_recordKey_key" ON "EmailLink"("messageId", "recordKey");

-- CreateIndex
CREATE INDEX "EmailSignature_accountId_idx" ON "EmailSignature"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSignatureAsset_signatureId_contentId_key" ON "EmailSignatureAsset"("signatureId", "contentId");

-- CreateIndex
CREATE INDEX "CloudFileLink_accountId_providerFileId_idx" ON "CloudFileLink"("accountId", "providerFileId");

-- CreateIndex
CREATE INDEX "CloudFileLink_contactId_idx" ON "CloudFileLink"("contactId");

-- CreateIndex
CREATE INDEX "CloudFileLink_dealId_idx" ON "CloudFileLink"("dealId");

-- CreateIndex
CREATE INDEX "CloudFileLink_opportunityId_idx" ON "CloudFileLink"("opportunityId");

-- CreateIndex
CREATE INDEX "CloudFileLink_buyerId_idx" ON "CloudFileLink"("buyerId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudFileLink_accountId_providerFileId_recordKey_key" ON "CloudFileLink"("accountId", "providerFileId", "recordKey");

-- CreateIndex
CREATE UNIQUE INDEX "DealBuyerMessage_emailMessageId_key" ON "DealBuyerMessage"("emailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactActivity_emailMessageId_key" ON "ContactActivity"("emailMessageId");

-- AddForeignKey
ALTER TABLE "DealBuyerMessage" ADD CONSTRAINT "DealBuyerMessage_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactActivity" ADD CONSTRAINT "ContactActivity_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedAccount" ADD CONSTRAINT "ConnectedAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedAccount" ADD CONSTRAINT "ConnectedAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSubscription" ADD CONSTRAINT "ProviderSubscription_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLink" ADD CONSTRAINT "EmailLink_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLink" ADD CONSTRAINT "EmailLink_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLink" ADD CONSTRAINT "EmailLink_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLink" ADD CONSTRAINT "EmailLink_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLink" ADD CONSTRAINT "EmailLink_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSignature" ADD CONSTRAINT "EmailSignature_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSignatureAsset" ADD CONSTRAINT "EmailSignatureAsset_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "EmailSignature"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFileLink" ADD CONSTRAINT "CloudFileLink_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFileLink" ADD CONSTRAINT "CloudFileLink_sourceAttachmentId_fkey" FOREIGN KEY ("sourceAttachmentId") REFERENCES "FileAttachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFileLink" ADD CONSTRAINT "CloudFileLink_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFileLink" ADD CONSTRAINT "CloudFileLink_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFileLink" ADD CONSTRAINT "CloudFileLink_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFileLink" ADD CONSTRAINT "CloudFileLink_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFileLink" ADD CONSTRAINT "CloudFileLink_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

