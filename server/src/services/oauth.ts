/**
 * OAuth 2.0 / OpenID Connect sign-in (Microsoft Entra ID).
 *
 * Google Sign-In was retired in the 2026-07 integration cut — the Google OAuth
 * client credentials remain in config solely for the Google Drive document
 * import integration.
 *
 * A small provider registry drives generic authorize → callback → userinfo
 * logic, so adding a provider is data, not code. Each provider is INERT until
 * its client id + secret are configured (mirrors the SMTP/S3 pattern): the
 * client only shows buttons for enabled providers, and the start/callback
 * routes 404 for the rest.
 *
 * Uses Node's global fetch (Node 20+) — no external dependency.
 */
import { env } from "../config.js";

export interface OAuthProfile {
  providerAccountId: string; // stable subject id
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export interface OAuthProvider {
  key: string;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
  /** Map the provider's userinfo JSON to our normalized profile. */
  parseProfile: (userinfo: Record<string, unknown>) => OAuthProfile;
}

function microsoftProvider(): OAuthProvider {
  const tenant = env.OAUTH.MICROSOFT.TENANT || "common";
  return {
    key: "microsoft",
    label: "Microsoft",
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    userInfoUrl: "https://graph.microsoft.com/oidc/userinfo",
    scope: "openid email profile",
    clientId: env.OAUTH.MICROSOFT.CLIENT_ID,
    clientSecret: env.OAUTH.MICROSOFT.CLIENT_SECRET,
    parseProfile: (u) => ({
      providerAccountId: String(u.sub),
      // Microsoft may return the address under email or upn.
      email:
        typeof u.email === "string" ? u.email.toLowerCase()
        : typeof u.preferred_username === "string" ? u.preferred_username.toLowerCase()
        : null,
      emailVerified: true, // Entra ID accounts are provider-verified
      name: typeof u.name === "string" ? u.name : null,
    }),
  };
}

const ALL = [microsoftProvider];

export function getProvider(key: string): OAuthProvider | null {
  const p = ALL.map((f) => f()).find((x) => x.key === key);
  if (!p || !p.clientId || !p.clientSecret) return null; // inert until configured
  return p;
}

/** Providers with credentials configured (for the client's button list). */
export function enabledProviders(): { key: string; label: string }[] {
  return ALL.map((f) => f()).filter((p) => p.clientId && p.clientSecret).map((p) => ({ key: p.key, label: p.label }));
}

export function redirectUri(providerKey: string): string {
  return `${env.API_URL}/api/auth/oauth/${providerKey}/callback`;
}

export function buildAuthorizeUrl(provider: OAuthProvider, state: string): string {
  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: redirectUri(provider.key),
    response_type: "code",
    scope: provider.scope,
    state,
    access_type: "offline",
    prompt: "select_account",
  });
  return `${provider.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCode(provider: OAuthProvider, code: string): Promise<string> {
  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(provider.key),
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("No access token returned");
  return json.access_token;
}

export async function fetchProfile(provider: OAuthProvider, accessToken: string): Promise<OAuthProfile> {
  const res = await fetch(provider.userInfoUrl, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Userinfo request failed (${res.status})`);
  const profile = provider.parseProfile((await res.json()) as Record<string, unknown>);
  if (!profile.providerAccountId) throw new Error("Provider did not return an account id");
  return profile;
}
