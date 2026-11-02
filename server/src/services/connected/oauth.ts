/**
 * OAuth 2.0 for personal connected accounts: authorization code + PKCE (S256)
 * against the official Microsoft identity platform and Google endpoints.
 *
 *  - State is a short-lived JWT (own audience) carrying org, user, provider
 *    and the PKCE verifier — the verifier ENCRYPTED with the server key, since
 *    the state travels through the provider in a URL. It ties the callback to
 *    the member who started it; /oauth/complete also requires that same live
 *    session (routes/accounts.ts), so a planted link cannot attach someone
 *    else's mailbox to an account here.
 *  - The code is redeemed server-side with the client secret + verifier.
 *    Tokens never reach the browser.
 *  - Google: access_type=offline + prompt=consent (a refresh token every
 *    time) and include_granted_scopes (incremental authorization).
 *    Microsoft: offline_access; prompt=select_account so a member with
 *    several Microsoft accounts picks which one to connect.
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config.js";
import { decryptSecret, encryptSecret } from "../secrets.js";
import { ACCOUNT_PROVIDER_DEFS, oauthClient, type AccountProvider, type OAuthClient } from "./providers.js";

export interface TokenBundle {
  access_token: string;
  refresh_token?: string;
  /** epoch ms when the access token expires. */
  expires_at?: number;
  scope?: string;
}

export interface AccountState {
  orgId: string;
  userId: string;
  provider: AccountProvider;
  /** PKCE code verifier, sealed with encryptSecret. */
  pv: string;
  nonce: string;
}

/**
 * Its own audience: this token travels through provider URLs (logs, history,
 * Referer), so it must never verify as a session token or as the org-level
 * integration state (services/integrationOAuth.ts), and vice versa.
 */
export const ACCOUNT_STATE_AUDIENCE = "connected-account-state";

/** The callback the provider returns to — shared with the org-level flow. */
export function accountRedirectUri(provider: AccountProvider): string {
  return `${env.API_URL}/api/integrations/${provider}/oauth/callback`;
}

function client(provider: AccountProvider): OAuthClient {
  const c = oauthClient(ACCOUNT_PROVIDER_DEFS[provider].family);
  if (!c) throw new Error(`${ACCOUNT_PROVIDER_DEFS[provider].name} isn't configured on this server yet.`);
  return c;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48)); // 64 chars, within RFC 7636's 43–128
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function signAccountState(s: { orgId: string; userId: string; provider: AccountProvider; verifier: string }): string {
  const payload: AccountState = { orgId: s.orgId, userId: s.userId, provider: s.provider, pv: encryptSecret(s.verifier), nonce: crypto.randomUUID() };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "10m", audience: ACCOUNT_STATE_AUDIENCE });
}

export function verifyAccountState(token: string): AccountState & { verifier: string } {
  const s = jwt.verify(token, env.JWT_SECRET, { audience: ACCOUNT_STATE_AUDIENCE }) as AccountState;
  return { ...s, verifier: decryptSecret(s.pv) };
}

/** The provider sign-in URL for a member starting a connection. */
export function buildAccountAuthorizeUrl(provider: AccountProvider, orgId: string, userId: string): string {
  const def = ACCOUNT_PROVIDER_DEFS[provider];
  const c = client(provider);
  const { verifier, challenge } = pkcePair();
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: accountRedirectUri(provider),
    response_type: "code",
    scope: def.scopes.join(" "),
    state: signAccountState({ orgId, userId, provider, verifier }),
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(def.family === "google"
      ? { access_type: "offline", prompt: "consent", include_granted_scopes: "true" }
      : { prompt: "select_account", response_mode: "query" }),
  });
  return `${c.authorizeUrl}?${params.toString()}`;
}

/** OAuth error from the token endpoint (`error` is the RFC 6749 code). */
export class TokenError extends Error {
  constructor(message: string, readonly error: string | null, readonly status: number) { super(message); }
  /** The grant is dead (expired, revoked, password changed): only a reconnect helps. */
  get revoked(): boolean { return this.error === "invalid_grant" || this.error === "interaction_required" || this.error === "consent_required"; }
}

async function tokenRequest(provider: AccountProvider, body: Record<string, string>): Promise<TokenBundle> {
  const c = client(provider);
  let res: Response;
  try {
    res = await fetch(c.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...body }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new TokenError("Could not reach the sign-in service. Try again.", null, 0);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    // Only the RFC error code is surfaced — never the response body, which can
    // echo request details.
    const code = typeof json.error === "string" ? json.error : null;
    throw new TokenError(`Sign-in service returned ${res.status}${code ? ` (${code})` : ""}.`, code, res.status);
  }
  const expiresIn = Number(json.expires_in);
  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expires_at: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}

export function exchangeAccountCode(provider: AccountProvider, code: string, verifier: string): Promise<TokenBundle> {
  return tokenRequest(provider, { grant_type: "authorization_code", code, redirect_uri: accountRedirectUri(provider), code_verifier: verifier });
}

export async function refreshAccountTokens(provider: AccountProvider, refreshToken: string): Promise<TokenBundle> {
  const def = ACCOUNT_PROVIDER_DEFS[provider];
  // Microsoft's v2 refresh names the scopes again (the same set); Google's doesn't take one.
  const b = await tokenRequest(provider, {
    grant_type: "refresh_token", refresh_token: refreshToken,
    ...(def.family === "microsoft" ? { scope: def.scopes.join(" ") } : {}),
  });
  // Google keeps the same refresh token (it isn't re-sent); Microsoft rotates it.
  if (!b.refresh_token) b.refresh_token = refreshToken;
  return b;
}

/** Revoke a Google grant (best effort). Microsoft has no per-app revoke for delegated tokens. */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const sealTokens = (b: TokenBundle): string => encryptSecret(JSON.stringify(b));
export const openTokens = (sealed: string): TokenBundle => JSON.parse(decryptSecret(sealed)) as TokenBundle;

export interface AccountIdentity {
  providerAccountId: string;
  email: string | null;
  displayName: string | null;
}

/** Who signed in: the stable account id plus name and address, from the provider. */
export async function fetchIdentity(provider: AccountProvider, accessToken: string): Promise<AccountIdentity> {
  const family = ACCOUNT_PROVIDER_DEFS[provider].family;
  const url = family === "google"
    ? "https://openidconnect.googleapis.com/v1/userinfo"
    : "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName";
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Could not read the account's profile (HTTP ${res.status}).`);
  const j = (await res.json()) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  if (family === "google") {
    const sub = str(j.sub);
    if (!sub) throw new Error("Google did not return an account id.");
    return { providerAccountId: sub, email: str(j.email)?.toLowerCase() ?? null, displayName: str(j.name) };
  }
  const id = str(j.id);
  if (!id) throw new Error("Microsoft did not return an account id.");
  return { providerAccountId: id, email: (str(j.mail) ?? str(j.userPrincipalName))?.toLowerCase() ?? null, displayName: str(j.displayName) };
}
