-- Dashboard tasks may stand alone (no contact). Existing rows keep their contact.
ALTER TABLE "ContactActivity" ALTER COLUMN "contactId" DROP NOT NULL;
