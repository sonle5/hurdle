#!/usr/bin/env node

import { spawn } from "node:child_process";

import {
  CLAUDE_CODE_VERSION,
  claudeCodeRuntimeInstallShell,
} from "../lib/claude-code-runtime.mjs";

if (process.argv.length > 2) {
  throw new Error("This installer accepts no arguments");
}

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn("bash", ["-lc", claudeCodeRuntimeInstallShell()], {
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Claude Code installer exited via ${signal}`));
    else resolve(code ?? 1);
  });
});

if (exitCode !== 0) process.exit(exitCode);
process.stdout.write(`Pinned Claude Code ${CLAUDE_CODE_VERSION} is ready.\n`);
