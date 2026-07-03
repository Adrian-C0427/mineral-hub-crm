/**
 * Sentry initialization — MUST be imported before Express and any route code so
 * the SDK can auto-instrument HTTP/Express (it patches modules at require time).
 * index.ts imports this file first, before anything else.
 *
 * Inert until SENTRY_DSN is set, so local and unconfigured deploys are unaffected.
 */
import * as Sentry from "@sentry/node";
import { env } from "./config.js";

export const sentryEnabled = Boolean(env.SENTRY.DSN);

if (sentryEnabled) {
  Sentry.init({
    dsn: env.SENTRY.DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.SENTRY.TRACES_SAMPLE_RATE,
    // Scrub obvious credential-bearing fields before events leave the process.
    beforeSend(event) {
      const req = event.request;
      if (req?.headers) { delete req.headers.authorization; delete req.headers.cookie; delete req.headers["x-api-key"]; }
      if (req?.data && typeof req.data === "object") {
        for (const k of ["secret", "password", "token"]) delete (req.data as Record<string, unknown>)[k];
      }
      return event;
    },
  });
}
