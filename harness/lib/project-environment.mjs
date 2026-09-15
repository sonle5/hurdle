import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export function loadProjectEnvironment(cwd, inherited = process.env) {
  const path = resolve(cwd, ".env.local");
  if (!existsSync(path)) {
    return Object.freeze({ environment: { ...inherited }, source: "shell environment" });
  }
  const local = parseEnv(readFileSync(path, "utf8"));
  return Object.freeze({
    environment: Object.fromEntries([
      ...Object.entries(inherited),
      ...Object.entries(local),
    ]),
    source: ".env.local (configured values override the shell)",
  });
}
