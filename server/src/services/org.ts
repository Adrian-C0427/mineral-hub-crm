import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../middleware/errors.js";

// Unambiguous alphabet (no 0/O/1/I) for human-shareable codes.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export async function generateTeamId(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const candidate = `TEAM-${randomCode(6)}`;
    const exists = await prisma.organization.findUnique({ where: { teamId: candidate } });
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique Team ID");
}

export async function generateInviteCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const candidate = `INV-${randomCode(8)}`;
    const exists = await prisma.inviteCode.findUnique({ where: { code: candidate } });
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique invite code");
}

/** Create a fresh organization and make it, by default, a solo workspace. */
export async function createOrganization(
  name: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const teamId = await generateTeamId();
  return tx.organization.create({ data: { name, teamId } });
}

export interface ResolvedJoin {
  organizationId: string;
  inviteCodeId: string | null;
}

/**
 * Resolve a join token that may be either an Organization Team ID or an InviteCode.
 * Validates invite-code active/exhausted state. Throws HttpError on invalid tokens.
 * Does NOT mutate usage counts — call consumeInvite after a successful join.
 */
export async function resolveJoinToken(rawToken: string): Promise<ResolvedJoin> {
  const token = rawToken.trim();
  if (!token) throw new HttpError(400, "Enter a Team ID or invite code");

  // Team ID (always-valid reusable join key)
  const org = await prisma.organization.findUnique({ where: { teamId: token } });
  if (org) return { organizationId: org.id, inviteCodeId: null };

  // Invite code
  const invite = await prisma.inviteCode.findUnique({ where: { code: token } });
  if (!invite) throw new HttpError(404, "That Team ID or invite code was not found");
  if (!invite.active) throw new HttpError(400, "That invite code has been disabled");
  const cap = invite.reusable ? invite.maxUses : 1;
  if (cap != null && invite.uses >= cap) {
    throw new HttpError(400, "That invite code has already been used");
  }
  return { organizationId: invite.organizationId, inviteCodeId: invite.id };
}

/** Increment usage after a successful join. */
export async function consumeInvite(
  inviteCodeId: string | null,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  if (!inviteCodeId) return;
  await tx.inviteCode.update({ where: { id: inviteCodeId }, data: { uses: { increment: 1 } } });
}

/**
 * Idempotent startup backfill: every ACTIVE user must belong to an organization so
 * all record queries can scope by organizationId uniformly. Users without one get a
 * personal org and become its OWNER. Any pre-existing org-less deals/buyers/activity
 * are attributed to that user's (relationship owner's) new org.
 */
export async function ensureUsersHaveOrganizations(): Promise<void> {
  const orphans = await prisma.user.findMany({ where: { organizationId: null } });
  for (const u of orphans) {
    const org = await createOrganization(`${u.name || u.email}'s Workspace`);
    await prisma.user.update({
      where: { id: u.id },
      data: { organizationId: org.id, orgRole: "OWNER" },
    });
    // Attribute any legacy records this user owns/created to the new org.
    await prisma.deal.updateMany({
      where: { organizationId: null, relationshipOwnerId: u.id },
      data: { organizationId: org.id },
    });
  }
}
