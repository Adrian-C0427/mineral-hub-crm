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

/** Longest submitter-influenced string worth pushing; the app holds the full text. */
const MAX_TITLE = 200;
const MAX_BODY = 600;

/**
 * Make a string safe to place in an Adaptive Card TextBlock.
 *
 * TextBlock renders a markdown subset, so any text reaching this function is
 * markup, not a literal. Some of it originates from UNAUTHENTICATED buyer-portal
 * submissions (portal.ts lead and offer capture), which means an attacker could
 * otherwise author content inside the org's own trusted Teams channel.
 *
 * Two separate problems, because escaping alone does not solve this:
 *  1. Markdown syntax — `[label](url)` builds a hyperlink. Backslash-escaping
 *     the CommonMark punctuation set renders it as literal text instead.
 *  2. Bare URLs — Teams autolinks `https://…` even with no markdown at all, so
 *     escaping cannot stop it. Nothing legitimately pushed here contains a URL
 *     (the card's one real link is the Action.OpenUrl back into the app), so a
 *     scheme is simply removed.
 */
export function cardSafeText(s: string, max: number): string {
  const noSchemes = s.replace(/\b[a-z][a-z0-9+.-]*:\/\//gi, "").replace(/\bdata:/gi, "").replace(/\bjavascript:/gi, "");
  const escaped = noSchemes.replace(/[\\`*_{}[\]()#+\-.!|>~]/g, (c) => `\\${c}`);
  // Truncate on the ESCAPED string, so the cap bounds what is actually sent
  // rather than what came in (escaping can more than double the length).
  if (escaped.length <= max) return escaped;
  const cut = escaped.slice(0, max);
  // The cut can land mid-escape-pair, leaving a dangling backslash that would
  // escape the ellipsis and re-arm whatever follows. Only an ODD run of trailing
  // backslashes is dangling — an even run is a complete pair (a literal `\` is
  // itself escaped to `\\`), so blindly dropping one would CREATE the problem.
  const trailingSlashes = (/\\*$/.exec(cut)?.[0] ?? "").length;
  return `${trailingSlashes % 2 === 1 ? cut.slice(0, -1) : cut}…`;
}

function card(p: PushPayload) {
  const bodyBlocks: Record<string, unknown>[] = [
    { type: "TextBlock", text: cardSafeText(p.title, MAX_TITLE), weight: "Bolder", size: "Medium", wrap: true },
  ];
  if (p.body) bodyBlocks.push({ type: "TextBlock", text: cardSafeText(p.body, MAX_BODY), wrap: true, spacing: "Small" });
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
