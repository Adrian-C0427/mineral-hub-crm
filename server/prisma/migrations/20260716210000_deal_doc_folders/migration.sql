-- Per-deal custom document-folder list (rename/delete/reorder in the Documents
-- section). Empty array = the module's default folder set applies.
ALTER TABLE "Deal" ADD COLUMN "docFolders" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
