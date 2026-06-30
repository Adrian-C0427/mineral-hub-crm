import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/password.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOwner, type AuthedRequest } from "../middleware/auth.js";

export const usersRouter = Router();

// All user management is Owner-only (enforced server-side).
usersRouter.use(requireAuth);

usersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    // Any authed user can read the user list (for owner-attribution dropdowns),
    // but never password hashes.
    const users = await prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
      orderBy: { name: "asc" },
    });
    res.json(users);
  }),
);

// Account creation requires all profile fields.
const createSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  phone: z.string().trim().min(1, "Phone number is required"),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["OWNER", "ASSOCIATE"]),
});

usersRouter.post(
  "/",
  requireOwner,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
    if (exists) throw new HttpError(409, "A user with that email already exists");
    const user = await prisma.user.create({
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        name: `${data.firstName} ${data.lastName}`,
        email: data.email.toLowerCase(),
        passwordHash: await hashPassword(data.password),
        role: data.role,
      },
      select: { id: true, name: true, email: true, role: true, status: true },
    });
    res.status(201).json(user);
  }),
);

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(["OWNER", "ASSOCIATE"]).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  password: z.string().min(8).optional(),
});

usersRouter.patch(
  "/:id",
  requireOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = updateSchema.parse(req.body);
    const patch: Record<string, unknown> = {};
    if (data.name) patch.name = data.name;
    if (data.role) patch.role = data.role;
    if (data.status) patch.status = data.status;
    if (data.password) patch.passwordHash = await hashPassword(data.password);
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: patch,
      select: { id: true, name: true, email: true, role: true, status: true },
    });
    res.json(user);
  }),
);

usersRouter.delete(
  "/:id",
  requireOwner,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.params.id === req.user!.id) throw new HttpError(400, "You cannot delete your own account");
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);
