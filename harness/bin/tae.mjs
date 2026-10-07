#!/usr/bin/env node

// Compatibility entry point for existing scripts and imports.
export * from "./hurdle.mjs";
import { main } from "./hurdle.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { terminalStatus } from "../lib/terminal-output.mjs";

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    process.stderr.write(terminalStatus("fail", "hurdle [internal-error] An unexpected internal error occurred.", process.stderr));
    process.exitCode = 70;
  }
}
