#!/usr/bin/env node

import { loadProjectEnvironment } from "../lib/project-environment.mjs";
import { initializeRuntime } from "../lib/runtime-init.mjs";
import { terminalHeader, terminalStatus, terminalFact, terminalUsesColor, terminalNext } from "../lib/terminal-output.mjs";

function usage(message) {
  process.stderr.write(terminalStatus("fail", message ?? "Choose e2b, postgres, e2b-postgres, together, or together-postgres.", process.stderr));
  process.stderr.write("Usage: npm run runtime:init -- <e2b|postgres|e2b-postgres|together|together-postgres> [--template NAME | --snapshot ALIAS]\n");
  return 2;
}

function argumentsFrom(argv) {
  const [mode, ...options] = argv;
  if (!mode || !["e2b", "postgres", "e2b-postgres", "together", "together-postgres"].includes(mode)) return null;
  let template;
  let snapshot;
  for (let index = 0; index < options.length; index += 1) {
    if (!["--template", "--snapshot"].includes(options[index]) || !options[index + 1]) return null;
    if (options[index] === "--template") { if (template || !mode.startsWith("e2b")) return null; template = options[index + 1]; }
    else { if (snapshot || !mode.startsWith("together")) return null; snapshot = options[index + 1]; }
    index += 1;
  }
  return { mode, template, snapshot };
}

const selected = argumentsFrom(process.argv.slice(2));
if (!selected) {
  process.exitCode = usage();
} else {
  try {
    const usesE2b = selected.mode.startsWith("e2b");
    const template = selected.template ?? (
      usesE2b ? loadProjectEnvironment(process.cwd()).environment.E2B_TEMPLATE : undefined
    );
    if (usesE2b && !template?.trim()) {
      process.exitCode = usage(
        "E2B needs a caller-owned template containing Node 22 and Claude Code. "
        + "Pass --template NAME or set E2B_TEMPLATE in .env.local.",
      );
    } else {
      const created = await initializeRuntime({
        cwd: process.cwd(),
        mode: selected.mode,
        template,
        snapshot: selected.snapshot,
      });
      process.stdout.write(terminalHeader(process.stdout)
        + terminalStatus("pass", "Runtime created", process.stdout) + "\n"
        + terminalFact("Runtime", created.relativePath, { useColor: terminalUsesColor(process.stdout) })
        + terminalNext([
          "npm run preflight",
          ...(created.usesPostgres ? ["npm run db:migrate"] : []),
          `npm run hurdle -- run evals/together/hybrid.suite.mjs --runtime ${created.relativePath} --view`,
        ], process.stdout));
    }
  } catch (error) {
    process.stderr.write(terminalStatus("fail", error?.message ?? "Runtime could not be created.", process.stderr));
    process.exitCode = error?.code === "runtime-exists" ? 1 : 70;
  }
}
