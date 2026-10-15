#!/usr/bin/env node

// Compatibility entry point for existing scripts and imports.
export * from "./hurdle.mjs";
import { main } from "./hurdle.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { terminalStatus } from "../lib/terminal-output.mjs";

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Output is best-effort once a terminal or pipe closes; a failed write must
  // not abort cancellation, sandbox cleanup or Result Store settlement.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    process.stderr.write(terminalStatus("fail", "hurdle [internal-error] An unexpected internal error occurred.", process.stderr));
    process.exitCode = 70;
  }
}
