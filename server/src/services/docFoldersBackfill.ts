import { prisma } from "../db.js";

/**
 * One-time, idempotent: the "Lease" document folder joined the deal defaults
 * (after "Title"). A deal that never customized its folders (empty docFolders)
 * shows the defaults and needs nothing. A deal with a stored list gets "Lease"
 * inserted once — after "Title" when it has one, else just before "Other" —
 * and is stamped docFoldersVersion = 1 so a later deliberate removal of the
 * folder sticks. Additive only: no folder is renamed, moved or removed, and no
 * document is touched. Logs counts only.
 */
export const DOC_FOLDERS_VERSION = 1;
export const LEASE_FOLDER = "Lease";

/** The stored list with "Lease" in its default position (unchanged when present). */
export function withLeaseFolder(folders: readonly string[]): string[] {
  if (folders.some((f) => f.trim().toLowerCase() === LEASE_FOLDER.toLowerCase())) return [...folders];
  const out = [...folders];
  const title = out.findIndex((f) => f.trim().toLowerCase() === "title");
  if (title >= 0) { out.splice(title + 1, 0, LEASE_FOLDER); return out; }
  const other = out.findIndex((f) => f.trim().toLowerCase() === "other");
  if (other >= 0) { out.splice(other, 0, LEASE_FOLDER); return out; }
  out.push(LEASE_FOLDER);
  return out;
}

const BATCH = 500;

export async function backfillDocFolders(): Promise<number> {
  let updated = 0;
  for (;;) {
    const rows = await prisma.deal.findMany({
      where: { docFoldersVersion: { lt: DOC_FOLDERS_VERSION } },
      select: { id: true, docFolders: true },
      take: BATCH,
      orderBy: { id: "asc" },
    });
    if (rows.length === 0) break;
    for (const d of rows) {
      const next = d.docFolders.length ? withLeaseFolder(d.docFolders) : d.docFolders;
      await prisma.deal.update({
        where: { id: d.id },
        data: { docFoldersVersion: DOC_FOLDERS_VERSION, ...(next !== d.docFolders && next.length !== d.docFolders.length ? { docFolders: next } : {}) },
      });
      if (next.length !== d.docFolders.length) updated++;
    }
    if (rows.length < BATCH) break;
  }
  if (updated) console.log(`Document folders backfill: added the Lease folder to ${updated} customized deal folder list${updated === 1 ? "" : "s"}.`);
  return updated;
}
