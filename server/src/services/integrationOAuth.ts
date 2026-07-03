/**
 * Integration OAuth 2.0 — the token lifecycle for provider integrations that
 * act on the org's behalf (Gmail/Calendar/Drive, Outlook/Calendar/OneDrive,
 * Dropbox, Box, QuickBooks, Xero, Salesforce, Okta).
 *
 * Distinct from services/oauth.ts, which does OIDC *sign-in* (creates a user
 * session). This module stores a per-org access+refresh token bundle and keeps
 * it fresh, so downstream provider API calls just ask for a valid access token.
 *
 * Design:
 *  - A generic confidential-client authorization-code flow. Adding a provider =
 *    one registry entry (endpoints + scopes + which client creds it uses).
 *  - Google/Microsoft reuse the existing sign-in app registrations with extra
 *    scopes — no new app needed for their six features.
 *  - Tokens are stored encrypted (services/secrets.ts) inside the existing
 *    Integration.config._secret JSON — no schema change.
 *  - CSRF/org context travels in a short-lived signed state JWT, so the public
 *    callback needs no session cookie.
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Integration } from "@prisma/client";
import { env } from "../config.js";
import { prisma } from "../db.js";
import { encryptSecret, decryptSecret } from "./secrets.js";

export interface TokenBundle {
  access_token: string;
  refresh_token?: string;
  /** epoch ms when the access token expires (undefined = unknown/no expiry). */
  expires_at?: number;
  scope?: string;
  token_type?: string;
}

interface OAuthApp {
  key: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
  /** Extra params on the authorize request (e.g. access_type=offline). */
  authorizeParams?: Record<string, string>;
}

const G = env.OAUTH.GOOGLE;
const M = env.OAUTH.MICROSOFT;
const msTenant = env.OAUTH.MICROSOFT.TENANT || "common";
const msAuthorize = `https://login.microsoftonline.com/${msTenant}/oauth2/v2.0/authorize`;
const msToken = `https://login.microsoftonline.com/${msTenant}/oauth2/v2.0/token`;

// Google needs access_type=offline + prompt=consent to reliably return a refresh
// token. Microsoft/Xero/QuickBooks/Okta get one via the offline_access scope;
// Dropbox via token_access_type=offline; Salesforce via the refresh_token scope.
function google(key: string, scope: string): OAuthApp {
  return {
    key, authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token",
    scope: `openid email ${scope}`, clientId: G.CLIENT_ID, clientSecret: G.CLIENT_SECRET,
    authorizeParams: { access_type: "offline", prompt: "consent" },
  };
}
function microsoft(key: string, scope: string): OAuthApp {
  return {
    key, authorizeUrl: msAuthorize, tokenUrl: msToken,
    scope: `offline_access openid email ${scope}`, clientId: M.CLIENT_ID, clientSecret: M.CLIENT_SECRET,
  };
}

function buildRegistry(): Record<string, OAuthApp> {
  const okta = env.OAUTH.OKTA;
  const reg: Record<string, OAuthApp> = {
    gmail: google("gmail", "https://www.googleapis.com/auth/gmail.send"),
    googlecalendar: google("googlecalendar", "https://www.googleapis.com/auth/calendar.events"),
    googledrive: google("googledrive", "https://www.googleapis.com/auth/drive.file"),
    outlook: microsoft("outlook", "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read"),
    outlookcalendar: microsoft("outlookcalendar", "https://graph.microsoft.com/Calendars.ReadWrite"),
    onedrive: microsoft("onedrive", "https://graph.microsoft.com/Files.ReadWrite"),
    dropbox: {
      key: "dropbox", authorizeUrl: "https://www.dropbox.com/oauth2/authorize", tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      scope: "files.content.read files.content.write", clientId: env.OAUTH.DROPBOX.CLIENT_ID, clientSecret: env.OAUTH.DROPBOX.CLIENT_SECRET,
      authorizeParams: { token_access_type: "offline" },
    },
    box: {
      key: "box", authorizeUrl: "https://account.box.com/api/oauth2/authorize", tokenUrl: "https://api.box.com/oauth2/token",
      scope: "root_readwrite", clientId: env.OAUTH.BOX.CLIENT_ID, clientSecret: env.OAUTH.BOX.CLIENT_SECRET,
    },
    quickbooks: {
      key: "quickbooks", authorizeUrl: "https://appcenter.intuit.com/connect/oauth2", tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      scope: "com.intuit.quickbooks.accounting", clientId: env.OAUTH.QUICKBOOKS.CLIENT_ID, clientSecret: env.OAUTH.QUICKBOOKS.CLIENT_SECRET,
    },
    xero: {
      key: "xero", authorizeUrl: "https://login.xero.com/identity/connect/authorize", tokenUrl: "https://identity.xero.com/connect/token",
      scope: "offline_access accounting.transactions accounting.contacts", clientId: env.OAUTH.XERO.CLIENT_ID, clientSecret: env.OAUTH.XERO.CLIENT_SECRET,
    },
    salesforce: {
      key: "salesforce", authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize", tokenUrl: "https://login.salesforce.com/services/oauth2/token",
      scope: "api refresh_token", clientId: env.OAUTH.SALESFORCE.CLIENT_ID, clientSecret: env.OAUTH.SALESFORCE.CLIENT_SECRET,
    },
  };
  if (okta.DOMAIN) {
    reg.okta = {
      key: "okta", authorizeUrl: `https://${okta.DOMAIN}/oauth2/v1/authorize`, tokenUrl: `https://${okta.DOMAIN}/oauth2/v1/token`,
      scope: "openid profile email offline_access", clientId: okta.CLIENT_ID, clientSecret: okta.CLIENT_SECRET,
    };
  }
  return reg;
}

/** Provider keys that use the integration OAuth flow (regardless of config). */
export const OAUTH_PROVIDER_KEYS = [
  "gmail", "googlecalendar", "googledrive", "outlook", "outlookcalendar", "onedrive",
  "dropbox", "box", "quickbooks", "xero", "salesforce", "okta",
] as const;

export function isOAuthProvider(key: string): boolean {
  return (OAUTH_PROVIDER_KEYS as readonly string[]).includes(key);
}

function app(key: string): OAuthApp | null {
  const a = buildRegistry()[key];
  if (!a || !a.clientId || !a.clientSecret) return null; // inert until configured
  return a;
}

/** True when the provider's client id + secret (and Okta domain) are set. */
export function oauthConfigured(key: string): boolean {
  return app(key) !== null;
}

export function integrationRedirectUri(key: string): string {
  return `${env.API_URL}/api/integrations/${key}/oauth/callback`;
}

// --- State (CSRF + org context), signed, 10-minute TTL --------------------

interface OAuthState { orgId: string; userId: string; provider: string; nonce: string }

export function signState(s: Omit<OAuthState, "nonce">): string {
  return jwt.sign({ ...s, nonce: crypto.randomUUID() }, env.JWT_SECRET, { expiresIn: "10m" });
}
export function verifyState(token: string): OAuthState {
  return jwt.verify(token, env.JWT_SECRET) as OAuthState;
}

/** Authorization URL the browser is sent to. Throws if the provider is unconfigured. */
export function buildAuthorizeUrl(key: string, state: string): string {
  const a = app(key);
  if (!a) throw new Error(`${key} OAuth is not configured on this server.`);
  const params = new URLSearchParams({
    client_id: a.clientId,
    redirect_uri: integrationRedirectUri(key),
    response_type: "code",
    scope: a.scope,
    state,
    ...(a.authorizeParams ?? {}),
  });
  return `${a.authorizeUrl}?${params.toString()}`;
}

function toBundle(json: Record<string, unknown>): TokenBundle {
  const access = json.access_token as string | undefined;
  if (!access) throw new Error("Provider did not return an access token.");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in);
  return {
    access_token: access,
    refresh_token: (json.refresh_token as string) || undefined,
    expires_at: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
    scope: (json.scope as string) || undefined,
    token_type: (json.token_type as string) || undefined,
  };
}

async function tokenRequest(a: OAuthApp, body: Record<string, string>): Promise<TokenBundle> {
  const res = await fetch(a.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: a.clientId, client_secret: a.clientSecret, ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Token endpoint returned ${res.status}${json.error ? `: ${json.error}` : ""}`);
  return toBundle(json);
}

/** Exchange an authorization code for the initial token bundle. */
export function exchangeCode(key: string, code: string): Promise<TokenBundle> {
  const a = app(key);
  if (!a) throw new Error(`${key} OAuth is not configured.`);
  return tokenRequest(a, { grant_type: "authorization_code", code, redirect_uri: integrationRedirectUri(key) });
}

async function refreshTokens(a: OAuthApp, refreshToken: string): Promise<TokenBundle> {
  const b = await tokenRequest(a, { grant_type: "refresh_token", refresh_token: refreshToken });
  // Some providers don't re-send the refresh token; keep the existing one.
  if (!b.refresh_token) b.refresh_token = refreshToken;
  return b;
}

const REFRESH_MARGIN_MS = 60_000;

/**
 * Return a valid access token for a connected OAuth integration, refreshing and
 * persisting the bundle if it is within the refresh margin of expiry. Throws if
 * the integration has no stored bundle or the refresh fails.
 */
export async function getFreshAccessToken(row: Integration): Promise<string> {
  const a = app(row.provider);
  if (!a) throw new Error(`${row.provider} OAuth is not configured.`);
  const cfg = (row.config ?? {}) as { _secret?: string };
  if (!cfg._secret) throw new Error("No OAuth tokens stored. Reconnect this integration.");
  const bundle = JSON.parse(decryptSecret(cfg._secret)) as TokenBundle;

  const expiring = bundle.expires_at != null && bundle.expires_at - Date.now() < REFRESH_MARGIN_MS;
  if (!expiring) return bundle.access_token;

  if (!bundle.refresh_token) throw new Error("Access token expired and no refresh token is available. Reconnect this integration.");
  const refreshed = await refreshTokens(a, bundle.refresh_token);
  await persistBundle(row, refreshed);
  return refreshed.access_token;
}

/** Encrypt + store a token bundle on the integration row (preserving non-secret config). */
export async function persistBundle(row: Integration, bundle: TokenBundle): Promise<void> {
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const nonSecret = Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith("_")));
  await prisma.integration.update({
    where: { id: row.id },
    data: { config: { ...nonSecret, _secret: encryptSecret(JSON.stringify(bundle)), _hint: "OAuth" } as never },
  });
}
