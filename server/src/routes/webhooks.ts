/**
 * Public provider webhooks (no session): Microsoft Graph change
 * notifications for connected Outlook mailboxes (services/mail/subscriptions.ts).
 *
 *  - Subscription validation: Graph POSTs ?validationToken=… and expects it
 *    echoed as text/plain within 10 seconds.
 *  - Notifications are verified against each subscription's clientState
 *    (stored hashed) before anything happens; they only ever trigger the
 *    mailbox's normal sync — their payload is never trusted as data.
 *  - Rate limited; always answers 202 for a well-formed batch, so a caller
 *    can't probe which subscriptions exist.
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../middleware/errors.js";
import { handleNotifications, type GraphNotification } from "../services/mail/subscriptions.js";

export const webhooksRouter = Router();

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests." },
});

webhooksRouter.post(
  "/graph",
  limiter,
  asyncHandler(async (req, res) => {
    const token = req.query.validationToken;
    if (typeof token === "string") {
      // Echo exactly what Graph sent (plain text, nothing else), and only a token-shaped value.
      if (token.length > 1024) return res.status(400).end();
      return res.status(200).type("text/plain").send(token);
    }
    const body = req.body as { value?: unknown } | undefined;
    const items = Array.isArray(body?.value) ? (body!.value as GraphNotification[]) : [];
    // Answer fast (Graph retries slow endpoints); the work is a sync nudge.
    void handleNotifications(items).catch(() => {});
    res.status(202).end();
  }),
);
