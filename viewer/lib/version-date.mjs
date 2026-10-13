export const UNVERSIONED_ID = "__tae_unversioned__";

const formatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** @param {string | null | undefined} start @param {string | null | undefined} [end] */
export function formatVersionDateRange(start, end = start) {
  const first = new Date(start ?? "");
  const last = new Date(end ?? "");
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return null;
  return first <= last ? formatter.formatRange(first, last) : formatter.formatRange(last, first);
}
