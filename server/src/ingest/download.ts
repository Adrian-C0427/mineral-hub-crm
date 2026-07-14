/**
 * Download layer: resolves a dataset's current RRC link, fetches it to the work
 * dir with retry + backoff, and verifies the result. HTTP (not browser
 * automation) is used deliberately — the RRC files are direct downloads, so
 * `fetch` is far more reliable and scriptable than driving a headless browser.
 */
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { ingestConfig } from "./config.js";
import { sha256File } from "./checksum.js";
import type { DatasetSpec } from "./manifest.js";

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
  url: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve the live download URL for a dataset. Sets with a stable permanent
 * link use it directly; the rest are resolved by fetching the RRC catalog page
 * and matching the dataset's exact anchor text to its href (the links rotate,
 * so we never hard-code them).
 */
export async function resolveUrl(spec: DatasetSpec): Promise<string> {
  if (spec.directUrl) return spec.directUrl;
  if (!spec.pageLinkText) throw new Error(`No directUrl or pageLinkText for dataset ${spec.id}`);
  const res = await fetch(ingestConfig.catalogUrl);
  if (!res.ok) throw new Error(`Catalog fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const url = findLinkHref(html, spec.pageLinkText);
  if (!url) throw new Error(`Could not resolve link for "${spec.name}" (anchor "${spec.pageLinkText}")`);
  return url.startsWith("http") ? url : new URL(url, ingestConfig.catalogUrl).toString();
}

/** Find the href of the first anchor whose visible text contains `linkText`. */
export function findLinkHref(html: string, linkText: string): string | null {
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const needle = linkText.toLowerCase().replace(/\s+/g, " ").trim();
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (text.includes(needle)) return m[1];
  }
  return null;
}

/** Fetch `url` to `destPath` with retry/backoff; verify a minimum size. */
export async function downloadWithRetry(url: string, destPath: string): Promise<DownloadResult> {
  await mkdir(path.dirname(destPath), { recursive: true });
  const { maxRetries, retryBaseMs, minBytes } = ingestConfig;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const webStream = res.body as unknown as import("node:stream/web").ReadableStream;
      await pipeline(Readable.fromWeb(webStream), createWriteStream(destPath));
      const { size } = await stat(destPath);
      if (size < minBytes) throw new Error(`Downloaded ${size} bytes (< min ${minBytes}); treating as failed`);
      const sha256 = await sha256File(destPath);
      return { path: destPath, bytes: size, sha256, url };
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) await sleep(retryBaseMs * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Download failed after ${maxRetries} attempts (${url}): ${String(lastErr)}`);
}
