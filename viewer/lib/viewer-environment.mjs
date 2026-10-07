/** Canonical Hurdle settings take precedence, including explicitly blank values. */
export function readViewerEnvironment(env, key) {
  return Object.hasOwn(env, key) ? env[key] : env[key.replace(/^HURDLE_/, "TAE_")];
}
