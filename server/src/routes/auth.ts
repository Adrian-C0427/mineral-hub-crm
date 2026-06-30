import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyPassword, hashPassword } from "../auth/password.js";
import { signSession, setSessionCookie, clearSessionCookie } from "../auth/session.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { LOGIN_RATE_LIMIT } from "../config.js";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: LOGIN_RATE_LIMIT.WINDOW_MS,
  max: LOGIN_RATE_LIMIT.MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // Constant-ish response — don't reveal whether the email exists.
    if (!user || user.status !== "ACTIVE") {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const token = signSession({ userId: user.id, role: user.role });
    setSessionCookie(res, token);
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  }),
);

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ user: req.user });
  }),
);

// Self-service account update (Settings page). All fields required.
const accountSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  phone: z.string().trim().min(1, "Phone number is required"),
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

authRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = accountSchema.parse(req.body);
    const email = data.email.toLowerCase();
    const clash = await prisma.user.findFirst({ where: { email, NOT: { id: req.user!.id } } });
    if (clash) throw new HttpError(409, "Another account already uses that email");

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        email,
        name: `${data.firstName} ${data.lastName}`,
        passwordHash: await hashPassword(data.password),
      },
      select: { id: true, name: true, email: true, role: true, firstName: true, lastName: true, phone: true },
    });
    res.json({ user });
  }),
);
