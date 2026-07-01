import nodemailer, { type Transporter } from "nodemailer";
import { env, emailConfigured } from "../config.js";
import { HttpError } from "../middleware/errors.js";

let transporter: Transporter | null = null;

function getTransport(): Transporter {
  if (!emailConfigured()) {
    throw new HttpError(503, "Email is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS on the API service.");
  }
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
}

export async function sendEmail(params: SendParams): Promise<void> {
  const tx = getTransport();
  await tx.sendMail({
    from: env.SMTP.FROM,
    to: params.to,
    subject: params.subject,
    html: params.html,
    replyTo: params.replyTo,
  });
}

/**
 * Fill {{token}} placeholders. Unknown tokens are left as-is. Values are
 * HTML-escaped since the body is sent as HTML.
 */
export function personalize(template: string, tokens: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const v = tokens[key];
    return v == null ? match : escapeHtml(String(v));
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Wrap a (possibly plain-text) body in minimal HTML, converting newlines. */
export function toHtmlBody(body: string): string {
  // If it already looks like HTML, pass through; otherwise convert newlines.
  if (/<[a-z][\s\S]*>/i.test(body)) return body;
  return body.split("\n").map((line) => escapeHtml(line)).join("<br>");
}
