-- Additive: a nullable buyer-closing date on Deal and a table recording
-- contract extensions. No existing row changes.
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "buyerClosingDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DealContractExtension" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "days" INTEGER NOT NULL DEFAULT 15,
    "extendedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealContractExtension_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealContractExtension_dealId_createdAt_idx" ON "DealContractExtension"("dealId", "createdAt");

-- AddForeignKey
ALTER TABLE "DealContractExtension" ADD CONSTRAINT "DealContractExtension_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

