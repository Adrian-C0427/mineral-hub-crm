/**
 * How a person's name reads everywhere a contact or seller is shown: first,
 * middle and last name in that order, blanks skipped ("Mary Ann Hernandez").
 * The middle name is optional and never required.
 */
export interface PersonNameParts {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
}

/** "Mary Ann Hernandez" — "" when no part is filled in. */
export function personName(p: PersonNameParts): string {
  return [p.firstName, p.middleName, p.lastName].map((v) => (v ?? "").trim()).filter(Boolean).join(" ");
}

/** A contact's display name: the person, else the entity it is filed under, else "". */
export function contactName(c: PersonNameParts & { entityName?: string | null }): string {
  return personName(c) || (c.entityName ?? "").trim();
}
