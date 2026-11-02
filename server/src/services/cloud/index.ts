/**
 * Cloud files: driver selection, record links, and the metadata sync.
 *
 * A link keeps a file IN the cloud and points a record at it — no copy, so
 * no duplicate to drift. The provider's permissions still decide who can open
 * it: teammates open it at OneDrive/Google (their own access applies); only
 * the account's owner can download it through the CRM. Three kinds of
 * document are kept distinct everywhere they show:
 *   stored  — FileAttachment in the CRM's own storage (S3/R2)
 *   linked  — CloudFileLink origin LINKED (picked from a drive)
 *   copied  — CloudFileLink origin COPIED (a stored document the member
 *             explicitly copied to their drive; the original stays put)
 *
 * The sync (every 30 min per account) follows the provider's change feed and
 * updates linked files' names, sizes and dates. A file deleted or trashed at
 * the provider becomes MISSING — the link is never deleted, and nothing in
 * the drive is ever changed by a sync.
 */
import type { CloudFileLink, ConnectedAccount } from "@prisma/client";
import { prisma } from "../../db.js";
import { ProviderError } from "../connected/client.js";
import { registerAccountSyncer } from "../connected/sync.js";
import { refOf, recordColumns, recordKey, type RecordRef } from "../connected/records.js";
import { oneDrive } from "./onedrive.js";
import { googleDrive } from "./gdrive.js";
import type { CloudDriver, CloudItem } from "./types.js";

export function driverFor(a: Pick<ConnectedAccount, "provider">): CloudDriver {
  if (a.provider === "onedrive") return oneDrive;
  if (a.provider === "googledrive") return googleDrive;
  throw new ProviderError("Not a cloud drive account.", "invalid");
}

export const isDriveProvider = (p: string) => p === "onedrive" || p === "googledrive";

export interface CloudLinkView {
  id: string;
  provider: string;
  accountId: string;
  ownerName: string | null;
  /** The viewer owns the account: they can download through the CRM. */
  mine: boolean;
  itemId: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  webUrl: string | null;
  modifiedAt: Date | null;
  origin: "LINKED" | "COPIED";
  status: "OK" | "MISSING" | "NO_ACCESS";
  folder: string;
  record: RecordRef | null;
  linkedBy: string | null;
  createdAt: Date;
}

type LinkRow = CloudFileLink & { account: { userId: string; displayName: string | null; email: string | null }; createdBy: { name: string } | null };

export function serializeLink(l: LinkRow, viewerId: string): CloudLinkView {
  return {
    id: l.id,
    provider: l.provider,
    accountId: l.accountId,
    ownerName: l.account.displayName ?? l.account.email,
    mine: l.account.userId === viewerId,
    itemId: l.providerFileId,
    name: l.name,
    mimeType: l.mimeType,
    sizeBytes: l.sizeBytes != null ? Number(l.sizeBytes) : null,
    webUrl: l.webUrl,
    modifiedAt: l.providerModifiedAt,
    origin: l.origin as CloudLinkView["origin"],
    status: l.status as CloudLinkView["status"],
    folder: l.folder,
    record: refOf(l),
    linkedBy: l.createdBy?.name ?? null,
    createdAt: l.createdAt,
  };
}

export const LINK_INCLUDE = {
  account: { select: { userId: true, displayName: true, email: true } },
  createdBy: { select: { name: true } },
} as const;

/** Link a drive item to a record (idempotent: linking it again refreshes it). */
export async function linkItem(p: {
  account: ConnectedAccount; item: CloudItem; record: RecordRef; folder: string; userId: string;
  origin?: "LINKED" | "COPIED"; sourceAttachmentId?: string | null;
}): Promise<LinkRow> {
  const key = recordKey(p.record);
  const data = {
    name: p.item.name,
    mimeType: p.item.mimeType,
    sizeBytes: p.item.sizeBytes != null ? BigInt(p.item.sizeBytes) : null,
    webUrl: p.item.webUrl,
    providerModifiedAt: p.item.modifiedAt ? new Date(p.item.modifiedAt) : null,
    driveId: p.item.driveId,
    folder: p.folder,
    status: "OK",
    lastCheckedAt: new Date(),
  };
  return prisma.cloudFileLink.upsert({
    where: { accountId_providerFileId_recordKey: { accountId: p.account.id, providerFileId: p.item.id, recordKey: key } },
    create: {
      ...data, ...recordColumns(p.record),
      organizationId: p.account.organizationId, accountId: p.account.id, provider: p.account.provider,
      providerFileId: p.item.id, recordKey: key, origin: p.origin ?? "LINKED",
      sourceAttachmentId: p.sourceAttachmentId ?? null, createdByUserId: p.userId,
    },
    update: data,
    include: LINK_INCLUDE,
  });
}

/** After a change at the provider: refresh (or mark missing) every link to the item. */
async function applyItem(accountId: string, itemId: string, item: CloudItem | null): Promise<number> {
  const data = item
    ? {
      name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes != null ? BigInt(item.sizeBytes) : null,
      webUrl: item.webUrl, providerModifiedAt: item.modifiedAt ? new Date(item.modifiedAt) : null, status: "OK", lastCheckedAt: new Date(),
    }
    : { status: "MISSING", lastCheckedAt: new Date() };
  return (await prisma.cloudFileLink.updateMany({ where: { accountId, providerFileId: itemId }, data })).count;
}

/** Mark links to an item missing right away (the member trashed it from the CRM). */
export const markItemMissing = (accountId: string, itemId: string) => applyItem(accountId, itemId, null);

const RECHECK_MS = 24 * 60 * 60_000;

/**
 * One drive account's sync: follow the change feed from its cursor and apply
 * changes to linked files; on a fresh/expired cursor, re-check linked files
 * directly. Also re-checks links not confirmed in a day (catches lost access).
 */
async function syncDrive(account: ConnectedAccount): Promise<string> {
  const driver = driverFor(account);
  const state = (account.syncState ?? {}) as { changes?: string };
  let cursor = state.changes ?? null;
  let res = await driver.changes(account, cursor);
  if (res.reset) { cursor = null; res = await driver.changes(account, null); }

  const linked = new Set((await prisma.cloudFileLink.findMany({ where: { accountId: account.id }, select: { providerFileId: true } })).map((l) => l.providerFileId));
  let updated = 0;
  for (const c of res.changes) {
    if (linked.has(c.id)) updated += await applyItem(account.id, c.id, c.removed ? null : c.item);
  }
  await prisma.connectedAccount.update({ where: { id: account.id }, data: { syncState: { ...state, changes: res.cursor } } });

  // Direct re-check: everything when the cursor was (re)started, else links unchecked for a day.
  const stale = await prisma.cloudFileLink.findMany({
    where: { accountId: account.id, ...(cursor ? { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(Date.now() - RECHECK_MS) } }] } : {}) },
    select: { providerFileId: true }, distinct: ["providerFileId"], take: 200,
  });
  for (const s of stale) {
    try {
      updated += await applyItem(account.id, s.providerFileId, await driver.get(account, s.providerFileId));
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (e.kind === "notfound") updated += await applyItem(account.id, s.providerFileId, null);
      else if (e.kind === "permission") {
        updated += (await prisma.cloudFileLink.updateMany({ where: { accountId: account.id, providerFileId: s.providerFileId }, data: { status: "NO_ACCESS", lastCheckedAt: new Date() } })).count;
      } else throw e;
    }
  }
  return linked.size === 0 ? "Up to date (no linked files yet)." : `Up to date — ${linked.size} linked file${linked.size === 1 ? "" : "s"} checked${updated ? `, ${updated} updated` : ""}.`;
}

registerAccountSyncer("onedrive", syncDrive);
registerAccountSyncer("googledrive", syncDrive);
