/**
 * Personal connected accounts — the providers a team member can connect for
 * themselves (docs/integrations-outlook-drive.md):
 *
 *   outlook      their Outlook / Microsoft 365 mailbox (Microsoft Graph mail)
 *   onedrive     their OneDrive (Microsoft Graph files)
 *   googledrive  their Google Drive (Drive API v3)
 *
 * Each requests only what its features use:
 *   Outlook   Mail.ReadWrite (read, file, mark read, drafts) + Mail.Send
 *             (send as the mailbox). Not MailboxSettings, contacts or calendar.
 *   OneDrive  Files.ReadWrite — the user's OWN drive. Not Files.ReadWrite.All
 *             (every file shared with them) or Sites.* (SharePoint).
 *   Drive     drive — browse, rename, move and trash anything in the user's
 *             Drive, which narrower scopes (drive.file) cannot. Restricted by
 *             Google, so the OAuth app is set to Internal (Workspace users
 *             only), where no verification applies.
 * plus the sign-in identity scopes (openid / email / profile, User.Read) used
 * to name the account, and offline access for a refresh token.
 */
import type { Permission } from "../../domain/permissions.js";
import { env } from "../../config.js";

export const ACCOUNT_PROVIDERS = ["outlook", "onedrive", "googledrive"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export function isAccountProvider(key: string): key is AccountProvider {
  return (ACCOUNT_PROVIDERS as readonly string[]).includes(key);
}

export type ProviderFamily = "microsoft" | "google";

export interface AccountProviderDef {
  key: AccountProvider;
  name: string;
  family: ProviderFamily;
  /** Scopes requested at sign-in. */
  scopes: string[];
  /** Feature scopes that must actually be granted for the account to count as connected. */
  required: string[];
  /** CRM permission a member needs to connect and use the account. */
  permission: Permission;
  /** Plain-language names for granted scopes (Settings → Integrations). */
  scopeLabels: Record<string, string>;
}

const GRAPH = "https://graph.microsoft.com/";
const GOOGLE_DRIVE = "https://www.googleapis.com/auth/drive";

const MS_IDENTITY = ["openid", "profile", "email", "offline_access", `${GRAPH}User.Read`];
// Outlook and OneDrive share one Entra app registration, so Microsoft may
// report both connections' permissions on either token — each card lists
// only its own.
const OUTLOOK_LABELS: Record<string, string> = {
  "user.read": "Your name and email address",
  "mail.readwrite": "Read and organize your mail",
  "mail.send": "Send mail as you",
};
const ONEDRIVE_LABELS: Record<string, string> = {
  "user.read": "Your name and email address",
  "files.readwrite": "View and edit your OneDrive files",
};

export const ACCOUNT_PROVIDER_DEFS: Record<AccountProvider, AccountProviderDef> = {
  outlook: {
    key: "outlook", name: "Microsoft Outlook", family: "microsoft",
    scopes: [...MS_IDENTITY, `${GRAPH}Mail.ReadWrite`, `${GRAPH}Mail.Send`],
    required: ["mail.readwrite", "mail.send"],
    permission: "sendEmail",
    scopeLabels: OUTLOOK_LABELS,
  },
  onedrive: {
    key: "onedrive", name: "Microsoft OneDrive", family: "microsoft",
    scopes: [...MS_IDENTITY, `${GRAPH}Files.ReadWrite`],
    required: ["files.readwrite"],
    permission: "manageDocuments",
    scopeLabels: ONEDRIVE_LABELS,
  },
  googledrive: {
    key: "googledrive", name: "Google Drive", family: "google",
    scopes: ["openid", "email", "profile", GOOGLE_DRIVE],
    required: ["drive"],
    permission: "manageDocuments",
    scopeLabels: {
      email: "Your email address",
      profile: "Your name",
      drive: "View, organize and edit your Google Drive files",
    },
  },
};

/**
 * A granted scope in comparable form: lowercased, without the Graph or Google
 * resource prefix ("https://graph.microsoft.com/Mail.Send" → "mail.send",
 * "https://www.googleapis.com/auth/drive" → "drive",
 * "https://www.googleapis.com/auth/userinfo.email" → "email").
 */
export function normScope(scope: string): string {
  return scope.trim().toLowerCase()
    .replace(/^https:\/\/graph\.microsoft\.com\//, "")
    .replace(/^https:\/\/www\.googleapis\.com\/auth\/userinfo\./, "")
    .replace(/^https:\/\/www\.googleapis\.com\/auth\//, "");
}

/** The provider's space-separated `scope` string as normalized, de-duplicated scopes. */
export function grantedScopes(scope: string | null | undefined): string[] {
  return [...new Set((scope ?? "").split(/\s+/).filter(Boolean).map(normScope))];
}

/** Required feature scopes the grant is missing (empty = fully authorized). */
export function missingScopes(def: AccountProviderDef, granted: readonly string[]): string[] {
  const have = new Set(granted.map(normScope));
  return def.required.filter((s) => !have.has(s));
}

/** Plain-language list of what an account was granted, in a stable order. */
export function scopeLabels(def: AccountProviderDef, granted: readonly string[]): string[] {
  const have = new Set(granted.map(normScope));
  return Object.entries(def.scopeLabels).filter(([s]) => have.has(s)).map(([, label]) => label);
}

export interface OAuthClient {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

/** The provider family's OAuth client, or null while its credentials are unset. */
export function oauthClient(family: ProviderFamily): OAuthClient | null {
  if (family === "google") {
    const g = env.OAUTH.GOOGLE;
    if (!g.CLIENT_ID || !g.CLIENT_SECRET) return null;
    return {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: g.CLIENT_ID, clientSecret: g.CLIENT_SECRET,
    };
  }
  const m = env.OAUTH.MICROSOFT;
  if (!m.CLIENT_ID || !m.CLIENT_SECRET) return null;
  const tenant = encodeURIComponent(m.TENANT || "common");
  return {
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    clientId: m.CLIENT_ID, clientSecret: m.CLIENT_SECRET,
  };
}

export function accountProviderConfigured(key: AccountProvider): boolean {
  return oauthClient(ACCOUNT_PROVIDER_DEFS[key].family) !== null;
}
