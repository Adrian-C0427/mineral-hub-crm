import nodemailer, { type Transporter } from "nodemailer";
import { env, smtpConfigured } from "../config.js";
import { HttpError } from "../middleware/errors.js";
import { orgResendSender, envResendSender, sendViaResend } from "./resend.js";

let transporter: Transporter | null = null;

function getSmtpTransport(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP.HOST,
      port: env.SMTP.PORT,
      secure: env.SMTP.SECURE,
      auth: { user: env.SMTP.USER, pass: env.SMTP.PASS },
    });
  }
  return transporter;
}

export interface SendParams {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  /**
   * When set, the org's connected Resend integration (key + sender identity)
   * is preferred over the instance-wide transports.
   */
  organizationId?: string;
}

/**
 * Deliver one email. Transport resolution, most specific first:
 *  1. The org's connected Resend integration (Settings → Integrations).
 *  2. The instance-wide Resend fallback (RESEND_API_KEY + RESEND_FROM).
 *  3. The SMTP fallback (SMTP_* env vars).
 * Resend is the app's primary provider; SMTP exists so self-hosters without a
 * Resend account still get system email.
 */
export async function sendEmail(params: SendParams): Promise<void> {
  const resend = (params.organizationId ? await orgResendSender(params.organizationId) : null) ?? envResendSender();
  if (resend) {
    try {
      await sendViaResend(resend.apiKey, {
        from: resend.from, to: params.to, subject: params.subject, html: params.html, replyTo: params.replyTo,
      });
      return;
    } catch (e) {
      // No silent fallback to SMTP: a delivery split across providers is far
      // harder to debug than a clear error naming the failing transport.
      const where = resend.source === "org" ? "the connected Resend integration" : "the RESEND_API_KEY fallback";
      throw new HttpError(502, `Email via ${where} failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }
  if (!smtpConfigured()) {
    throw new HttpError(503, "Email is not configured. Connect Resend in Settings → Integrations (or set RESEND_API_KEY/RESEND_FROM, or SMTP_* variables, on the API service).");
  }
  const tx = getSmtpTransport();
  await tx.sendMail({
    from: env.SMTP.FROM,
    to: params.to,
    subject: params.subject,
    html: params.html,
    replyTo: params.replyTo,
  });
}

/**
 * Fill {{token}} placeholders with PLAIN values. Unknown tokens are left
 * as-is. Escaping is NOT done here — it happens exactly once, at HTML
 * conversion time (renderEmailBody). Escaping in both places double-encoded
 * values ("A&B" arrived as "A&amp;B") and put HTML entities into plain-text
 * subjects.
 */
export function personalize(template: string, tokens: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const v = tokens[key];
    return v == null ? match : String(v);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Personalize a body template and produce the HTML to send, escaping exactly
 * once. HTML-vs-plain is decided on the TEMPLATE (before substitution) so a
 * token value containing "<" can't flip a plain-text email into raw HTML.
 */
export function renderEmailBody(template: string, tokens: Record<string, string | number | null | undefined>): string {
  if (/<[a-z][\s\S]*>/i.test(template)) {
    // HTML template: substitute escaped values so buyer-provided strings
    // can't inject markup; the template's own tags pass through.
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
      const v = tokens[key];
      return v == null ? match : escapeHtml(String(v));
    });
  }
  // Plain-text template: substitute plain, escape the whole thing once,
  // convert newlines.
  return personalize(template, tokens).split("\n").map((line) => escapeHtml(line)).join("<br>");
}
