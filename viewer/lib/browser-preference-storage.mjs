/** Preserve existing Viewer preferences while writing only Hurdle names. */
export function readStoredPreference(storage, key) {
  const value = storage.getItem(key);
  if (value !== null) return value;
  const legacyKey = key.replace(/^hurdle-/, "tae-");
  if (legacyKey === key) return null;
  const legacyValue = storage.getItem(legacyKey);
  if (legacyValue !== null) {
    try { storage.setItem(key, legacyValue); } catch { /* Reads still work without writes. */ }
  }
  return legacyValue;
}
