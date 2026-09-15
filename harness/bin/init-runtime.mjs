#!/usr/bin/env node

import { loadProjectEnvironment } from "../lib/project-environment.mjs";
import { initializeRuntime } from "../lib/runtime-init.mjs";

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write("Usage: npm run runtime:init -- <e2b|postgres|e2b-postgres> [--template NAME]\n");
  return 2;
}

function argumentsFrom(argv) {
  const [mode, ...options] = argv;
  if (!mode || !["e2b", "postgres", "e2b-postgres"].includes(mode)) return null;
  let template;
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] !== "--template" || !options[index + 1] || template) return null;
    template = options[index + 1];
    index += 1;
  }
  return { mode, template };
}

const selected = argumentsFrom(process.argv.slice(2));
if (!selected) {
  process.exitCode = usage();
} else {
  try {
    const usesE2b = selected.mode !== "postgres";
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
      });
      process.stdout.write(`\nCreated  ${created.relativePath}\n\n`);
      process.stdout.write("Next\n");
      process.stdout.write("  npm run preflight\n");
      if (created.usesPostgres) process.stdout.write("  npm run db:migrate\n");
      process.stdout.write(
        "  node harness/bin/tae.mjs run "
        + `evals/together/hybrid.suite.mjs --runtime ${created.relativePath} --view\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? "Runtime could not be created."}\n`);
    process.exitCode = error?.code === "runtime-exists" ? 1 : 70;
  }
}
