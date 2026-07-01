import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requireOrgOwner, orgId, type AuthedRequest } from "../middleware/auth.js";
import { generateInviteCode } from "../services/org.js";

export const orgRouter = Router();
orgRouter.use(requireAuth, requireOrg);

// Current organization info (any member).
orgRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: orgId(req) },
      select: { id: true, name: true, teamId: true, createdAt: true },
    });
    const memberCount = await prisma.user.count({ where: { organizationId: orgId(req) } });
    res.json({ ...org, memberCount, yourRole: req.user!.orgRole });
  }),
);

// --- Members (owner only) ---
orgRouter.get(
  "/members",
  requireOrgOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    const members = await prisma.user.findMany({
      where: { organizationId: orgId(req) },
      select: { id: true, name: true, email: true, phone: true, orgRole: true, status: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(members);
  }),
);

orgRouter.delete(
  "/members/:userId",
  requireOrgOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.params.userId === req.user!.id) {
      throw new HttpError(400, "You cannot remove yourself from the organization");
    }
    const member = await prisma.user.findFirst({
      where: { id: req.params.userId, organizationId: orgId(req) },
    });
    if (!member) throw new HttpError(404, "Member not found in your organization");
    // Removing a member detaches them; their org-scoped records stay with the org.
    await prisma.user.update({
      where: { id: member.id },
      data: { organizationId: null, orgRole: null },
    });
    res.json({ ok: true });
  }),
);

// --- Invite codes (owner only) ---
orgRouter.get(
  "/invites",
  requireOrgOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    const invites = await prisma.inviteCode.findMany({
      where: { organizationId: orgId(req) },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      invites.map((i) => ({
        id: i.id,
        code: i.code,
        reusable: i.reusable,
        active: i.active,
        maxUses: i.maxUses,
        uses: i.uses,
        createdAt: i.createdAt,
      })),
    );
  }),
);

const createInviteSchema = z.object({
  reusable: z.boolean().default(false),
  maxUses: z.number().int().positive().nullish(),
});

orgRouter.post(
  "/invites",
  requireOrgOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { reusable, maxUses } = createInviteSchema.parse(req.body);
    const invite = await prisma.inviteCode.create({
      data: {
        organizationId: orgId(req),
        code: await generateInviteCode(),
        reusable,
        // Single-use codes are capped at 1; reusable codes honor an optional cap.
        maxUses: reusable ? maxUses ?? null : 1,
        createdByUserId: req.user!.id,
      },
    });
    res.status(201).json(invite);
  }),
);

orgRouter.patch(
  "/invites/:id",
  requireOrgOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const invite = await prisma.inviteCode.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
    });
    if (!invite) throw new HttpError(404, "Invite code not found");
    const updated = await prisma.inviteCode.update({ where: { id: invite.id }, data: { active } });
    res.json(updated);
  }),
);

orgRouter.delete(
  "/invites/:id",
  requireOrgOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    const invite = await prisma.inviteCode.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
    });
    if (!invite) throw new HttpError(404, "Invite code not found");
    await prisma.inviteCode.delete({ where: { id: invite.id } });
    res.json({ ok: true });
  }),
);
