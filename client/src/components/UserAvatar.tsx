import type { ReactNode } from "react";
import { userAvatarColor, userInitials, type AvatarUser } from "../lib/avatarColor";
import type { SelectOption } from "./Select";

/**
 * THE user avatar — the one way a person (owner, assignee, creator, team
 * member) is drawn anywhere in the app: a round badge in their saved colour
 * (name-hash fallback) carrying the initials of their first and last name
 * ("Adrian Campos" → AC), with the name beside it when the layout has room.
 * Sizes are pixels; shape, typography and colour come from `.avatar` so every
 * table cell, card, dropdown option and profile header matches.
 */
export function UserAvatar({ user, size = 22, withName = false, nameClass, title, className = "" }: {
  user: AvatarUser | null | undefined;
  size?: number;
  /** Show the name beside the badge. */
  withName?: boolean;
  nameClass?: string;
  title?: string;
  className?: string;
}) {
  const name = user?.name ?? "";
  const badge = (
    <span className={`avatar ${withName ? "" : className}`} title={title ?? (withName ? undefined : name)} aria-hidden={withName || undefined}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)), background: userAvatarColor(user) }}>
      {userInitials(user)}
    </span>
  );
  if (!withName) return badge;
  return <span className={`user-chip ${className}`} title={title}>{badge}<span className={nameClass ?? "user-chip-name"}>{name}</span></span>;
}

/** "Adrian C." — first name + last initial, for tight table cells. */
export function shortUserName(u: AvatarUser | null | undefined): string {
  const first = (u?.firstName ?? "").trim();
  const last = (u?.lastName ?? "").trim();
  if (first && last) return `${first} ${last[0]!.toUpperCase()}.`;
  const parts = (u?.name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.` : parts[0] ?? "";
}

/** Dropdown options for a list of users, each with its avatar. */
export function userOptions(users: readonly AvatarUser[], opts: { hint?: (u: AvatarUser) => string | undefined } = {}): SelectOption[] {
  return users.map((u) => ({ value: u.id ?? u.name, label: u.name, hint: opts.hint?.(u), icon: <UserAvatar user={u} size={18} /> as ReactNode }));
}
