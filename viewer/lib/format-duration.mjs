// Run durations everywhere in the Viewer: 54s · 1m · 1m 5s · 18m 30s.
// Rounds to whole seconds; a negative value (a delta) formats its magnitude.
export function formatDuration(seconds) {
  const total = Math.round(Math.abs(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest}s`;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
