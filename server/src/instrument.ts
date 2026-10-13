/**
 * Sentry initialization — MUST be imported before Express and any route code so
 * the SDK can auto-instrument HTTP/Express (it patches modules at require time).
 * index.ts imports this file first, before anything else.
 *
 * Inert until SENTRY_DSN is set, so local and unconfigured deploys are unaffected.
 */
import * as Sentry from "@sentry/node";
import { env } from "./config.js";
import { scrubSentryRequest } from "./sentryScrub.js";

export const sentryEnabled = Boolean(env.SENTRY.DSN);

if (sentryEnabled) {
  Sentry.init({
    dsn: env.SENTRY.DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.SENTRY.TRACES_SAMPLE_RATE,
    // Scrub credentials before events leave the process. The SDK captures the
    // request body as a raw string, so this must handle strings (sentryScrub.ts);
    // transactions carry the same request data, so they are scrubbed too.
    beforeSend(event) {
      scrubSentryRequest(event.request);
      return event;
    },
    beforeSendTransaction(event) {
      scrubSentryRequest(event.request);
      return event;
    },
  });
}
