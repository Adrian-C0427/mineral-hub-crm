/**
 * The Minerals filter's numbers for Settings → Integrations → HighLevel →
 * Configure: how many TEXTED people (at least one text sent to them — the
 * same people Reports' "Contacts texted" counts) each tag and pipeline
 * covers, and how a draft filter would split them into minerals / real estate
 * / not classified. Classification is domain/smsScope.ts classifyContact —
 * the same call the sync stores as HighLevelContact.line — over each
 * contact's tags and its live opportunities' pipelines, so a preview equals
 * the stored lines once the sync has recomputed them.
 */
import { prisma } from "../../db.js";
import { classifyContact, normalizeTag, suggestScope, type SmsScope } from "../../domain/smsScope.js";
import { readPipelines, readTags, effectiveScope, pricePerSegmentOf, type HlPipelineRef } from "./mapping.js";

export interface TextedPerson { tags: string[]; pipelineIds: string[] }

export interface LineCounts { texted: number; minerals: number; realEstate: number; unclassified: number }

/** Split texted people by business line under `scope` (pure). */
export function countLines(people: readonly TextedPerson[], scope: SmsScope): LineCounts {
  const out: LineCounts = { texted: people.length, minerals: 0, realEstate: 0, unclassified: 0 };
  for (const p of people) {
    const line = classifyContact(p.tags, p.pipelineIds, scope);
    if (line === "minerals") out.minerals++;
    else if (line === "real_estate") out.realEstate++;
    else out.unclassified++;
  }
  return out;
}

export interface ScopeTagOption { name: string; texted: number }
export interface ScopePipelineOption { id: string; name: string; texted: number }

/**
 * Every tag the filter can assign — HighLevel's tag list plus any tag found
 * on a texted contact (in case the list is stale) — and every pipeline, each
 * with its count of texted people. Most-used first (pure).
 */
export function scopeOptionsFrom(people: readonly TextedPerson[], hlTags: readonly string[], pipelines: readonly HlPipelineRef[]):
  { tags: ScopeTagOption[]; pipelines: ScopePipelineOption[] } {
  const names = new Map<string, string>();
  for (const t of hlTags) if (!names.has(normalizeTag(t))) names.set(normalizeTag(t), t);
  const tagCount = new Map<string, number>();
  const pipeCount = new Map<string, number>();
  for (const p of people) {
    for (const key of new Set(p.tags.map(normalizeTag))) {
      tagCount.set(key, (tagCount.get(key) ?? 0) + 1);
      if (!names.has(key)) names.set(key, p.tags.find((t) => normalizeTag(t) === key)!.trim());
    }
    for (const id of new Set(p.pipelineIds)) pipeCount.set(id, (pipeCount.get(id) ?? 0) + 1);
  }
  const tags = [...names].map(([key, name]) => ({ name, texted: tagCount.get(key) ?? 0 }))
    .sort((a, b) => b.texted - a.texted || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return {
    tags,
    pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, texted: pipeCount.get(p.id) ?? 0 })),
  };
}

/** Texted people with their tags and live opportunities' pipelines. */
export async function textedPeople(organizationId: string): Promise<TextedPerson[]> {
  const [contacts, opps] = await Promise.all([
    prisma.highLevelContact.findMany({ where: { organizationId, outboundTotal: { gt: 0 } }, select: { hlId: true, tags: true } }),
    prisma.highLevelOpportunity.findMany({ where: { organizationId, deletedInHl: false, hlContactId: { not: null } }, select: { hlContactId: true, pipelineId: true } }),
  ]);
  const pipelinesOf = new Map<string, string[]>();
  for (const o of opps) {
    const list = pipelinesOf.get(o.hlContactId!) ?? [];
    list.push(o.pipelineId);
    pipelinesOf.set(o.hlContactId!, list);
  }
  return contacts.map((c) => ({ tags: c.tags, pipelineIds: pipelinesOf.get(c.hlId) ?? [] }));
}

/** GET /api/integrations/highlevel/scope — what the Configure form needs. */
export async function scopeSettings(organizationId: string, config: unknown) {
  const people = await textedPeople(organizationId);
  const pipelines = readPipelines(config);
  const { scope, saved } = effectiveScope(config);
  return {
    saved,
    scope,
    suggested: suggestScope(readTags(config), pipelines),
    ...scopeOptionsFrom(people, readTags(config), pipelines),
    counts: countLines(people, scope),
    pricePerSegment: pricePerSegmentOf(config),
  };
}
