/**
 * The one projection of a User the API shows wherever a person appears
 * (owner, assignee, creator, uploader…): id, display name, the first and last
 * name the avatar's initials come from, and the saved avatar colour. Every
 * route selects `userRefSelect` and emits `userRef()` so the client's shared
 * avatar component always has the same data to work with.
 */
export const userRefSelect = { id: true, name: true, firstName: true, lastName: true, avatarColor: true } as const;

export interface UserRef {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  avatarColor: string | null;
}

export function userRef(u: { id: string; name: string; firstName?: string | null; lastName?: string | null; avatarColor?: string | null } | null | undefined): UserRef | null {
  return u ? { id: u.id, name: u.name, firstName: u.firstName ?? null, lastName: u.lastName ?? null, avatarColor: u.avatarColor ?? null } : null;
}
