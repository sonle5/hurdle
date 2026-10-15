import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// Some editors save UTF-8 with a byte order mark, which would otherwise become
// part of the first variable name and hide that credential.
export function parseProjectEnvironment(source) {
  return parseEnv(source.replace(/^\uFEFF/, ""));
}

export function loadProjectEnvironment(cwd, inherited = process.env) {
  const path = resolve(cwd, ".env.local");
  if (!existsSync(path)) {
    return Object.freeze({ environment: { ...inherited }, source: "shell environment" });
  }
  const local = parseProjectEnvironment(readFileSync(path, "utf8"));
  return Object.freeze({
    environment: Object.fromEntries([
      ...Object.entries(inherited),
      ...Object.entries(local),
    ]),
    source: ".env.local (configured values override the shell)",
  });
}
