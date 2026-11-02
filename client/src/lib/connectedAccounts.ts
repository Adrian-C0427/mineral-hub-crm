import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

/**
 * A team member's own Outlook / OneDrive / Google Drive connection
 * (server: routes/accounts.ts). The server never sends tokens — only what is
 * needed to show and manage the connection.
 */
export type AccountProvider = "outlook" | "onedrive" | "googledrive";

export interface ConnectedAccount {
  id: string;
  provider: AccountProvider;
  providerName: string;
  email: string | null;
  displayName: string | null;
  status: "CONNECTED" | "NEEDS_RECONNECT" | "DISCONNECTED";
  syncStatus: "IDLE" | "SYNCING" | "ERROR";
  lastSyncAt: string | null;
  lastSyncAttemptAt: string | null;
  lastError: string | null;
  permissions: string[];
  missingPermissions: string[];
  connectedAt: string;
  disconnectedAt: string | null;
  autoLinkEmail: boolean;
}

export interface AccountProviderInfo {
  key: AccountProvider;
  name: string;
  /** The server has the provider's app registration keys. */
  configured: boolean;
  /** The member's role allows it (Outlook: send email; drives: manage documents). */
  allowed: boolean;
  /** The old company-wide connection, still working until members connect their own. */
  legacyConnectedAt: string | null;
}

export interface AccountsPayload { providers: AccountProviderInfo[]; accounts: ConnectedAccount[] }

/** The member's providers and accounts, reloadable. */
export function useConnectedAccounts() {
  const [data, setData] = useState<AccountsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.get<AccountsPayload>("/accounts")
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load connected accounts"));
  }, []);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

/** Usable accounts for one provider (connected, with every permission). */
export function usableAccounts(accounts: readonly ConnectedAccount[] | undefined, provider: AccountProvider): ConnectedAccount[] {
  return (accounts ?? []).filter((a) => a.provider === provider && a.status === "CONNECTED");
}

/** Send the browser to the provider's sign-in for a new (or re-) connection. */
export async function startAccountConnect(provider: AccountProvider): Promise<void> {
  const { url } = await api.get<{ url: string }>(`/accounts/${provider}/oauth/start`);
  window.location.href = url;
}
