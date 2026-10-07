import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_PROJECT_RUNTIME = ".hurdle/runtime/default.json";
const LEGACY_PROJECT_RUNTIME = ".tae/runtime/default.json";

export function projectRuntimePath(cwd) {
  return [DEFAULT_PROJECT_RUNTIME, LEGACY_PROJECT_RUNTIME]
    .find(path => existsSync(resolve(cwd, path))) ?? null;
}

export function defaultLocalStoreRoot(cwd) {
  const current = resolve(cwd, ".hurdle/results-v1");
  const legacy = resolve(cwd, ".tae/results-v1");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}
