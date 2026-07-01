/**
 * Phone normalization — the single canonical stored form.
 *
 * Users may type any common format ("(903) 555-1234", "903.555.1234",
 * "+1 903 555 1234"). We store a consistent digits-only value so searching,
 * validation, and future integrations have one shape to rely on. Display
 * formatting to "(XXX) XXX-XXXX" happens in the client (client/src/lib/phone.ts).
 *
 * Rules:
 *  - Strip everything except digits.
 *  - Drop a US country code (leading "1" on an 11-digit number).
 *  - A 10-digit result is the canonical US form.
 *  - Anything else (too short, international, extension) is stored as its
 *    stripped digits rather than rejected — we normalize best-effort and never
 *    lose the user's number.
 */
export function normalizePhone(input: string | null | undefined): string {
  if (input == null) return "";
  let digits = String(input).replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

/** Zod-friendly optional transform: normalize, and turn empty into null. */
export function normalizePhoneNullable(input: string | null | undefined): string | null {
  const n = normalizePhone(input);
  return n.length ? n : null;
}
