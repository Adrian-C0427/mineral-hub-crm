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
import jwt from "jsonwebtoken";
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
  /** Map the provider's userinfo JSON (+ ID token claims) to our normalized profile. */
  parseProfile: (userinfo: Record<string, unknown>, idClaims: Record<string, unknown>) => OAuthProfile;
}

/** Authority aliases that accept accounts from ANY Entra tenant (or MSA). */
const MULTI_TENANT_AUTHORITIES = new Set(["common", "organizations", "consumers"]);

function microsoftProvider(): OAuthProvider {
  const tenant = env.OAUTH.MICROSOFT.TENANT || "common";
  // Pinned to one tenant: only that directory's admins can mint accounts that
  // reach us, and a UPN's suffix must be one of its verified domains.
  const tenantPinned = !MULTI_TENANT_AUTHORITIES.has(tenant.toLowerCase());
  return {
    key: "microsoft",
    label: "Microsoft",
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    userInfoUrl: "https://graph.microsoft.com/oidc/userinfo",
    scope: "openid email profile",
    clientId: env.OAUTH.MICROSOFT.CLIENT_ID,
    clientSecret: env.OAUTH.MICROSOFT.CLIENT_SECRET,
    parseProfile: (u, id) => {
      // Entra's `email` claim is a MUTABLE, UNVERIFIED directory attribute:
      // under the multi-tenant authority, anyone can stand up their own tenant,
      // set a user's email to victim@yourco.com, and Microsoft will hand it to
      // us. Treating that as verified let the callback auto-link the attacker's
      // Microsoft login to the victim's existing account (full takeover).
      // Only trust the address when Microsoft vouches for it (the `xms_edov`
      // optional claim — "email domain owner verified") or when sign-in is
      // pinned to our own tenant. `preferred_username` is only a fallback in the
      // pinned case, where its domain must be verified in that tenant.
      const str = (v: unknown) => (typeof v === "string" && v ? v.toLowerCase() : null);
      const email = str(u.email) ?? str(id.email) ?? (tenantPinned ? str(id.preferred_username) ?? str(u.preferred_username) : null);
      const edov = id.xms_edov ?? u.xms_edov;
      return {
        providerAccountId: String(u.sub),
        email,
        emailVerified: tenantPinned || edov === true || edov === "true" || edov === 1 || edov === "1",
        name: typeof u.name === "string" ? u.name : null,
      };
    },
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

export interface CodeExchange {
  accessToken: string;
  /** ID token claims. Received directly from the token endpoint over TLS in the
   *  authorization-code flow, so the TLS channel authenticates the issuer
   *  (OIDC Core §3.1.3.7) — decoded, not signature-verified. */
  idClaims: Record<string, unknown>;
}

export async function exchangeCode(provider: OAuthProvider, code: string): Promise<CodeExchange> {
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
  const json = (await res.json()) as { access_token?: string; id_token?: string };
  if (!json.access_token) throw new Error("No access token returned");
  const decoded = json.id_token ? jwt.decode(json.id_token) : null;
  const idClaims = decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : {};
  return { accessToken: json.access_token, idClaims };
}

export async function fetchProfile(
  provider: OAuthProvider,
  accessToken: string,
  idClaims: Record<string, unknown> = {},
): Promise<OAuthProfile> {
  const res = await fetch(provider.userInfoUrl, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Userinfo request failed (${res.status})`);
  const profile = provider.parseProfile((await res.json()) as Record<string, unknown>, idClaims);
  if (!profile.providerAccountId) throw new Error("Provider did not return an account id");
  return profile;
}
