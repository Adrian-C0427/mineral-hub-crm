/**
 * Content hashing for download change-detection. RRC republishes full snapshots
 * monthly, but many datasets are unchanged run-to-run; comparing a fresh
 * download's SHA-256 against the last successfully-imported file lets the
 * pipeline skip re-parsing and re-merging identical bytes.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** SHA-256 of an in-memory buffer/string (used in tests and small files). */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Streaming SHA-256 of a file on disk (safe for multi-GB inputs). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Whether `sha` differs from the most recent successfully-imported checksum for
 * this dataset. Unknown/absent prior ⇒ changed (first import). Kept as a thin
 * DB helper so the decision logic stays trivial to reason about.
 */
export async function isDatasetChanged(
  query: (sql: string, ...args: unknown[]) => Promise<{ sha256: string | null }[]>,
  dataset: string,
  sha: string,
): Promise<boolean> {
  const rows = await query(
    `SELECT sha256 FROM rrc.source_file
      WHERE dataset = $1 AND status = 'imported' AND sha256 IS NOT NULL
      ORDER BY downloaded_at DESC LIMIT 1`,
    dataset,
  );
  const last = rows[0]?.sha256 ?? null;
  return last !== sha;
}
