-- Contact lists: reusable named groupings with many-to-many membership.
CREATE TABLE "ContactList" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContactList_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContactList_organizationId_name_key" ON "ContactList"("organizationId", "name");
CREATE INDEX "ContactList_organizationId_idx" ON "ContactList"("organizationId");
ALTER TABLE "ContactList" ADD CONSTRAINT "ContactList_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "_ContactListMembers" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);
CREATE UNIQUE INDEX "_ContactListMembers_AB_unique" ON "_ContactListMembers"("A", "B");
CREATE INDEX "_ContactListMembers_B_index" ON "_ContactListMembers"("B");
ALTER TABLE "_ContactListMembers" ADD CONSTRAINT "_ContactListMembers_A_fkey"
    FOREIGN KEY ("A") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_ContactListMembers" ADD CONSTRAINT "_ContactListMembers_B_fkey"
    FOREIGN KEY ("B") REFERENCES "ContactList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
