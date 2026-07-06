/**
 * Claude-powered assistance for deals — the first "action" feature built on the
 * integration framework. It uses the ORGANIZATION'S connected Claude key (stored
 * encrypted by the integrations hub), so cost and access stay with the org.
 *
 * Two capabilities: summarize a deal, and draft buyer outreach. Both build a
 * compact structured prompt from deal/buyer context and call the Anthropic API
 * via the official SDK. Model defaults to Claude Opus 4.8, overridable with
 * ANTHROPIC_MODEL (e.g. claude-sonnet-5 for lower cost).
 */
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db.js";
import { HttpError } from "../middleware/errors.js";
import { decryptSecret } from "./secrets.js";
import { money } from "../domain/format.js";

const num = (n: number) => n.toLocaleString("en-US");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

/** Resolve + decrypt the org's connected Claude API key, or a clear 4xx. */
async function orgClient(organizationId: string): Promise<Anthropic> {
  const row = await prisma.integration.findUnique({
    where: { organizationId_provider: { organizationId, provider: "claude" } },
  });
  if (!row || row.status === "NOT_CONNECTED") {
    throw new HttpError(400, "Claude isn't connected. Add your Anthropic API key in Settings → Integrations first.");
  }
  const cfg = (row.config ?? {}) as { _secret?: string };
  if (!cfg._secret) throw new HttpError(400, "Claude is missing its stored key. Reconnect it in Settings → Integrations.");
  let apiKey: string;
  try {
    apiKey = decryptSecret(cfg._secret);
  } catch {
    throw new HttpError(400, "Claude's stored key could not be read. Reconnect it in Settings → Integrations.");
  }
  return new Anthropic({ apiKey });
}

/** One Anthropic call → plain text, with provider errors mapped to clear messages. */
async function complete(client: Anthropic, system: string, user: string, maxTokens: number): Promise<string> {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new HttpError(502, "Claude returned an empty response. Try again.");
    return text;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.APIError) {
      if (e.status === 401) throw new HttpError(400, "Claude rejected the stored API key (401). Reconnect it in Settings → Integrations.");
      if (e.status === 429) throw new HttpError(429, "Claude is rate-limiting this key. Wait a moment and try again.");
      throw new HttpError(502, `Claude request failed (${e.status ?? "network"}). Try again.`);
    }
    throw new HttpError(502, "Claude request failed. Try again.");
  }
}

// --- Prompt construction (pure, unit-tested) --------------------------------

export interface DealContext {
  name: string; stage: string; recordType: string;
  state: string | null; states: string[]; counties: string[];
  operator: string | null; assetTypes: string[]; basins: string[]; formations: string[];
  acreageNma: number | null; nra: number | null;
  askPrice: number | null; ourPrice: number | null; estimatedClosingCosts: number | null;
  sellerNames: string[];
  selectedBuyer: { name: string } | null;
  dateUnderContract: string | Date | null; originalClosingDate: string | Date | null;
  findBuyerByDate: string | Date | null; finalClosingDate: string | Date | null;
  notes: string | null;
}

export interface BuyerContext {
  name: string; companyName: string; focus: string;
}

function line(label: string, value: unknown): string | null {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  return `- ${label}: ${Array.isArray(value) ? value.join(", ") : value}`;
}

/** Compact fact sheet the model reasons over (no invented data). */
export function dealFacts(d: DealContext): string {
  const geo = [...new Set([...(d.states ?? []), d.state].filter(Boolean))].join(", ");
  const dt = (v: string | Date | null) => (v ? new Date(v).toISOString().slice(0, 10) : null);
  return [
    line("Deal", d.name),
    line("Type", d.recordType === "OWNED_ASSET" ? "Owned mineral asset" : "Acquisition opportunity"),
    line("Stage", d.stage.replace(/_/g, " ").toLowerCase()),
    line("Geography", geo),
    line("Counties", d.counties),
    line("Operator", d.operator),
    line("Asset types", d.assetTypes),
    line("Basins", d.basins),
    line("Formations", d.formations),
    line("Net mineral acres (NMA)", d.acreageNma != null ? num(d.acreageNma) : null),
    line("Net royalty acres (NRA)", d.nra != null ? num(d.nra) : null),
    line("Our price (acquisition cost)", d.ourPrice != null ? money(d.ourPrice) : null),
    line("Ask price (to buyers)", d.askPrice != null ? money(d.askPrice) : null),
    line("Est. closing costs", d.estimatedClosingCosts != null ? money(d.estimatedClosingCosts) : null),
    line("Sellers", d.sellerNames),
    line("Selected buyer", d.selectedBuyer?.name ?? null),
    line("Date under contract", dt(d.dateUnderContract)),
    line("Find buyer by", dt(d.findBuyerByDate)),
    line("Original closing", dt(d.originalClosingDate)),
    line("Final closing", dt(d.finalClosingDate)),
    line("Notes", d.notes),
  ].filter(Boolean).join("\n");
}

const SUMMARY_SYSTEM =
  "You are an analyst at a mineral-rights wholesaling firm. Summarize deals for an internal audience of experienced landmen and acquisition managers. " +
  "Be concise and factual. Use ONLY the facts provided — never invent acreage, prices, operators, dates, or buyers. " +
  "If key economics are missing, say so plainly. No preamble; lead with the takeaway.";

const DRAFT_SYSTEM =
  "You draft buyer-outreach emails for a mineral-rights wholesaler. Write a professional, specific, and concise email a buyer would actually read. " +
  "Use ONLY the facts provided — never invent figures. Do not fabricate a price if none is given; instead invite the buyer to discuss terms. " +
  "Return only the email body (a short subject line on the first line prefixed 'Subject:', then the body). No commentary.";

export async function summarizeDeal(organizationId: string, deal: DealContext): Promise<string> {
  const client = await orgClient(organizationId);
  const user = `Summarize this deal in 4–6 sentences for an internal team. Cover what it is, where, the economics we know, the current stage, and the most important next step or gap.\n\nDEAL FACTS:\n${dealFacts(deal)}`;
  return complete(client, SUMMARY_SYSTEM, user, 700);
}

// --- Tract-description extraction -------------------------------------------

const TRACT_SYSTEM =
  "You are an expert land surveyor and title analyst reading legal land descriptions (initially Texas metes-and-bounds; other state formats may appear). " +
  "Extract the boundary calls and references into STRICT JSON. Do NOT compute coordinates, areas, or closure — extraction only. " +
  "Never invent calls, bearings, or distances that are not in the text. If something is ambiguous, incomplete, or conflicting, list it under ambiguities and lower your confidence. " +
  "Record every interpretive choice you make (e.g. reading an abbreviation, resolving 'same course as the previous call') under assumptions. " +
  "Return ONLY a JSON object — no markdown fences, no commentary — with this exact shape:\n" +
  `{"pobText": string|null, "calls": [{"raw": string, "curve": boolean, "bearing": {"ns":"N"|"S","deg":number,"min":number,"sec":number,"ew":"E"|"W"}|null, "distance": {"value":number,"unit":"feet"|"varas"|"chains"|"rods"|"meters"}|null, "note": string|null}], "refs": {"abstracts":["A-123"],"surveys":[string],"county":string|null,"statedAcres":number|null,"sections":[string],"blocks":[string],"lots":[string],"quarters":[string]}, "ambiguities": [{"text": string, "issue": string}], "assumptions": [string], "confidence": number}\n` +
  "Rules: calls appear in boundary-walk order. For a curve, use its long chord as bearing+distance and set curve=true (note the radius/arc in note); if no chord is given, set bearing/distance null and explain in note. " +
  "For 'continuing on the same course', repeat the prior bearing. pobText is the BEGINNING clause verbatim. confidence is 0–100 for the extraction as a whole.";

/**
 * Claude reads a legal description into structured calls/refs. The caller
 * turns this into geometry deterministically (domain/tractParser) — the model
 * never does coordinate math.
 */
export async function extractTractCalls(organizationId: string, text: string, state: string): Promise<unknown> {
  const client = await orgClient(organizationId);
  const user = `STATE: ${state.toUpperCase()}\n\nLEGAL DESCRIPTION:\n${text}`;
  const raw = await complete(client, TRACT_SYSTEM, user, 8000);
  // Tolerate stray fences or prose around the object.
  const jsonText = raw.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) throw new HttpError(502, "Claude returned an unreadable extraction. Try again.");
  try {
    return JSON.parse(jsonText.slice(start, end + 1)) as unknown;
  } catch {
    throw new HttpError(502, "Claude returned malformed JSON for this description. Try again.");
  }
}

export async function draftOutreach(
  organizationId: string,
  deal: DealContext,
  buyer: BuyerContext,
  instructions?: string,
): Promise<string> {
  const client = await orgClient(organizationId);
  const user = [
    `Draft an outreach email to a prospective buyer about this deal.`,
    `\nBUYER:\n- Name: ${buyer.name}\n- Company: ${buyer.companyName}${buyer.focus ? `\n- Focus / buy box: ${buyer.focus}` : ""}`,
    `\nDEAL FACTS:\n${dealFacts(deal)}`,
    instructions ? `\nEXTRA INSTRUCTIONS FROM THE SENDER:\n${instructions}` : "",
    `\nTailor it to the buyer's focus where the deal matches. Keep it under ~180 words.`,
  ].join("\n");
  return complete(client, DRAFT_SYSTEM, user, 900);
}
