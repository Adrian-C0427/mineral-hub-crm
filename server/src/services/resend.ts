/**
 * Resend — the app's primary outbound email provider (https://resend.com).
 *
 * Two configuration layers, checked in order by services/email.ts:
 *  1. Per-org: the "resend" integration row (Settings → Integrations) holding
 *     an encrypted API key plus the org's sender identity (fromEmail/fromName)
 *     and a snapshot of the account's domain verification statuses.
 *  2. Instance-wide env fallback (RESEND_API_KEY + RESEND_FROM) so system
 *     email — password resets, invites — works before any org connects.
 *
 * All calls are plain REST (POST /emails, GET /domains) with an 8s timeout;
 * no SDK dependency. API errors are surfaced with Resend's own message so the
 * UI can say exactly what to fix (unverified domain, bad key, bad from).
 */
import type { Integration, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../config.js";
import { decryptSecret } from "./secrets.js";

const API = "https://api.resend.com";
const TIMEOUT_MS = 8000;

export interface ResendDomain {
  name: string;
  /** Resend statuses: "verified" | "pending" | "not_started" | "failure" | "temporary_failure" */
  status: string;
}

export interface ResendSender {
  apiKey: string;
  /** RFC 5322 From — `Name <addr>` or bare address. */
  from: string;
  /** Where the credential came from (drives error copy). */
  source: "org" | "env";
}

async function resendFetch(apiKey: string, path: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

async function errorMessage(res: Response): Promise<string> {
  const json = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
  return json.message ?? `Resend returned HTTP ${res.status}`;
}

/** List the account's sending domains with verification status. Throws on auth failure. */
export async function fetchResendDomains(apiKey: string): Promise<ResendDomain[]> {
  const res = await resendFetch(apiKey, "/domains");
  if (!res.ok) throw new Error(await errorMessage(res));
  const json = (await res.json()) as { data?: { name?: string; status?: string }[] };
  return (json.data ?? [])
    .filter((d) => typeof d.name === "string")
    .map((d) => ({ name: d.name!, status: d.status ?? "unknown" }));
}

export interface ResendSendParams {
  from: string;
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

/** Deliver one email through Resend. Throws with Resend's error message on failure. */
export async function sendViaResend(apiKey: string, p: ResendSendParams): Promise<void> {
  const res = await resendFetch(apiKey, "/emails", {
    method: "POST",
    body: JSON.stringify({
      from: p.from,
      to: [p.to],
      subject: p.subject,
      html: p.html,
      ...(p.replyTo ? { reply_to: p.replyTo } : {}),
    }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}

/** "Jane <jane@x.com>" from parts; bare address when no name is set. */
export function formatSender(fromEmail: string, fromName?: string | null): string {
  const name = fromName?.trim();
  return name ? `${name.replace(/[<>]/g, "")} <${fromEmail}>` : fromEmail;
}

/** Extract the domain of the configured sender ("deals@mail.x.com" → "mail.x.com"). */
export function senderDomain(fromEmail: string): string | null {
  const at = fromEmail.lastIndexOf("@");
  return at > 0 ? fromEmail.slice(at + 1).toLowerCase() : null;
}

/**
 * Verification check used at connect/test time: the configured sender's domain
 * must appear in the account's domain list as "verified". Returns a warning
 * string when it doesn't (Resend would reject or land in spam), null when OK.
 */
export function senderDomainWarning(fromEmail: string, domains: ResendDomain[]): string | null {
  const domain = senderDomain(fromEmail);
  if (!domain) return `"${fromEmail}" is not a valid sender address.`;
  const match = domains.find((d) => d.name.toLowerCase() === domain);
  if (!match) return `The domain "${domain}" is not registered in this Resend account — add and verify it at resend.com/domains, or use an address on a registered domain.`;
  if (match.status !== "verified") return `The domain "${domain}" is registered but its status is "${match.status}" — finish DNS verification at resend.com/domains before sending.`;
  return null;
}

/**
 * Resolve the org's connected Resend credential + sender identity, or null
 * when the org hasn't connected Resend (or the row is unusable).
 */
export async function orgResendSender(organizationId: string): Promise<ResendSender | null> {
  const row = await prisma.integration.findUnique({
    where: { organizationId_provider: { organizationId, provider: "resend" } },
  });
  if (!row || row.status === "NOT_CONNECTED") return null;
  const cfg = (row.config ?? {}) as { _secret?: string; fromEmail?: string; fromName?: string };
  if (!cfg._secret || !cfg.fromEmail) return null;
  try {
    return { apiKey: decryptSecret(cfg._secret), from: formatSender(cfg.fromEmail, cfg.fromName), source: "org" };
  } catch {
    return null; // encryption key changed — treated as not connected; test/sync will surface it
  }
}

/** Instance-wide env fallback credential, or null when unset. */
export function envResendSender(): ResendSender | null {
  if (!env.RESEND.API_KEY || !env.RESEND.FROM) return null;
  return { apiKey: env.RESEND.API_KEY, from: env.RESEND.FROM, source: "env" };
}

/**
 * Sync hook: re-fetch the account's domain list, persist the snapshot, and
 * re-evaluate the sender-domain warning (stored on lastError so the card
 * shows it). Returns a human summary for the sync result message.
 */
export async function refreshResendDomains(row: Integration): Promise<{ warning: string | null; summary: string }> {
  const cfg = (row.config ?? {}) as { _secret?: string; fromEmail?: string };
  if (!cfg._secret) throw new Error("No credential stored. Reconnect this integration.");
  const domains = await fetchResendDomains(decryptSecret(cfg._secret));
  const warning = typeof cfg.fromEmail === "string" ? senderDomainWarning(cfg.fromEmail, domains) : null;
  const latest = await prisma.integration.findUnique({ where: { id: row.id }, select: { config: true } });
  const merged = { ...((latest?.config ?? {}) as Record<string, unknown>), domains };
  await prisma.integration.update({
    where: { id: row.id },
    data: { config: merged as unknown as Prisma.InputJsonValue, lastError: warning },
  });
  const verified = domains.filter((d) => d.status === "verified").length;
  return { warning, summary: `${domains.length} domain${domains.length === 1 ? "" : "s"} on the account (${verified} verified).` };
}
