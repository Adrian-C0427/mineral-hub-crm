import express from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { ZodError } from "zod";
import * as Sentry from "@sentry/node";
import { sentryEnabled } from "./instrument.js";
import { env } from "./config.js";
import { attachUser } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { dealsRouter } from "./routes/deals.js";
import { pipelineStagesRouter } from "./routes/pipelineStages.js";
import { tractsRouter } from "./routes/tracts.js";
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
import { gisRouter, gisTilesRouter } from "./routes/gis.js";
import { portalRouter } from "./routes/portal.js";
import { notificationsRouter } from "./routes/notifications.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1); // Railway terminates TLS at a proxy

  // Security headers. crossOriginResourcePolicy is relaxed because the SPA is
  // served from a different Railway subdomain than the API.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  // Vector tiles (protobuf) compress ~70%; JSON responses benefit too. The
  // default filter skips application/x-protobuf, so include it explicitly.
  app.use(compression({
    filter: (req, res) =>
      /protobuf/.test(String(res.getHeader("Content-Type") ?? "")) || compression.filter(req, res),
  }));

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
  app.use("/api/pipeline", pipelineStagesRouter);
  app.use("/api/deals", dealsRouter);
  // Tract descriptions live on their own router; Express falls through to it
  // for the /api/deals/:id/tracts* paths the deals router doesn't define.
  app.use("/api/deals", tractsRouter);
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
  app.use("/api/notifications", notificationsRouter);
  // Buyer Offering Portal: public, unauthenticated — serves only whitelisted,
  // explicitly published data (see routes/portal.ts).
  app.use("/api/portal", portalRouter);
  // Public cadastral vector tiles (MapLibre fetches carry no auth header);
  // must be mounted before the authed /api/gis router.
  app.use("/api/gis/tiles", gisTilesRouter);
  app.use("/api/gis", gisRouter);

  app.use(notFound);
  // Sentry captures errors before our own handler formats the response.
  // ZodError carries no statusCode, so Sentry's default filter would report it
  // as a 500-class fault even though errorHandler answers it with a 400.
  if (sentryEnabled) {
    Sentry.setupExpressErrorHandler(app, {
      shouldHandleError(err) {
        if (err instanceof ZodError) return false;
        const status = Number((err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode ?? 500);
        return status >= 500;
      },
    });
  }
  app.use(errorHandler);
  return app;
}
