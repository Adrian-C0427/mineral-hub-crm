-- Default deal document folder "Wholesale PSA" is now "Buyer PSA". Move existing
-- files (and any custom per-deal folder lists) so documents stay in the folder.
UPDATE "FileAttachment" SET "folder" = 'Buyer PSA' WHERE "folder" = 'Wholesale PSA';
-- A list that already has "Buyer PSA" just drops the old name (no duplicate).
UPDATE "Deal" SET "docFolders" = CASE
    WHEN 'Buyer PSA' = ANY("docFolders") THEN array_remove("docFolders", 'Wholesale PSA')
    ELSE array_replace("docFolders", 'Wholesale PSA', 'Buyer PSA')
  END
 WHERE 'Wholesale PSA' = ANY("docFolders");
