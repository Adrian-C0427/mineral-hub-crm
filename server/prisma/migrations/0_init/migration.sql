-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ASSOCIATE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('UNDER_CONTRACT', 'PREPARING_PACKAGE', 'SENT_TO_BUYERS', 'NEGOTIATING', 'CLOSING', 'CLOSED', 'DEAD');

-- CreateEnum
CREATE TYPE "RecordType" AS ENUM ('OPPORTUNITY', 'OWNED_ASSET');

-- CreateEnum
CREATE TYPE "AssetMode" AS ENUM ('HOLD', 'SELL');

-- CreateEnum
CREATE TYPE "SellerType" AS ENUM ('INDIVIDUAL', 'TRUST', 'LLC', 'CORPORATION', 'ESTATE', 'PARTNERSHIP', 'OTHER');

-- CreateEnum
CREATE TYPE "RelationshipStatus" AS ENUM ('HOT', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "ResponseStatus" AS ENUM ('PENDING', 'INTERESTED', 'NOT_INTERESTED', 'PASSED', 'OFFER_MADE');

-- CreateEnum
CREATE TYPE "BuyerStatus" AS ENUM ('CONTACTED', 'INTERESTED', 'REVIEWING', 'OFFER_RECEIVED', 'NEGOTIATING', 'PASSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CommKind" AS ENUM ('EMAIL_OUT', 'EMAIL_IN', 'PHONE', 'MEETING', 'NOTE', 'NEGOTIATION', 'STATUS_CHANGE');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('ACTIVE', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'COUNTERED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "FileCategory" AS ENUM ('PSA', 'LPOA', 'DEED', 'PLAT_MAP', 'TITLE_DOC', 'OTHER');

-- CreateEnum
CREATE TYPE "PortalVisibility" AS ENUM ('PUBLIC', 'LINK_ONLY');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "ResearchDocClass" AS ENUM ('TRANSACTION', 'LEASE');

-- CreateEnum
CREATE TYPE "ResearchDocType" AS ENUM ('MINERAL_DEED', 'ROYALTY_DEED', 'MINERAL_CONVEYANCE', 'OG_CONVEYANCE', 'QUITCLAIM_MINERAL_DEED', 'WARRANTY_MINERAL_DEED', 'ASSIGNMENT', 'RESERVATION', 'OG_LEASE', 'LEASE_MEMO', 'LEASE_ASSIGNMENT', 'LEASE_RELEASE', 'LEASE_AMENDMENT', 'LEASE_EXTENSION', 'LEASE_RATIFICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ResearchPermitStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'SPUDDED', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "WellTrajectory" AS ENUM ('VERTICAL', 'HORIZONTAL', 'DIRECTIONAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ResearchIngestKind" AS ENUM ('DOCUMENTS', 'PERMITS', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "ResearchIngestStatus" AS ENUM ('COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "WellStatus" AS ENUM ('PRODUCING', 'SHUT_IN', 'PLUGGED', 'INACTIVE', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "fullLogo" TEXT,
    "compactLogo" TEXT,
    "portalSlug" TEXT,
    "portalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "portalContactName" TEXT,
    "portalContactEmail" TEXT,
    "portalContactPhone" TEXT,
    "portalOfficeLocation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalContact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "department" TEXT,
    "photo" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "config" JSONB,
    "connectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermissions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "permissions" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RolePermissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteCode" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "reusable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "role" "Role" NOT NULL DEFAULT 'ASSOCIATE',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "organizationId" TEXT,
    "orgRole" "OrgRole",
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totpRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "themePreference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "sellerNames" TEXT[],
    "recordType" "RecordType" NOT NULL DEFAULT 'OPPORTUNITY',
    "assetMode" "AssetMode",
    "counties" TEXT[],
    "state" TEXT,
    "states" TEXT[],
    "acreageNma" DOUBLE PRECISION,
    "nra" DOUBLE PRECISION,
    "abstractIds" TEXT[],
    "operator" TEXT,
    "askPrice" DOUBLE PRECISION,
    "ourPrice" DOUBLE PRECISION,
    "assetTypes" TEXT[],
    "basins" TEXT[],
    "formations" TEXT[],
    "stage" "Stage" NOT NULL DEFAULT 'UNDER_CONTRACT',
    "currentStageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadReason" TEXT,
    "dateUnderContract" TIMESTAMP(3),
    "originalClosingDate" TIMESTAMP(3),
    "findBuyerByDateOverride" TIMESTAMP(3),
    "finalClosingDateOverride" TIMESTAMP(3),
    "selectedBuyerId" TEXT,
    "selectedOfferId" TEXT,
    "relationshipOwnerId" TEXT,
    "estimatedClosingCosts" DOUBLE PRECISION,
    "notes" TEXT,
    "publishedToPortal" BOOLEAN NOT NULL DEFAULT false,
    "portalSlug" TEXT,
    "portalVisibility" "PortalVisibility" NOT NULL DEFAULT 'LINK_ONLY',
    "portalFeatured" BOOLEAN NOT NULL DEFAULT false,
    "portalSummary" TEXT,
    "portalSections" JSONB,
    "portalAskPrice" DOUBLE PRECISION,
    "acquisitionDate" TIMESTAMP(3),
    "purchasePrice" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION,
    "bookValue" DOUBLE PRECISION,
    "ownershipStatus" TEXT,
    "ownershipType" TEXT,
    "workingInterest" DOUBLE PRECISION,
    "netRevenueInterest" DOUBLE PRECISION,
    "surveys" TEXT[],
    "wells" TEXT[],
    "producingStatus" TEXT,
    "royaltyIncomeAnnual" DOUBLE PRECISION,
    "leaseStatus" TEXT,
    "leaseInfo" TEXT,
    "divisionOrdersNote" TEXT,
    "taxInfo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TractDescription" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'TX',
    "parse" JSONB,
    "geometry" JSONB,
    "anchor" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TractDescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealSeller" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "ownershipPercent" DOUBLE PRECISION,
    "firstName" TEXT,
    "middleName" TEXT,
    "lastName" TEXT,
    "companyName" TEXT,
    "trustName" TEXT,
    "sellerType" "SellerType" NOT NULL DEFAULT 'INDIVIDUAL',
    "primaryPhone" TEXT,
    "secondaryPhone" TEXT,
    "email" TEXT,
    "preferredContactMethod" TEXT,
    "mailingAddress" TEXT,
    "mailingCity" TEXT,
    "mailingState" TEXT,
    "mailingZip" TEXT,
    "physicalAddress" TEXT,
    "physicalCity" TEXT,
    "physicalState" TEXT,
    "physicalZip" TEXT,
    "internalNotes" TEXT,
    "taxId" TEXT,
    "preferredCommunicationNotes" TEXT,
    "assignedTeamMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealSeller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetRevenueEntry" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ROYALTY',
    "operator" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetRevenueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealStageHistory" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "fromStage" "Stage",
    "toStage" "Stage" NOT NULL,
    "changedByUserId" TEXT,
    "deadReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealStageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Buyer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "mailingAddress" TEXT,
    "relationshipStatus" "RelationshipStatus" NOT NULL DEFAULT 'WARM',
    "lastContactDate" TIMESTAMP(3),
    "nextFollowUpDate" TIMESTAMP(3),
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "normalizedCompany" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT,
    "researchSummary" JSONB,
    "portalSubmittedAt" TIMESTAMP(3),
    "duplicateReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Buyer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyBoxCriteria" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "states" TEXT[],
    "counties" TEXT[],
    "basins" TEXT[],
    "formations" TEXT[],
    "assetTypes" TEXT[],
    "minAcreage" DOUBLE PRECISION,
    "maxAcreage" DOUBLE PRECISION,
    "minPrice" DOUBLE PRECISION,
    "maxPrice" DOUBLE PRECISION,

    CONSTRAINT "BuyBoxCriteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerOwner" (
    "buyerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "BuyerOwner_pkey" PRIMARY KEY ("buyerId","userId")
);

-- CreateTable
CREATE TABLE "BuyerTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "BuyerTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerTagOnBuyer" (
    "buyerId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "BuyerTagOnBuyer_pkey" PRIMARY KEY ("buyerId","tagId")
);

-- CreateTable
CREATE TABLE "DealBuyerActivity" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "dateSent" TIMESTAMP(3),
    "responseStatus" "ResponseStatus" NOT NULL DEFAULT 'PENDING',
    "status" "BuyerStatus",
    "offerAmount" DOUBLE PRECISION,
    "responseReceived" BOOLEAN NOT NULL DEFAULT false,
    "lastActivityDate" TIMESTAMP(3),
    "nextFollowUpDate" TIMESTAMP(3),
    "notes" TEXT,
    "sentByUserId" TEXT,
    "assignedTeamMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealBuyerActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealBuyerMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "dealId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "activityId" TEXT,
    "kind" "CommKind" NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealBuyerMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "dateSubmitted" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conditions" TEXT,
    "expirationDate" TIMESTAMP(3),
    "status" "OfferStatus" NOT NULL DEFAULT 'ACTIVE',
    "parentOfferId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileAttachment" (
    "id" TEXT NOT NULL,
    "dealId" TEXT,
    "buyerId" TEXT,
    "category" "FileCategory" NOT NULL DEFAULT 'OTHER',
    "folder" TEXT NOT NULL DEFAULT 'Other',
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "s3Key" TEXT NOT NULL,
    "visibleToBuyers" BOOLEAN NOT NULL DEFAULT false,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededById" TEXT,

    CONSTRAINT "FileAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "eventType" TEXT NOT NULL,
    "dealId" TEXT,
    "buyerId" TEXT,
    "actorUserId" TEXT,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "categoryId" TEXT,
    "notes" TEXT,
    "reimbursed" BOOLEAN NOT NULL DEFAULT false,
    "reimbursementDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "county" TEXT NOT NULL,
    "docTypeRaw" TEXT NOT NULL,
    "docType" "ResearchDocType" NOT NULL,
    "docClass" "ResearchDocClass" NOT NULL,
    "instrumentNumber" TEXT,
    "volume" TEXT,
    "page" TEXT,
    "recordingDate" TIMESTAMP(3) NOT NULL,
    "effectiveDate" TIMESTAMP(3),
    "grantor" TEXT,
    "grantee" TEXT,
    "grantorNorm" TEXT,
    "granteeNorm" TEXT,
    "abstractId" TEXT,
    "survey" TEXT,
    "trs" TEXT,
    "legalDescription" TEXT,
    "acreage" DOUBLE PRECISION,
    "consideration" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "ingestRunId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchPermit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "county" TEXT NOT NULL,
    "apiNumber" TEXT,
    "permitNumber" TEXT,
    "operator" TEXT NOT NULL,
    "operatorNorm" TEXT NOT NULL,
    "leaseName" TEXT,
    "wellName" TEXT,
    "status" "ResearchPermitStatus" NOT NULL DEFAULT 'SUBMITTED',
    "trajectory" "WellTrajectory" NOT NULL DEFAULT 'UNKNOWN',
    "activityDate" TIMESTAMP(3) NOT NULL,
    "filedDate" TIMESTAMP(3),
    "approvedDate" TIMESTAMP(3),
    "spudDate" TIMESTAMP(3),
    "completionDate" TIMESTAMP(3),
    "formation" TEXT,
    "field" TEXT,
    "totalDepth" DOUBLE PRECISION,
    "abstractId" TEXT,
    "survey" TEXT,
    "trs" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "ingestRunId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchPermit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchWell" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "apiNumber" TEXT,
    "name" TEXT NOT NULL,
    "operator" TEXT,
    "leaseName" TEXT,
    "fieldName" TEXT,
    "formation" TEXT,
    "state" TEXT NOT NULL,
    "county" TEXT NOT NULL,
    "status" "WellStatus" NOT NULL DEFAULT 'UNKNOWN',
    "trajectory" "WellTrajectory" NOT NULL DEFAULT 'UNKNOWN',
    "wellType" TEXT,
    "spudDate" TIMESTAMP(3),
    "firstProdDate" TIMESTAMP(3),
    "abstractId" TEXT,
    "survey" TEXT,
    "trs" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchWell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WellProductionMonth" (
    "id" TEXT NOT NULL,
    "wellId" TEXT NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "oilBbl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gasMcf" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "nglBbl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "waterBbl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "daysOn" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'manual',

    CONSTRAINT "WellProductionMonth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WellAnalysis" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "wellIds" TEXT[],
    "assumptions" JSONB NOT NULL,
    "results" JSONB,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WellAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchIngestRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "ResearchIngestKind" NOT NULL,
    "source" TEXT NOT NULL,
    "state" TEXT,
    "county" TEXT,
    "filename" TEXT,
    "rowsTotal" INTEGER NOT NULL DEFAULT 0,
    "rowsImported" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
    "rowsFailed" INTEGER NOT NULL DEFAULT 0,
    "status" "ResearchIngestStatus" NOT NULL DEFAULT 'COMPLETED',
    "error" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchIngestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_DealAssignees" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_teamId_key" ON "Organization"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_portalSlug_key" ON "Organization"("portalSlug");

-- CreateIndex
CREATE INDEX "PortalContact_organizationId_idx" ON "PortalContact"("organizationId");

-- CreateIndex
CREATE INDEX "Notification_organizationId_readAt_idx" ON "Notification"("organizationId", "readAt");

-- CreateIndex
CREATE INDEX "Integration_organizationId_idx" ON "Integration"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_organizationId_provider_key" ON "Integration"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "EmailTemplate_organizationId_idx" ON "EmailTemplate"("organizationId");

-- CreateIndex
CREATE INDEX "RolePermissions_organizationId_idx" ON "RolePermissions"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermissions_organizationId_role_key" ON "RolePermissions"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_code_key" ON "InviteCode"("code");

-- CreateIndex
CREATE INDEX "InviteCode_organizationId_idx" ON "InviteCode"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "OAuthAccount_userId_idx" ON "OAuthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_providerAccountId_key" ON "OAuthAccount"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_selectedOfferId_key" ON "Deal"("selectedOfferId");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_portalSlug_key" ON "Deal"("portalSlug");

-- CreateIndex
CREATE INDEX "Deal_stage_idx" ON "Deal"("stage");

-- CreateIndex
CREATE INDEX "Deal_selectedBuyerId_idx" ON "Deal"("selectedBuyerId");

-- CreateIndex
CREATE INDEX "Deal_organizationId_idx" ON "Deal"("organizationId");

-- CreateIndex
CREATE INDEX "Deal_organizationId_recordType_idx" ON "Deal"("organizationId", "recordType");

-- CreateIndex
CREATE INDEX "Deal_organizationId_publishedToPortal_idx" ON "Deal"("organizationId", "publishedToPortal");

-- CreateIndex
CREATE INDEX "TractDescription_dealId_idx" ON "TractDescription"("dealId");

-- CreateIndex
CREATE INDEX "DealSeller_dealId_idx" ON "DealSeller"("dealId");

-- CreateIndex
CREATE INDEX "AssetRevenueEntry_dealId_month_idx" ON "AssetRevenueEntry"("dealId", "month");

-- CreateIndex
CREATE INDEX "DealStageHistory_dealId_idx" ON "DealStageHistory"("dealId");

-- CreateIndex
CREATE INDEX "Buyer_normalizedCompany_idx" ON "Buyer"("normalizedCompany");

-- CreateIndex
CREATE INDEX "Buyer_email_idx" ON "Buyer"("email");

-- CreateIndex
CREATE INDEX "Buyer_organizationId_idx" ON "Buyer"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyBoxCriteria_buyerId_key" ON "BuyBoxCriteria"("buyerId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerTag_name_key" ON "BuyerTag"("name");

-- CreateIndex
CREATE INDEX "DealBuyerActivity_buyerId_idx" ON "DealBuyerActivity"("buyerId");

-- CreateIndex
CREATE UNIQUE INDEX "DealBuyerActivity_dealId_buyerId_key" ON "DealBuyerActivity"("dealId", "buyerId");

-- CreateIndex
CREATE INDEX "DealBuyerMessage_dealId_buyerId_idx" ON "DealBuyerMessage"("dealId", "buyerId");

-- CreateIndex
CREATE INDEX "DealBuyerMessage_organizationId_idx" ON "DealBuyerMessage"("organizationId");

-- CreateIndex
CREATE INDEX "Offer_dealId_idx" ON "Offer"("dealId");

-- CreateIndex
CREATE INDEX "Offer_buyerId_idx" ON "Offer"("buyerId");

-- CreateIndex
CREATE INDEX "FileAttachment_dealId_idx" ON "FileAttachment"("dealId");

-- CreateIndex
CREATE INDEX "FileAttachment_buyerId_idx" ON "FileAttachment"("buyerId");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_organizationId_idx" ON "ActivityLog"("organizationId");

-- CreateIndex
CREATE INDEX "ExpenseCategory_organizationId_idx" ON "ExpenseCategory"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_organizationId_name_key" ON "ExpenseCategory"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Expense_organizationId_idx" ON "Expense"("organizationId");

-- CreateIndex
CREATE INDEX "Expense_userId_idx" ON "Expense"("userId");

-- CreateIndex
CREATE INDEX "Expense_categoryId_idx" ON "Expense"("categoryId");

-- CreateIndex
CREATE INDEX "Expense_date_idx" ON "Expense"("date");

-- CreateIndex
CREATE INDEX "ResearchDocument_organizationId_state_county_recordingDate_idx" ON "ResearchDocument"("organizationId", "state", "county", "recordingDate");

-- CreateIndex
CREATE INDEX "ResearchDocument_organizationId_docClass_recordingDate_idx" ON "ResearchDocument"("organizationId", "docClass", "recordingDate");

-- CreateIndex
CREATE INDEX "ResearchDocument_organizationId_granteeNorm_idx" ON "ResearchDocument"("organizationId", "granteeNorm");

-- CreateIndex
CREATE INDEX "ResearchDocument_organizationId_grantorNorm_idx" ON "ResearchDocument"("organizationId", "grantorNorm");

-- CreateIndex
CREATE INDEX "ResearchDocument_organizationId_abstractId_idx" ON "ResearchDocument"("organizationId", "abstractId");

-- CreateIndex
CREATE INDEX "ResearchDocument_organizationId_ingestRunId_idx" ON "ResearchDocument"("organizationId", "ingestRunId");

-- CreateIndex
CREATE INDEX "ResearchPermit_organizationId_state_county_activityDate_idx" ON "ResearchPermit"("organizationId", "state", "county", "activityDate");

-- CreateIndex
CREATE INDEX "ResearchPermit_organizationId_operatorNorm_idx" ON "ResearchPermit"("organizationId", "operatorNorm");

-- CreateIndex
CREATE INDEX "ResearchPermit_organizationId_activityDate_idx" ON "ResearchPermit"("organizationId", "activityDate");

-- CreateIndex
CREATE INDEX "ResearchPermit_organizationId_ingestRunId_idx" ON "ResearchPermit"("organizationId", "ingestRunId");

-- CreateIndex
CREATE INDEX "ResearchWell_organizationId_state_county_idx" ON "ResearchWell"("organizationId", "state", "county");

-- CreateIndex
CREATE INDEX "ResearchWell_organizationId_name_idx" ON "ResearchWell"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchWell_organizationId_apiNumber_key" ON "ResearchWell"("organizationId", "apiNumber");

-- CreateIndex
CREATE INDEX "WellProductionMonth_wellId_month_idx" ON "WellProductionMonth"("wellId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "WellProductionMonth_wellId_month_key" ON "WellProductionMonth"("wellId", "month");

-- CreateIndex
CREATE INDEX "WellAnalysis_organizationId_updatedAt_idx" ON "WellAnalysis"("organizationId", "updatedAt");

-- CreateIndex
CREATE INDEX "ResearchIngestRun_organizationId_createdAt_idx" ON "ResearchIngestRun"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "_DealAssignees_AB_unique" ON "_DealAssignees"("A", "B");

-- CreateIndex
CREATE INDEX "_DealAssignees_B_index" ON "_DealAssignees"("B");

-- AddForeignKey
ALTER TABLE "PortalContact" ADD CONSTRAINT "PortalContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermissions" ADD CONSTRAINT "RolePermissions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_selectedBuyerId_fkey" FOREIGN KEY ("selectedBuyerId") REFERENCES "Buyer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_selectedOfferId_fkey" FOREIGN KEY ("selectedOfferId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_relationshipOwnerId_fkey" FOREIGN KEY ("relationshipOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TractDescription" ADD CONSTRAINT "TractDescription_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealSeller" ADD CONSTRAINT "DealSeller_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealSeller" ADD CONSTRAINT "DealSeller_assignedTeamMemberId_fkey" FOREIGN KEY ("assignedTeamMemberId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetRevenueEntry" ADD CONSTRAINT "AssetRevenueEntry_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealStageHistory" ADD CONSTRAINT "DealStageHistory_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealStageHistory" ADD CONSTRAINT "DealStageHistory_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Buyer" ADD CONSTRAINT "Buyer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyBoxCriteria" ADD CONSTRAINT "BuyBoxCriteria_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerOwner" ADD CONSTRAINT "BuyerOwner_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerOwner" ADD CONSTRAINT "BuyerOwner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerTagOnBuyer" ADD CONSTRAINT "BuyerTagOnBuyer_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerTagOnBuyer" ADD CONSTRAINT "BuyerTagOnBuyer_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "BuyerTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealBuyerActivity" ADD CONSTRAINT "DealBuyerActivity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealBuyerActivity" ADD CONSTRAINT "DealBuyerActivity_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealBuyerActivity" ADD CONSTRAINT "DealBuyerActivity_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealBuyerActivity" ADD CONSTRAINT "DealBuyerActivity_assignedTeamMemberId_fkey" FOREIGN KEY ("assignedTeamMemberId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealBuyerMessage" ADD CONSTRAINT "DealBuyerMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealBuyerMessage" ADD CONSTRAINT "DealBuyerMessage_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealBuyerMessage" ADD CONSTRAINT "DealBuyerMessage_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealBuyerMessage" ADD CONSTRAINT "DealBuyerMessage_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "DealBuyerActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealBuyerMessage" ADD CONSTRAINT "DealBuyerMessage_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_parentOfferId_fkey" FOREIGN KEY ("parentOfferId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAttachment" ADD CONSTRAINT "FileAttachment_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAttachment" ADD CONSTRAINT "FileAttachment_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAttachment" ADD CONSTRAINT "FileAttachment_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAttachment" ADD CONSTRAINT "FileAttachment_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "FileAttachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchDocument" ADD CONSTRAINT "ResearchDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchPermit" ADD CONSTRAINT "ResearchPermit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchWell" ADD CONSTRAINT "ResearchWell_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WellProductionMonth" ADD CONSTRAINT "WellProductionMonth_wellId_fkey" FOREIGN KEY ("wellId") REFERENCES "ResearchWell"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WellAnalysis" ADD CONSTRAINT "WellAnalysis_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchIngestRun" ADD CONSTRAINT "ResearchIngestRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DealAssignees" ADD CONSTRAINT "_DealAssignees_A_fkey" FOREIGN KEY ("A") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DealAssignees" ADD CONSTRAINT "_DealAssignees_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

