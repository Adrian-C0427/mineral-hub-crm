/**
 * Failure/attention notifications for the unattended monthly run. Prefers email
 * (reusing the app's existing SMTP transport) when INGEST_ALERT_EMAIL is set and
 * SMTP is configured; otherwise reports to Sentry; always logs to stderr so a
 * cron capture never loses the signal.
 */
import * as Sentry from "@sentry/node";
import { emailConfigured } from "../config.js";
import { sendEmail } from "../services/email.js";
import { ingestConfig } from "./config.js";
import type { DatasetResult } from "./runLog.js";

export async function sendIngestAlert(subject: string, html: string): Promise<void> {
  const to = ingestConfig.alertEmail;
  if (to && emailConfigured()) {
    try {
      await sendEmail({ to, subject: `[RRC ingest] ${subject}`, html });
      return;
    } catch (e) {
      console.error("ingest alert email failed; falling back to Sentry:", e);
    }
  }
  try {
    Sentry.captureMessage(`[RRC ingest] ${subject}`, "error");
  } catch {
    /* Sentry not initialised in this context */
  }
  console.error(`[RRC ingest] ${subject}`);
}

/** Build a compact HTML summary of a run for the alert email. */
export function renderRunSummary(runId: string, status: string, datasets: DatasetResult[]): string {
  const rows = datasets
    .map(
      (d) =>
        `<tr><td>${d.name}</td><td>${d.status}</td>` +
        `<td style="text-align:right">${d.inserted ?? 0}</td>` +
        `<td style="text-align:right">${d.updated ?? 0}</td>` +
        `<td style="text-align:right">${d.skipped ?? 0}</td>` +
        `<td>${d.error ?? ""}</td></tr>`,
    )
    .join("");
  return (
    `<p>Run <code>${runId}</code> finished with status <strong>${status}</strong>.</p>` +
    `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font:13px sans-serif">` +
    `<thead><tr><th>Dataset</th><th>Status</th><th>Inserted</th><th>Updated</th><th>Skipped</th><th>Error</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}
