-- Contact workspace: tags on Contact + ContactActivity timeline (additive).
ALTER TABLE "Contact" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "ContactActivity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "disposition" TEXT,
    "durationSeconds" INTEGER,
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContactActivity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContactActivity_contactId_createdAt_idx" ON "ContactActivity"("contactId", "createdAt");
CREATE INDEX "ContactActivity_organizationId_idx" ON "ContactActivity"("organizationId");
ALTER TABLE "ContactActivity" ADD CONSTRAINT "ContactActivity_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactActivity" ADD CONSTRAINT "ContactActivity_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
