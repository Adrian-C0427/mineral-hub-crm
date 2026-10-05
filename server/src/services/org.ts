import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../middleware/errors.js";
import { ASSIGNABLE_ROLES, resolvePermissions, type OrgRole } from "../domain/permissions.js";
import { getRoleOverride } from "./rolePermCache.js";

// Unambiguous alphabet (no 0/O/1/I) for human-shareable codes.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * `tx` is threaded through rather than defaulting to the base client at the
 * point of use: both callers can run inside an interactive transaction, and
 * probing on the base client from in there occupies a SECOND pooled connection
 * for the life of the transaction — the shape that deadlocks a small pgbouncer
 * pool under concurrency. Same client in, same connection used.
 */
export async function generateTeamId(
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const candidate = `TEAM-${randomCode(6)}`;
    const exists = await tx.organization.findUnique({ where: { teamId: candidate } });
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
  const teamId = await generateTeamId(tx);
  return tx.organization.create({ data: { name, teamId } });
}

/**
 * Issue a NEW Team ID for an org, invalidating the previous one.
 *
 * The Team ID is an always-valid reusable join key (see resolveJoinToken): it
 * never expires and, unlike an invite code, has no active flag and no use cap.
 * Without rotation there was no way to revoke it at all, so removing a member
 * did not actually revoke their ability to re-enter — they simply re-joined
 * with the value they had already read. This is the missing remedy, and it is
 * what member removal calls.
 *
 * Returns the new Team ID.
 */
export async function rotateTeamId(
  organizationId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string> {
  const teamId = await generateTeamId(tx);
  await tx.organization.update({ where: { id: organizationId }, data: { teamId } });
  return teamId;
}

/**
 * Deactivate every invite code a departing member could still redeem.
 *
 * Rotating the Team ID alone left invite codes live: they never expire, and a
 * reusable one keeps working until someone disables it. A removed admin who had
 * read GET /org/invites could log back in (their account stays ACTIVE, just
 * org-less) and POST /auth/join with one of them to walk straight back in.
 *
 * Anyone who held `inviteRemoveUsers` could list ALL of the org's codes, so for
 * them every active code is burned. Everyone else can only know codes they
 * created themselves. Returns how many codes were deactivated so the caller can
 * tell the owner to issue fresh ones.
 *
 * Must be passed the member row as it was BEFORE detaching (orgRole intact).
 */
export async function revokeInvitesKnownTo(
  organizationId: string,
  member: { id: string; orgRole: string | null },
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  const role = member.orgRole as OrgRole | null;
  const perms = role ? resolvePermissions(role, await getRoleOverride(organizationId, role)) : [];
  const sawAllCodes = role === "OWNER" || perms.includes("inviteRemoveUsers");
  const { count } = await tx.inviteCode.updateMany({
    where: { organizationId, active: true, ...(sawAllCodes ? {} : { createdByUserId: member.id }) },
    data: { active: false },
  });
  return count;
}

/** A role someone can be given: by a role change or by an invite code. Never OWNER. */
export type GrantableRole = "ADMIN" | "MEMBER" | "VIEWER";

/** New invite codes stop working this many days after they are created. */
export const INVITE_TTL_DAYS = 7;

export function inviteExpiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The one rule for handing a role to someone else, shared by "change a member's
 * role" (PATCH /org/members/:userId) and invite codes (which hand the role to
 * whoever redeems them). OWNER is never grantable — ownership only moves through
 * transfer-ownership — and only the owner can designate administrators.
 */
export function assertCanGrantRole(callerRole: OrgRole | null, role: OrgRole): asserts role is GrantableRole {
  if (!ASSIGNABLE_ROLES.includes(role)) throw new HttpError(400, "That role cannot be assigned");
  if (role === "ADMIN" && callerRole !== "OWNER") {
    throw new HttpError(403, "Only the owner can designate administrators");
  }
}

/** Non-throwing form of assertCanGrantRole, for deciding what a caller may see. */
export function canGrantRole(callerRole: OrgRole | null, role: OrgRole): boolean {
  return ASSIGNABLE_ROLES.includes(role) && (role !== "ADMIN" || callerRole === "OWNER");
}

export interface ResolvedJoin {
  organizationId: string;
  inviteCodeId: string | null;
  /** Role the joiner receives. A Team ID, or a code with no role, gives MEMBER. */
  role: GrantableRole;
}

/** The slice of the Prisma client resolveJoinToken reads (lets tests pass a fake). */
type JoinLookupClient = {
  organization: Pick<typeof prisma.organization, "findUnique">;
  inviteCode: Pick<typeof prisma.inviteCode, "findUnique">;
};

/**
 * Resolve a join token that may be either an Organization Team ID or an InviteCode.
 * Validates invite-code active/expired/exhausted state and works out the role the
 * joiner gets. Throws HttpError on invalid tokens. This is the single gate every
 * redeem path goes through (register, SSO sign-up, POST /auth/join).
 * Does NOT mutate usage counts — call consumeInvite after a successful join.
 */
export async function resolveJoinToken(
  rawToken: string,
  db: JoinLookupClient = prisma,
  now: Date = new Date(),
): Promise<ResolvedJoin> {
  const token = rawToken.trim();
  if (!token) throw new HttpError(400, "Enter a Team ID or invite code");

  // Team ID (always-valid reusable join key)
  const org = await db.organization.findUnique({ where: { teamId: token } });
  if (org) return { organizationId: org.id, inviteCodeId: null, role: "MEMBER" };

  // Invite code
  const invite = await db.inviteCode.findUnique({ where: { code: token } });
  if (!invite) throw new HttpError(404, "That Team ID or invite code was not found");
  if (!invite.active) throw new HttpError(400, "That invite code has been disabled");
  // expiresAt NULL = a code from before expiry existed: never expires.
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) {
    throw new HttpError(400, "That invite code has expired");
  }
  const cap = invite.reusable ? invite.maxUses : 1;
  if (cap != null && invite.uses >= cap) {
    throw new HttpError(400, "That invite code has already been used");
  }
  // role NULL = a code from before roles existed: MEMBER, as always. Anything
  // that is not an assignable role (OWNER, retired MANAGER) can only have been
  // written around the API, so the code is refused rather than honored.
  const role: OrgRole = (invite.role as OrgRole | null) ?? "MEMBER";
  if (role !== "ADMIN" && role !== "MEMBER" && role !== "VIEWER") {
    throw new HttpError(400, "That invite code is not valid");
  }
  return { organizationId: invite.organizationId, inviteCodeId: invite.id, role };
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
