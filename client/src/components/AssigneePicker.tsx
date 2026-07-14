import { useMemo } from "react";
import type { UserLite } from "../types";
import { SearchableMultiSelect } from "./SearchableMultiSelect";

/**
 * Multi-select for assigning team members to a record (deals, assets, buyers,
 * bulk actions). A thin wrapper over the app's standard SearchableMultiSelect
 * — same portaled menu, opening animation, keyboard model, chips, hover and
 * focus treatment as every other selector — operating on user ids (labels come
 * from the id→name map, so duplicate display names never collide).
 */
export function AssigneePicker({ users, value, onChange, placeholder = "Assign team members…" }: {
  users: UserLite[];
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
}) {
  const ids = useMemo(() => users.map((u) => u.id), [users]);
  const labels = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);
  return (
    <SearchableMultiSelect
      options={ids}
      labels={labels}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  );
}
