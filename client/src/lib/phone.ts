/**
 * Phone helpers (client).
 *
 * The API stores a canonical digits-only value (see server/src/domain/phone.ts).
 * We display it as the standard US format "(903) 555-1234" everywhere, while the
 * underlying stored value stays consistent for searching/validation.
 */

/** Strip to digits and drop a leading US country code. Canonical stored form. */
export function normalizePhone(input: string | null | undefined): string {
  if (input == null) return "";
  let digits = String(input).replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

/**
 * Format a stored value for display as "(XXX) XXX-XXXX".
 * Non-10-digit values (partial, international) are shown best-effort rather than
 * mangled: 7-digit → "XXX-XXXX"; otherwise the raw input is returned.
 */
export function formatPhone(value: string | null | undefined): string {
  if (value == null || value === "") return "";
  const d = normalizePhone(value);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return String(value);
}

/** Progressive formatting while typing — formats what's entered so far. */
export function formatPhoneAsYouType(input: string): string {
  const d = normalizePhone(input);
  if (d.length === 0) return "";
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
}
