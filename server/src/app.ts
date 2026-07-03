import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import * as Sentry from "@sentry/node";
import { sentryEnabled } from "./instrument.js";
import { env } from "./config.js";
import { attachUser } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { dealsRouter } from "./routes/deals.js";
import { buyersRouter } from "./routes/buyers.js";
import { offersRouter } from "./routes/offers.js";
import { filesRouter } from "./routes/files.js";
import { reportsRouter } from "./routes/reports.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { orgRouter } from "./routes/org.js";
import { mapRouter } from "./routes/map.js";
import { expensesRouter } from "./routes/expenses.js";
import { emailTemplatesRouter } from "./routes/emailTemplates.js";
import { integrationsRouter, integrationsOAuthCallbackRouter } from "./routes/integrations.js";
import { researchRouter } from "./routes/research.js";
import { wellsRouter } from "./routes/wells.js";
import { aiRouter } from "./routes/ai.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1); // Railway terminates TLS at a proxy

  // Security headers. crossOriginResourcePolicy is relaxed because the SPA is
  // served from a different Railway subdomain than the API.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

  // CORS locked to the frontend origin(s); credentials required for the cookie.
  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow same-origin / curl (no Origin header) and any configured frontend origin.
        if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error(`Origin not allowed by CORS: ${origin}`));
      },
      credentials: true,
    }),
  );

  // 25mb accommodates research CSV imports (county recording indexes / permit
  // exports posted as JSON strings); other payloads stay small in practice.
  app.use(express.json({ limit: "25mb" }));
  app.use(cookieParser());
  app.use(attachUser);

  app.get("/health", (_req, res) => res.json({ ok: true, env: env.NODE_ENV }));

  app.use("/api/auth", authRouter);
  app.use("/api/org", orgRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/deals", dealsRouter);
  app.use("/api/buyers", buyersRouter);
  app.use("/api/offers", offersRouter);
  app.use("/api/files", filesRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/map", mapRouter);
  app.use("/api/expenses", expensesRouter);
  app.use("/api/email-templates", emailTemplatesRouter);
  // Public OAuth callback (no session) must be matched before the authed router.
  app.use("/api/integrations", integrationsOAuthCallbackRouter);
  app.use("/api/integrations", integrationsRouter);
  app.use("/api/research", researchRouter);
  app.use("/api/wells", wellsRouter);
  app.use("/api/ai", aiRouter);

  app.use(notFound);
  // Sentry captures errors before our own handler formats the response.
  if (sentryEnabled) Sentry.setupExpressErrorHandler(app);
  app.use(errorHandler);
  return app;
}
