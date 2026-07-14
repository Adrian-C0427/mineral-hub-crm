/**
 * Per-provider connection validation — the "live" half of the integration
 * framework. Each validator makes the cheapest officially-supported
 * authenticated call for its provider and maps the outcome to {ok, message}.
 * Nothing here is billed (model/domain list endpoints, webhook posts).
 *
 * Validators receive the DECRYPTED secret and must never include it in the
 * returned message. All calls carry an 8s timeout so a slow provider can't
 * hang a request thread.
 */
import nodemailer from "nodemailer";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { env, smtpConfigured } from "../config.js";
import { s3Configured } from "./s3.js";
import { enabledProviders } from "./oauth.js";
import { fetchResendDomains } from "./resend.js";

export interface ValidationResult {
  ok: boolean;
  message: string;
}

const TIMEOUT_MS = 8000;

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

const ok = (message: string): ValidationResult => ({ ok: true, message });
const fail = (message: string): ValidationResult => ({ ok: false, message });

function authOutcome(res: Response, provider: string): ValidationResult {
  if (res.ok) return ok(`${provider} credentials verified.`);
  if (res.status === 401 || res.status === 403) return fail(`${provider} rejected the credential (HTTP ${res.status}). Check the key and its permissions.`);
  return fail(`${provider} returned HTTP ${res.status}. The credential may be valid — try again or check the provider's status page.`);
}

// --- API-key providers -------------------------------------------------------

async function validateAnthropic(secret: string): Promise<ValidationResult> {
  const res = await timedFetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": secret, "anthropic-version": "2023-06-01" },
  });
  return authOutcome(res, "Anthropic");
}

async function validateResend(secret: string): Promise<ValidationResult> {
  // Listing domains both authenticates the key and tells the admin whether
  // their sending domain is actually verified — the thing that gates delivery.
  try {
    const domains = await fetchResendDomains(secret);
    if (!domains.length) return ok("Resend key verified. No sending domains found yet — add and verify one at resend.com/domains before sending.");
    const verified = domains.filter((d) => d.status === "verified").map((d) => d.name);
    return ok(verified.length
      ? `Resend key verified. Sending domain${verified.length === 1 ? "" : "s"} ready: ${verified.join(", ")}.`
      : `Resend key verified, but no domain is fully verified yet (${domains.map((d) => `${d.name}: ${d.status}`).join(", ")}). Finish DNS verification at resend.com/domains.`);
  } catch (e) {
    return fail(`Resend rejected the key: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}

// --- Webhook providers -------------------------------------------------------

// Power Automate "when a Teams webhook request is received" URLs live on
// *.logic.azure.com (e.g. prod-00.westus.logic.azure.com). Anchor to that host
// family (not any *.azure.com) so a connecting admin can't point the server's
// outbound webhook at unrelated Azure endpoints (management.azure.com, etc.).
const TEAMS_WEBHOOK = /^https:\/\/[a-z0-9.-]+\.logic\.azure\.com(:\d+)?\//i;

async function postWebhook(url: string, body: unknown, provider: string): Promise<ValidationResult> {
  const res = await timedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok || res.status === 202) return ok(`${provider} webhook reachable — a confirmation message was posted to the channel.`);
  return fail(`${provider} webhook returned HTTP ${res.status}. Re-copy the URL from ${provider}.`);
}

async function validateTeams(secret: string): Promise<ValidationResult> {
  if (!TEAMS_WEBHOOK.test(secret)) return fail("That doesn't look like a Teams Workflows webhook URL (expected an ….azure.com address from Power Automate).");
  return postWebhook(
    secret,
    {
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
          body: [{ type: "TextBlock", text: "✅ Mineral Hub connected. Deal and buyer notifications will post here.", wrap: true }],
        },
      }],
    },
    "Teams",
  );
}

// --- Env-configured (builtin) providers --------------------------------------

async function validateSmtp(): Promise<ValidationResult> {
  if (!smtpConfigured()) return fail("SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS on the API service.");
  const transporter = nodemailer.createTransport({
    host: env.SMTP.HOST, port: env.SMTP.PORT, secure: env.SMTP.SECURE,
    auth: { user: env.SMTP.USER, pass: env.SMTP.PASS },
    connectionTimeout: TIMEOUT_MS,
  });
  try {
    await transporter.verify();
    return ok(`SMTP connection to ${env.SMTP.HOST} verified.`);
  } catch (e) {
    return fail(`SMTP verification failed: ${e instanceof Error ? e.message : "unknown error"}`);
  } finally {
    transporter.close();
  }
}

async function validateStorage(): Promise<ValidationResult> {
  if (!s3Configured()) return fail("Object storage is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY (plus S3_ENDPOINT for R2/B2) on the API service.");
  const client = new S3Client({
    region: env.S3.REGION, endpoint: env.S3.ENDPOINT, forcePathStyle: env.S3.FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3.ACCESS_KEY_ID, secretAccessKey: env.S3.SECRET_ACCESS_KEY },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: env.S3.BUCKET }));
    return ok(`Bucket "${env.S3.BUCKET}" is reachable with the configured credentials.`);
  } catch (e) {
    return fail(`Bucket check failed: ${e instanceof Error ? e.message : "unknown error"}`);
  } finally {
    client.destroy();
  }
}

async function validateEntraSignin(): Promise<ValidationResult> {
  const enabled = enabledProviders().some((p) => p.key === "microsoft");
  return enabled
    ? ok("Sign-in provider is configured and enabled on the login page.")
    : fail("Not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET on the API service.");
}

// --- Registry -----------------------------------------------------------------

/** Providers whose credential we hold and can validate right now. */
const SECRET_VALIDATORS: Record<string, (secret: string) => Promise<ValidationResult>> = {
  resend: validateResend,
  claude: validateAnthropic,
  teams: validateTeams,
};

/** Built-in services validated against the live environment configuration. */
const ENV_VALIDATORS: Record<string, () => Promise<ValidationResult>> = {
  smtp: validateSmtp,
  storage: validateStorage,
  entra: validateEntraSignin,
};

export function hasSecretValidator(provider: string): boolean {
  return provider in SECRET_VALIDATORS;
}

export function isEnvProvider(provider: string): boolean {
  return provider in ENV_VALIDATORS;
}

/** Reflect an env-configured provider's live status (no stored state involved). */
export async function validateEnvProvider(provider: string): Promise<ValidationResult> {
  const fn = ENV_VALIDATORS[provider];
  if (!fn) return fail("Unknown built-in provider.");
  try {
    return await fn();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Validation failed.");
  }
}

/** Validate a decrypted credential against the provider's API. */
export async function validateSecret(provider: string, secret: string): Promise<ValidationResult> {
  const fn = SECRET_VALIDATORS[provider];
  if (!fn) return fail("This provider does not support credential validation yet.");
  try {
    return await fn(secret);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return fail("The provider did not respond within 8 seconds. Try again.");
    return fail(e instanceof Error ? e.message : "Validation failed.");
  }
}

/** Env-configured status summary for the catalog listing (cheap, no network). */
export function envConfigured(provider: string): boolean {
  switch (provider) {
    case "smtp": return smtpConfigured();
    case "storage": return s3Configured();
    case "entra": return enabledProviders().some((p) => p.key === "microsoft");
    default: return false;
  }
}
