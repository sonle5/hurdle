/** Preserve existing Viewer preferences while writing only Hurdle names. */
export function readStoredPreference(storage, key) {
  const value = storage.getItem(key);
  if (value !== null) return value;
  const previousKeys = {
    "hurdle-sidebar-width": ["hurdle-app-rail-width", "tae-app-rail-width", "hurdle-transcript-rail-width", "tae-transcript-rail-width"],
    "hurdle-sidebar-collapsed": ["hurdle-app-rail-collapsed", "tae-app-rail-collapsed"],
  };
  const candidates = previousKeys[key] ?? [key.replace(/^hurdle-/, "tae-")];
  for (const previousKey of candidates) {
    if (previousKey === key) continue;
    const previousValue = storage.getItem(previousKey);
    if (previousValue === null) continue;
    try { storage.setItem?.(key, previousValue); } catch { /* Reads still work without writes. */ }
    return previousValue;
  }
  return null;
}
