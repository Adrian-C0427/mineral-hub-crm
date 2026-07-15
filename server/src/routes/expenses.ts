import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { requireAuth, requireOrg, requirePermission, orgId, type AuthedRequest } from "../middleware/auth.js";
import { logActivity } from "../services/activityLog.js";
import { money } from "../domain/format.js";
import { aggregateExpenseDashboard } from "../domain/expenses.js";

export const expensesRouter = Router();
expensesRouter.use(requireAuth, requireOrg);

/** True if the caller may approve/settle reimbursements. */
function canApprove(req: AuthedRequest): boolean {
  return req.user!.orgRole === "OWNER" || req.user!.permissions.includes("approveExpenses");
}

// Seeded on first access so a new org always has a working category list.
// Categories live in a table (not an enum) so admins can add/edit/remove them.
const DEFAULT_CATEGORIES = ["Software", "Skiptracing", "Closing Cost", "CRM", "Dialer", "SMS"];

async function ensureCategories(organizationId: string): Promise<void> {
  const count = await prisma.expenseCategory.count({ where: { organizationId } });
  if (count > 0) return;
  await prisma.expenseCategory.createMany({
    data: DEFAULT_CATEGORIES.map((name) => ({ organizationId, name })),
    skipDuplicates: true,
  });
}

// A yyyy-mm-dd or ISO datetime string → Date.
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, "Expected a date")
  .transform((s) => new Date(s));

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

expensesRouter.get(
  "/categories",
  asyncHandler(async (req: AuthedRequest, res) => {
    await ensureCategories(orgId(req));
    const cats = await prisma.expenseCategory.findMany({
      where: { organizationId: orgId(req) },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    res.json(cats);
  }),
);

expensesRouter.post(
  "/categories",
  requirePermission("manageExpenses"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { name } = z.object({ name: z.string().trim().min(1) }).parse(req.body);
    const existing = await prisma.expenseCategory.findFirst({
      where: { organizationId: orgId(req), name },
    });
    if (existing) throw new HttpError(409, "A category with that name already exists");
    const cat = await prisma.expenseCategory.create({
      data: { organizationId: orgId(req), name },
    });
    res.status(201).json(cat);
  }),
);

expensesRouter.patch(
  "/categories/:id",
  requirePermission("manageExpenses"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = z
      .object({ name: z.string().trim().min(1).optional(), active: z.boolean().optional() })
      .parse(req.body);
    const cat = await prisma.expenseCategory.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
    });
    if (!cat) throw new HttpError(404, "Category not found");
    const updated = await prisma.expenseCategory.update({ where: { id: cat.id }, data });
    res.json(updated);
  }),
);

expensesRouter.delete(
  "/categories/:id",
  requirePermission("manageExpenses"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const cat = await prisma.expenseCategory.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
    });
    if (!cat) throw new HttpError(404, "Category not found");
    // Existing expenses keep their (now dangling) categoryId set to null via FK.
    await prisma.expenseCategory.delete({ where: { id: cat.id } });
    res.json({ ok: true });
  }),
);

// Persist a new category order (client sends the full id list top-to-bottom).
expensesRouter.post(
  "/categories/reorder",
  requirePermission("manageExpenses"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(req.body);
    const org = orgId(req);
    const owned = new Set((await prisma.expenseCategory.findMany({ where: { organizationId: org, id: { in: ids } }, select: { id: true } })).map((c) => c.id));
    await prisma.$transaction(
      ids.filter((id) => owned.has(id)).map((id, i) => prisma.expenseCategory.update({ where: { id }, data: { sortOrder: i } })),
    );
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

const listQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  userId: z.string().optional(),
  categoryId: z.string().optional(),
  reimbursed: z.enum(["true", "false"]).optional(),
});

function serializeExpense(e: {
  id: string;
  date: Date;
  amount: number;
  notes: string | null;
  reimbursed: boolean;
  reimbursementDate: Date | null;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  userId: string | null;
  user: { id: string; name: string } | null;
  createdAt: Date;
}) {
  return {
    id: e.id,
    date: e.date,
    amount: e.amount,
    notes: e.notes,
    reimbursed: e.reimbursed,
    reimbursementDate: e.reimbursementDate,
    categoryId: e.categoryId,
    categoryName: e.category?.name ?? null,
    userId: e.userId,
    userName: e.user?.name ?? null,
    createdAt: e.createdAt,
  };
}

const withRefs = { category: { select: { id: true, name: true } }, user: { select: { id: true, name: true } } };

expensesRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = listQuery.parse(req.query);
    const where: Record<string, unknown> = { organizationId: orgId(req) };
    if (q.userId) where.userId = q.userId;
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.reimbursed) where.reimbursed = q.reimbursed === "true";
    if (q.from || q.to) {
      where.date = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999Z`) } : {}),
      };
    }
    const expenses = await prisma.expense.findMany({
      where,
      include: withRefs,
      orderBy: { date: "desc" },
      // Bound the list view (newest first). The /dashboard aggregate below is
      // deliberately left uncapped so totals stay correct.
      take: 5000,
    });
    res.json(expenses.map(serializeExpense));
  }),
);

const createSchema = z.object({
  date: dateStr,
  amount: z.number().nonnegative(),
  categoryId: z.string().nullish(),
  notes: z.string().nullish(),
  reimbursed: z.boolean().optional(),
  reimbursementDate: dateStr.nullish(),
});

expensesRouter.post(
  "/",
  requirePermission("manageExpenses"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = createSchema.parse(req.body);
    // Settling reimbursement on creation requires approval rights.
    if (data.reimbursed && !canApprove(req)) throw new HttpError(403, "You cannot mark expenses reimbursed");
    // Validate category belongs to the org (if provided).
    if (data.categoryId) {
      const cat = await prisma.expenseCategory.findFirst({
        where: { id: data.categoryId, organizationId: orgId(req) },
      });
      if (!cat) throw new HttpError(400, "Invalid category");
    }
    const expense = await prisma.expense.create({
      data: {
        organizationId: orgId(req),
        userId: req.user!.id, // creator — forced from the session, never from the body
        date: data.date,
        amount: data.amount,
        categoryId: data.categoryId ?? null,
        notes: data.notes ?? null,
        reimbursed: data.reimbursed ?? false,
        reimbursementDate: data.reimbursed ? data.reimbursementDate ?? new Date() : null,
      },
      include: withRefs,
    });
    await logActivity({
      eventType: "EXPENSE_ADDED",
      summary: `${req.user!.name} added a ${money(expense.amount)} expense`,
      organizationId: orgId(req),
      actorUserId: req.user!.id,
    });
    res.status(201).json(serializeExpense(expense));
  }),
);

const updateSchema = z.object({
  date: dateStr.optional(),
  amount: z.number().nonnegative().optional(),
  categoryId: z.string().nullish(),
  notes: z.string().nullish(),
  reimbursed: z.boolean().optional(),
  reimbursementDate: dateStr.nullish(),
});

expensesRouter.patch(
  "/:id",
  requirePermission("manageExpenses"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const data = updateSchema.parse(req.body);
    const existing = await prisma.expense.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
    });
    if (!existing) throw new HttpError(404, "Expense not found");
    // CHANGING reimbursement status requires approval rights. The client echoes
    // the current value on every edit, so an unchanged flag must not 403 users
    // who only hold manageExpenses (they'd be unable to edit any field at all).
    if (data.reimbursed !== undefined && data.reimbursed !== existing.reimbursed && !canApprove(req)) {
      throw new HttpError(403, "You cannot change reimbursement status");
    }
    if (data.categoryId) {
      const cat = await prisma.expenseCategory.findFirst({
        where: { id: data.categoryId, organizationId: orgId(req) },
      });
      if (!cat) throw new HttpError(400, "Invalid category");
    }
    const patch: Record<string, unknown> = {};
    if (data.date !== undefined) patch.date = data.date;
    if (data.amount !== undefined) patch.amount = data.amount;
    if (data.categoryId !== undefined) patch.categoryId = data.categoryId;
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.reimbursed !== undefined) {
      patch.reimbursed = data.reimbursed;
      // Keep the reimbursement date consistent with the flag.
      if (data.reimbursed) {
        patch.reimbursementDate = data.reimbursementDate ?? existing.reimbursementDate ?? new Date();
      } else {
        patch.reimbursementDate = null;
      }
    } else if (data.reimbursementDate !== undefined) {
      patch.reimbursementDate = data.reimbursementDate;
    }
    const updated = await prisma.expense.update({
      where: { id: existing.id },
      data: patch,
      include: withRefs,
    });
    res.json(serializeExpense(updated));
  }),
);

expensesRouter.delete(
  "/:id",
  requirePermission("manageExpenses"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const existing = await prisma.expense.findFirst({
      where: { id: req.params.id, organizationId: orgId(req) },
    });
    if (!existing) throw new HttpError(404, "Expense not found");
    await prisma.expense.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Bulk actions — one atomic operation across the selected rows
// ---------------------------------------------------------------------------

const bulkSchema = z.object({
  ids: z.array(z.string()).min(1),
  action: z.enum(["reimburse", "unreimburse", "setCategory", "delete"]),
  categoryId: z.string().nullish(),
});

expensesRouter.post(
  "/bulk",
  requirePermission("manageExpenses"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { ids, action, categoryId } = bulkSchema.parse(req.body);
    // Reimbursement actions require approval rights.
    if ((action === "reimburse" || action === "unreimburse") && !canApprove(req)) {
      throw new HttpError(403, "You cannot change reimbursement status");
    }
    // Scope strictly to the caller's org — never touch rows outside it.
    const scoped = { id: { in: ids }, organizationId: orgId(req) };

    if (action === "setCategory") {
      if (categoryId) {
        const cat = await prisma.expenseCategory.findFirst({
          where: { id: categoryId, organizationId: orgId(req) },
        });
        if (!cat) throw new HttpError(400, "Invalid category");
      }
      const r = await prisma.expense.updateMany({ where: scoped, data: { categoryId: categoryId ?? null } });
      return res.json({ ok: true, count: r.count });
    }
    if (action === "delete") {
      const r = await prisma.expense.deleteMany({ where: scoped });
      return res.json({ ok: true, count: r.count });
    }
    // reimburse / unreimburse
    const reimbursed = action === "reimburse";
    const r = await prisma.expense.updateMany({
      where: scoped,
      data: { reimbursed, reimbursementDate: reimbursed ? new Date() : null },
    });
    res.json({ ok: true, count: r.count });
  }),
);

// ---------------------------------------------------------------------------
// Dashboard — totals + breakdowns for the expense analytics view
// ---------------------------------------------------------------------------

expensesRouter.get(
  "/dashboard",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { from, to } = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    const where: Record<string, unknown> = { organizationId: orgId(req) };
    if (from || to) {
      where.date = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
      };
    }
    const expenses = await prisma.expense.findMany({ where, include: withRefs });

    res.json(
      aggregateExpenseDashboard(
        expenses.map((e) => ({
          amount: e.amount,
          date: e.date,
          reimbursed: e.reimbursed,
          reimbursementDate: e.reimbursementDate,
          categoryName: e.category?.name ?? null,
          userId: e.userId,
          userName: e.user?.name ?? null,
        })),
      ),
    );
  }),
);
