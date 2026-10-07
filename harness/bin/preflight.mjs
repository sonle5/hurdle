#!/usr/bin/env node

import { runCredentialPreflight } from "../lib/credential-preflight.mjs";
import { loadProjectEnvironment } from "../lib/project-environment.mjs";
const ANSI = Object.freeze({
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  reset: "\u001b[0m",
});

function paint(value, color) {
  return process.stdout.isTTY && !process.env.NO_COLOR
    ? `${ANSI[color]}${value}${ANSI.reset}`
    : value;
}

function writeResult({ provider, status, message }) {
  const symbols = { pass: ["✓", "green"], fail: ["✗", "red"], skip: ["–", "dim"] };
  const [symbol, color] = symbols[status];
  process.stdout.write(`${paint(symbol, color)} ${provider.padEnd(10)} ${message}\n`);
}

try {
  const { environment, source } = loadProjectEnvironment(process.cwd());
  process.stdout.write(`\n${paint("Hurdle preflight", "cyan")}\n\n`);
  process.stdout.write(`Source  ${source}\n`);
  process.stdout.write("Usage   Anthropic and Together make minimal billable requests; E2B and Postgres are read-only.\n\n");

  const results = await runCredentialPreflight(environment);
  for (const value of results) writeResult(value);

  const failures = results.filter(({ status }) => status === "fail").length;
  const checked = results.filter(({ status }) => status !== "skip").length;
  process.stdout.write("\n");
  if (failures > 0) {
    process.stdout.write(`${paint("Result", "red")}  ${failures} configured service${failures === 1 ? " needs" : "s need"} attention\n`);
    process.exitCode = 1;
  } else if (checked === 0) {
    process.stdout.write(`${paint("Result", "yellow")}  No configured credentials found\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${paint("Result", "green")}  ${checked} configured service${checked === 1 ? " is" : "s are"} ready\n`);
  }
} catch {
  process.stderr.write("hurdle [preflight-failed] Credential preflight could not start. Check that .env.local is valid.\n");
  process.exitCode = 70;
}
