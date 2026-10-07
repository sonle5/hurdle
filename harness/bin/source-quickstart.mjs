#!/usr/bin/env node

import { spawn } from "node:child_process";

import { createTerminalProgress } from "../lib/terminal-progress.mjs";
import {
  projectQuickstartRunIssue,
  renderQuickstartHeader,
  runSourceQuickstart,
} from "../lib/source-quickstart.mjs";

const CAPTURE_MAX_BYTES = 256 * 1024;

function captureStream() {
  let value = "";
  return Object.freeze({
    write(chunk) {
      if (Buffer.byteLength(value) >= CAPTURE_MAX_BYTES) return;
      value += String(chunk);
      if (Buffer.byteLength(value) > CAPTURE_MAX_BYTES) {
        value = `${value.slice(0, CAPTURE_MAX_BYTES)}\n[output truncated]\n`;
      }
    },
    read() {
      return value;
    },
  });
}

function runCapturedProcess(command, args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.write(chunk));
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.once("error", (error) => resolvePromise({
      exitCode: 70,
      output: `${stderr.read()}${error.message}\n`,
    }));
    child.once("close", (code) => resolvePromise({
      exitCode: Number.isInteger(code) ? code : 70,
      output: `${stdout.read()}${stderr.read()}`,
    }));
  });
}

function npmInstallPlan(prefix) {
  const args = [
    "--prefix", prefix,
    "install",
    ...(prefix === "harness" ? ["--omit=optional"] : []),
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ];
  if (process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args,
  };
}

function durationSince(startedAt) {
  const milliseconds = Date.now() - startedAt;
  return milliseconds >= 1_000
    ? `${(milliseconds / 1_000).toFixed(1)}s`
    : `${milliseconds}ms`;
}

function writeFailureDetails(value) {
  const trimmed = value.trim();
  if (trimmed) process.stderr.write(`${trimmed}\n`);
}

const ANSI = Object.freeze({ cyan: "\u001b[36m", dim: "\u001b[2m", reset: "\u001b[0m" });

function fact(label, value, { accent = false, stream = process.stderr } = {}) {
  const useColor = stream.isTTY === true && !process.env.NO_COLOR;
  const key = label.padEnd(7);
  const paintedKey = useColor ? `${ANSI.dim}${key}${ANSI.reset}` : key;
  const paintedValue = useColor && accent ? `${ANSI.cyan}${value}${ANSI.reset}` : value;
  return `  ${paintedKey} ${paintedValue}\n`;
}

function writeRunIssue(value) {
  const issue = projectQuickstartRunIssue(value);
  process.stderr.write(`\n${fact("Task", issue.task)}${fact("Reason", issue.reason)}\n`);
}

const cwd = process.cwd();
const progress = createTerminalProgress({ stream: process.stderr });
const phaseStartedAt = new Map();
const viewerError = captureStream();
let preparationOutput = "";
let runOutput = "";
let runError = "";
let runExitCode = null;
let viewerReady = false;
let cliMain = null;

try {
  process.stderr.write(
    `\n${renderQuickstartHeader({
      isTTY: process.stderr.isTTY === true,
      useColor: process.stderr.isTTY === true && !process.env.NO_COLOR,
    })}\n\n`,
  );
  process.exitCode = await runSourceQuickstart({
    cwd,
    async prepareDependencies() {
      const env = {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_loglevel: "error",
        npm_config_update_notifier: "false",
      };
      const results = await Promise.all(["harness", "viewer"].map((prefix) => {
        const plan = npmInstallPlan(prefix);
        return runCapturedProcess(plan.command, plan.args, { cwd, env });
      }));
      const failed = results.find(({ exitCode }) => exitCode !== 0);
      preparationOutput = results.map(({ output }) => output).join("");
      return failed?.exitCode ?? 0;
    },
    onStatus(status) {
      if (status.state === "start") {
        phaseStartedAt.set(status.phase, Date.now());
        if (status.phase === "prepare") progress.start("Preparing local environment");
        if (status.phase === "run") progress.start("Running starter evaluation with Claude Code");
        if (status.phase === "view") progress.start("Starting Results Viewer");
        return;
      }
      const duration = durationSince(phaseStartedAt.get(status.phase) ?? Date.now());
      if (status.phase === "prepare") {
        if (status.exitCode === 0) progress.succeed("Environment ready", duration);
        else {
          progress.fail("Environment setup failed", duration);
          writeFailureDetails(preparationOutput);
        }
      }
      if (status.phase === "run") {
        runExitCode = status.exitCode;
        if (status.exitCode === 0) progress.succeed("Starter evaluation passed", duration);
        else if (status.exitCode === 1) progress.warn("Starter evaluation needs attention", duration);
        else if ([130, 143].includes(status.exitCode)) progress.warn("Starter evaluation stopped", duration);
        else progress.fail("Starter evaluation failed", duration);
        if (status.exitCode === 1) writeRunIssue(`${runError}${runOutput}`);
        else if (status.exitCode !== 0) writeFailureDetails(`${runError}${runOutput}`);
      }
      if (status.phase === "view") {
        if (viewerReady) progress.stop();
        else if ([130, 143].includes(status.exitCode)) progress.warn("Results Viewer stopped", duration);
        else if (status.exitCode === 0) progress.succeed("Results Viewer stopped", duration);
        else {
          progress.fail("Results Viewer failed to start", duration);
          writeFailureDetails(viewerError.read());
        }
      }
    },
    async runCli(argv) {
      cliMain ??= (await import("./tae.mjs")).main;
      if (argv[0] === "run") {
        const stdout = captureStream();
        const stderr = captureStream();
        const exitCode = await cliMain(argv, { cwd, stdout, stderr });
        runOutput = stdout.read();
        runError = stderr.read();
        return exitCode;
      }

      let pending = "";
      const stdout = {
        write(chunk) {
          pending += String(chunk);
          while (pending.includes("\n")) {
            const newline = pending.indexOf("\n");
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            const match = /^Viewer: (.+)$/.exec(line);
            if (!match) {
              if (line === "Press Ctrl+C to stop the Viewer") continue;
              process.stdout.write(`${line}\n`);
              continue;
            }
            viewerReady = true;
            progress.succeed(
              "Results Viewer ready",
              durationSince(phaseStartedAt.get("view") ?? Date.now()),
            );
            process.stdout.write(
              `\n${fact("Store", ".tae/results-v1", { stream: process.stdout })}`
              + `${fact("Viewer", match[1], { accent: true, stream: process.stdout })}\n`
              + "Press Ctrl+C to stop the Viewer\n",
            );
          }
        },
      };
      const stderr = {
        isTTY: false,
        write(chunk) {
          viewerError.write(chunk);
        },
      };
      return cliMain(argv, { cwd, stdout, stderr });
    },
  });
} catch (error) {
  progress.stop();
  process.stderr.write(
    "hurdle [quickstart-failed] The source quickstart could not be completed.\n",
  );
  if (error instanceof Error && error.message) {
    process.stderr.write(`${error.message}\n`);
  }
  process.exitCode = 70;
}
