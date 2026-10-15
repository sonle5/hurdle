import { formatVersionDateRange, UNVERSIONED_ID } from "./version-date.mjs";

function versionDate(option) {
  const value = option.runAt ?? option.createdAt ?? (/^\d{4}-\d{2}-\d{2}$/.test(option.id) ? option.id : null);
  return value ? formatVersionDateRange(value) : null;
}

// An experiment label is also its version id, so show it with the run date
// beneath. Other versions whose name only repeats an opaque id show the date.
export function versionOptionItem(option) {
  const name = option.name?.trim() || option.id || "";
  const date = versionDate(option);
  const hasReadableName = Boolean(name) && (name !== option.id || option.kind === "experiment");
  return {
    value: option.id,
    label: hasReadableName ? name : (date ?? "Date unavailable"),
    sub: hasReadableName && option.id !== UNVERSIONED_ID && name !== date ? date : null,
    description: option.description?.trim() || null,
  };
}
