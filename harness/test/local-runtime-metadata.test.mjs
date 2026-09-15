import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";
import { createLocalExecutionEnvironment } from "../lib/execution-environments/local.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

const scenarios = [
  { adapterId: "claude-code", name: "actual runner", probe: 'console.log("2.1.263 (Claude Code)");', expected: "2.1.263" },
  { adapterId: "codex", name: "actual runner", probe: 'console.log("codex-cli 0.123.0");', expected: "0.123.0" },
  { name: "unsupported probe", probe: 'console.error("unsupported option"); process.exit(1);', expected: null },
  { name: "malformed probe", probe: 'console.log("not a version");', expected: null },
  { name: "overflowing probe", probe: 'process.on("SIGTERM", () => process.exit(0)); console.log("2.1.263"); console.error("x".repeat(8_192)); setInterval(() => {}, 1_000); return;', expected: null },
  { name: "timed out probe", probe: 'process.on("SIGTERM", () => process.exit(0)); console.log("2.1.263"); setInterval(() => {}, 1_000); return;', expected: null },
  { name: "cancelled probe never starts the Agent", probe: 'process.on("SIGTERM", () => process.exit(0)); console.log("2.1.263"); setInterval(() => {}, 1_000); return;', cancel: true, expected: null },
  { name: "cancellation during fixture staging never starts the Agent", probe: 'console.log("2.1.263");', stageAbort: true, expected: null },
  { name: "denied process termination fails closed within a bound", probe: 'console.log("2.1.263"); setInterval(() => {}, 1_000); return;', denyKill: true, expected: null },
  { name: "missing observation overrides decoded metrics", probe: 'console.log("2.1.263");', observed: null, expected: null },
  { name: "malformed observation overrides decoded metrics", probe: 'console.log("2.1.263");', observed: { runner: { forged: true }, node: [], extra: "hidden" }, expected: null },
];
for (const scenario of scenarios) {
  const { adapterId = "claude-code", name, probe, expected } = scenario;
  test(`Local ${adapterId}: ${name} stays outside the scored transcript and protects pip`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "tae-runtime-metadata-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    cpSync(new URL("../../examples/copy-message/", import.meta.url), join(root, "evals"), { recursive: true });
    const suitePath = join(root, "evals/example.suite.mjs");
    writeFileSync(suitePath, readFileSync(suitePath, "utf8").replace('runner: "claude-code"', `runner: "${adapterId}"`));
    const suite = await resolveV1Suite({ suitePath });
    assert.equal(suite.ok, true, JSON.stringify(suite.diagnostics));
    t.after(() => suite.dispose());
    const command = join(root, "test-agent");
    const probeMarker = join(root, "probe-started");
    const agentMarker = join(root, "agent-started");
    writeFileSync(command, [
      "#!/usr/bin/env node",
      'const assert = require("node:assert/strict");',
      'const fs = require("node:fs");',
      'if (process.argv.includes("--version")) {',
      '  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);',
      '  assert.equal(process.env.CODEX_API_KEY, undefined);',
      `  fs.writeFileSync(${JSON.stringify(probeMarker)}, String(process.pid));`,
      `  ${probe} process.exit(0);`,
      '}',
      `fs.writeFileSync(${JSON.stringify(agentMarker)}, "executed");`,
      'fs.readFileSync(0, "utf8");',
      'assert.equal(process.env.PIP_REQUIRE_VIRTUALENV, "true");',
      'assert.equal(process.env.PIP_CONFIG_FILE, "test-policy-path");',
      'fs.writeFileSync("answer.txt", fs.readFileSync("fixtures/message.txt"));',
      adapterId === "claude-code"
        ? 'console.log(JSON.stringify({type:"result",subtype:"success",session_id:"test",model:"test-model"}));'
        : 'console.log(JSON.stringify({type:"thread.started",thread_id:"test"})); console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));',
    ].join("\n"));
    chmodSync(command, 0o755);
    const runtimeEnv = { PATH: process.env.PATH, ANTHROPIC_API_KEY: "test-auth-secret", CODEX_API_KEY: "test-auth-secret" };
    const baseAdapter = adapterId === "claude-code"
      ? createClaudeCodeAdapter({ command, runtimeEnv })
      : createCodexAdapter({ command, runtimeEnv });
    const adapter = {
      ...baseAdapter,
      createLaunchPlan(input) {
        const plan = baseAdapter.createLaunchPlan(input);
        return { ...plan, env: { ...plan.env, PIP_REQUIRE_VIRTUALENV: "false", PIP_CONFIG_FILE: "test-policy-path" } };
      },
      decodeControllerEvidence(input) {
        const decoded = baseAdapter.decodeControllerEvidence(input);
        return { ...decoded, metrics: { ...decoded.metrics, adapter: { ...decoded.metrics?.adapter, toolVersions: { runner: "9.9.9" } } } };
      },
    };
    const local = createLocalExecutionEnvironment();
    let lastObservation;
    const executionEnvironment = {
      ...local,
      async execute(input) {
        const observed = await local.execute(input);
        lastObservation = observed;
        return Object.hasOwn(scenario, "observed") ? { ...observed, toolVersions: scenario.observed } : observed;
      },
    };
    const store = await openLocalResultStore({ root: join(root, "results") });
    const controller = new AbortController();
    if (scenario.stageAbort) {
      const originalWrite = fsPromises.default.writeFile;
      t.mock.method(fsPromises.default, "writeFile", async (...args) => {
        const result = await originalWrite(...args);
        if (String(args[0]).includes("tae-local-run-") && String(args[0]).endsWith("/fixtures/message.txt")) controller.abort();
        return result;
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    }
    const originalKill = process.kill;
    let deniedPid = null;
    if (scenario.denyKill) {
      process.kill = function (pid, signal) {
        if (signal !== 0 && existsSync(probeMarker) && pid === -Number(readFileSync(probeMarker, "utf8"))) {
          deniedPid = -pid;
          throw Object.assign(new Error("controlled process-control denial"), { code: "EPERM" });
        }
        return originalKill.call(process, pid, signal);
      };
      t.after(() => {
        process.kill = originalKill;
        if (deniedPid !== null) {
          try { originalKill.call(process, -deniedPid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      });
    }
    const startedAt = Date.now();
    const pending = createRunEngine({ resultStore: store, agentAdapter: adapter, executionEnvironment }).run({ runPlan: suite.value, signal: controller.signal });
    if (scenario.cancel) {
      for (let attempt = 0; attempt < 100 && !existsSync(probeMarker); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(existsSync(probeMarker), "probe must have started before cancellation");
      controller.abort();
    }
    const result = await pending;
    assert.equal(result.runs[0].verdict, scenario.cancel || scenario.stageAbort || scenario.denyKill ? "incomplete" : "pass", JSON.stringify(result));
    if (scenario.cancel || scenario.stageAbort || scenario.denyKill) {
      assert.equal(lastObservation.process, null, "no Agent process may be spawned after probe cancellation");
      assert.equal(existsSync(agentMarker), false, "cancellation must not launch the Agent, even briefly");
      assert.ok(Date.now() - startedAt < 10_000, "probe termination must settle within its bounded cleanup window");
      if (scenario.denyKill) assert.ok(lastObservation.integrityIssues.some(issue => issue.code === "environment.version-probe-not-quiescent"));
      return;
    }
    const [record] = await store.listRuns();
    const versions = record.metrics.adapters[adapterId].toolVersions;
    assert.equal(versions?.runner ?? null, expected);
    if (scenario.observed === null) assert.equal(versions, null);
    if (!Object.hasOwn(scenario, "observed")) assert.match(versions.node, /^\d+\.\d+\.\d+/);
    assert.equal(versions?.extra, undefined);
    const transcript = await store.readEvidence(record.evidence.transcript, { maxBytes: 64 * 1024 });
    assert.doesNotMatch(transcript.toString(), /2\.1\.263|0\.123\.0|test-auth-secret|unsupported option|not a version/);
  });
}

test("real pip refuses host installs with the Local guard and permits a disposable venv", (t) => {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.status !== 0) return t.skip("Python is not installed; Local JS Tasks do not require it");
  const root = mkdtempSync(join(tmpdir(), "tae-pip-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, PIP_REQUIRE_VIRTUALENV: "true", PIP_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null" };
  const blocked = spawnSync("python3", ["-m", "pip", "install", "--no-index", "tae-deliberately-nonexistent-test-package"], { env, cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /activated virtualenv/i);
  const created = spawnSync("python3", ["-m", "venv", join(root, "venv")], { env, cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(created.status, 0, created.stderr);
  // A tiny pure-Python wheel is generated locally; no index/build backend/network.
  const wheel = join(root, "tae_guard_fixture-1.0-py3-none-any.whl");
  const made = spawnSync("python3", ["-c", [
    "import zipfile, sys",
    "with zipfile.ZipFile(sys.argv[1], 'w') as z:",
    " z.writestr('tae_guard_fixture.py', 'VALUE = 42\\n')",
    " z.writestr('tae_guard_fixture-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: tae-guard-fixture\\nVersion: 1.0\\n')",
    " z.writestr('tae_guard_fixture-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: tae-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')",
    " z.writestr('tae_guard_fixture-1.0.dist-info/RECORD', '')",
  ].join("\n"), wheel], { env, cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(made.status, 0, made.stderr);
  const venvPython = join(root, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const installed = spawnSync(venvPython, ["-m", "pip", "install", "--no-index", "--no-deps", wheel], { env, cwd: root, encoding: "utf8", timeout: 15_000 });
  assert.equal(installed.status, 0, installed.stderr);
  const imported = spawnSync(venvPython, ["-c", "import tae_guard_fixture; assert tae_guard_fixture.VALUE == 42"], { env, cwd: root, encoding: "utf8", timeout: 5_000 });
  assert.equal(imported.status, 0, imported.stderr);
});
