import dotenv from "dotenv";

dotenv.config();

/**
 * Business constants. Deliberately centralized so the 5/10/15-day rules are not
 * scattered magic numbers across the codebase.
 */
export const DEADLINE_RULES = {
  /** Find Buyer By = Date Under Contract + N calendar days. */
  FIND_BUYER_BY_DAYS_AFTER_CONTRACT: 15,
  /** Final Closing = Original Closing + N calendar days. */
  FINAL_CLOSING_DAYS_AFTER_ORIGINAL: 15,
} as const;

export const PRIORITY_RULES = {
  /** <= this many days to Find-Buyer-By (and no buyer) => High. */
  HIGH_THRESHOLD_DAYS: 5,
  /** <= this many days (and no buyer) => Medium; above => Low. */
  MEDIUM_THRESHOLD_DAYS: 10,
} as const;

export const STALE_CONTACT_DAYS = 60;

export const LOGIN_RATE_LIMIT = {
  WINDOW_MS: 15 * 60 * 1000,
  MAX_ATTEMPTS: 5,
} as const;

export const BCRYPT_COST = 12;

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

/** Sentinel default for JWT_SECRET — production must override it. */
export const INSECURE_JWT_DEFAULT = "dev-insecure-change-me";

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: parseInt(process.env.PORT ?? "4000", 10),
  DATABASE_URL: required("DATABASE_URL", "postgresql://localhost:5432/mineralhub"),
  JWT_SECRET: required("JWT_SECRET", INSECURE_JWT_DEFAULT),
  // Dedicated key for encrypting integration credentials at rest (AES-256-GCM).
  // Kept separate from JWT_SECRET so rotating session signing never orphans
  // stored credentials. Required in production; dev derives from JWT_SECRET.
  INTEGRATION_SECRET_KEY: process.env.INTEGRATION_SECRET_KEY ?? "",
  // Comma-separated list of allowed browser origins (the frontend service URL).
  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  COOKIE_NAME: process.env.COOKIE_NAME ?? "mh_session",
  // Set true in production (cross-subdomain Railway services require SameSite=None; Secure).
  COOKIE_CROSS_SITE: (process.env.COOKIE_CROSS_SITE ?? (process.env.NODE_ENV === "production" ? "true" : "false")) === "true",
  SESSION_TTL_HOURS: parseInt(process.env.SESSION_TTL_HOURS ?? "168", 10),
  // Signup policy. When false (the default), creating a BRAND-NEW workspace via
  // the register form or SSO is blocked — new users must present a valid Team ID
  // or invite code. Existing-user sign-in and invite-code joins are unaffected.
  ALLOW_PUBLIC_SIGNUP: process.env.ALLOW_PUBLIC_SIGNUP === "true",
  S3: {
    REGION: process.env.S3_REGION ?? "us-east-1",
    BUCKET: process.env.S3_BUCKET ?? "",
    ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "",
    SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "",
    // Optional custom endpoint for S3-compatible providers (R2, Backblaze, MinIO).
    ENDPOINT: process.env.S3_ENDPOINT || undefined,
    FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE === "true",
    SIGNED_URL_TTL_SECONDS: parseInt(process.env.S3_SIGNED_URL_TTL_SECONDS ?? "300", 10),
  },
  MAX_UPLOAD_BYTES: parseInt(process.env.MAX_UPLOAD_BYTES ?? String(25 * 1024 * 1024), 10),
  // Public URL of the frontend SPA. Used to build password-reset links and the
  // OAuth post-login redirect. Defaults to the first configured CORS origin.
  APP_URL: (process.env.APP_URL ?? (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",")[0]).trim().replace(/\/$/, ""),
  // Public URL of THIS API service (for OAuth redirect_uri registration).
  API_URL: (process.env.API_URL ?? "http://localhost:4000").trim().replace(/\/$/, ""),
  PASSWORD_RESET_TTL_MINUTES: parseInt(process.env.PASSWORD_RESET_TTL_MINUTES ?? "60", 10),
  // OAuth / SSO providers. Each is inert until its client id + secret are set.
  // Google + Microsoft creds are shared between sign-in and their integration
  // features (Gmail/Calendar/Drive, Outlook/Calendar/OneDrive).
  OAUTH: {
    GOOGLE: { CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "", CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "" },
    MICROSOFT: {
      CLIENT_ID: process.env.MICROSOFT_CLIENT_ID ?? "",
      CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET ?? "",
      // Directory (tenant) id, or "common" for multi-tenant + personal accounts.
      TENANT: process.env.MICROSOFT_TENANT ?? "common",
    },
    // Integration-only OAuth apps (each inert until its client id + secret are set).
    DROPBOX: { CLIENT_ID: process.env.DROPBOX_CLIENT_ID ?? "", CLIENT_SECRET: process.env.DROPBOX_CLIENT_SECRET ?? "" },
    BOX: { CLIENT_ID: process.env.BOX_CLIENT_ID ?? "", CLIENT_SECRET: process.env.BOX_CLIENT_SECRET ?? "" },
    QUICKBOOKS: { CLIENT_ID: process.env.QUICKBOOKS_CLIENT_ID ?? "", CLIENT_SECRET: process.env.QUICKBOOKS_CLIENT_SECRET ?? "" },
    XERO: { CLIENT_ID: process.env.XERO_CLIENT_ID ?? "", CLIENT_SECRET: process.env.XERO_CLIENT_SECRET ?? "" },
    SALESFORCE: { CLIENT_ID: process.env.SALESFORCE_CLIENT_ID ?? "", CLIENT_SECRET: process.env.SALESFORCE_CLIENT_SECRET ?? "" },
    OKTA: { CLIENT_ID: process.env.OKTA_CLIENT_ID ?? "", CLIENT_SECRET: process.env.OKTA_CLIENT_SECRET ?? "", DOMAIN: process.env.OKTA_DOMAIN ?? "" },
  },
  // Outbound email (SMTP). Feature is inert until HOST/USER/PASS are set.
  SMTP: {
    HOST: process.env.SMTP_HOST ?? "",
    PORT: parseInt(process.env.SMTP_PORT ?? "587", 10),
    USER: process.env.SMTP_USER ?? "",
    PASS: process.env.SMTP_PASS ?? "",
    // Envelope From (falls back to SMTP_USER). May include a display name.
    FROM: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "",
    SECURE: process.env.SMTP_SECURE === "true", // true for port 465
  },
  // Error monitoring. Inert until a DSN is set; enabled per-service.
  SENTRY: {
    DSN: process.env.SENTRY_DSN ?? "",
    TRACES_SAMPLE_RATE: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  },
};

export const isProd = env.NODE_ENV === "production";

/** Email sending is available only when SMTP is configured. */
export const emailConfigured = (): boolean => Boolean(env.SMTP.HOST && env.SMTP.USER && env.SMTP.PASS);

/**
 * Fail-closed check for secrets that MUST be real in production. Called at
 * boot (index.ts) so a misconfigured deploy crashes loudly instead of silently
 * signing sessions and encrypting credentials with a repo-public key.
 */
export function assertProductionSecrets(): void {
  if (!isProd) return;
  const problems: string[] = [];
  if (!env.JWT_SECRET || env.JWT_SECRET === INSECURE_JWT_DEFAULT || env.JWT_SECRET.length < 32) {
    problems.push("JWT_SECRET must be set to a random string of at least 32 characters.");
  }
  if (!env.INTEGRATION_SECRET_KEY || env.INTEGRATION_SECRET_KEY.length < 32) {
    problems.push("INTEGRATION_SECRET_KEY must be set to a random string of at least 32 characters (separate from JWT_SECRET).");
  }
  if (problems.length) {
    throw new Error(`Refusing to start in production with insecure configuration:\n  - ${problems.join("\n  - ")}`);
  }
}
