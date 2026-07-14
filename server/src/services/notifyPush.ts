/**
 * External notification push — mirrors in-app notifications to the org's
 * connected Microsoft Teams channel (Power Automate Workflows webhook).
 *
 * Fire-and-forget by design: called with `void pushTeams(...)` right after a
 * Notification row is created. A Teams outage must never fail or slow the
 * request that raised the notification, so every failure is swallowed into a
 * console line and the integration's lastError.
 */
import { prisma } from "../db.js";
import { decryptSecret } from "./secrets.js";
import { env } from "../config.js";

export interface PushPayload {
  title: string;
  body?: string | null;
  /** App-relative link, e.g. /deals/abc123. */
  link?: string | null;
}

function card(p: PushPayload) {
  const bodyBlocks: Record<string, unknown>[] = [
    { type: "TextBlock", text: p.title, weight: "Bolder", size: "Medium", wrap: true },
  ];
  if (p.body) bodyBlocks.push({ type: "TextBlock", text: p.body, wrap: true, spacing: "Small" });
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
        body: bodyBlocks,
        ...(p.link ? { actions: [{ type: "Action.OpenUrl", title: "Open in Mineral Hub", url: `${env.APP_URL}${p.link}` }] } : {}),
      },
    }],
  };
}

/**
 * Post one notification card to the org's Teams channel, if Teams is
 * connected. Never throws.
 */
export async function pushTeams(organizationId: string, payload: PushPayload): Promise<void> {
  try {
    const row = await prisma.integration.findUnique({
      where: { organizationId_provider: { organizationId, provider: "teams" } },
    });
    if (!row || row.status !== "CONNECTED") return;
    const cfg = (row.config ?? {}) as { _secret?: string };
    if (!cfg._secret) return;
    const url = decryptSecret(cfg._secret);

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(card(payload)),
        signal: ctl.signal,
      });
      if (!res.ok && res.status !== 202) {
        await prisma.integration.update({
          where: { id: row.id },
          data: { lastError: `Teams webhook returned HTTP ${res.status} on a notification push.` },
        });
      }
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    console.error("Teams notification push failed:", e instanceof Error ? e.message : e);
  }
}
