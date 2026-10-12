import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

const cli = fileURLToPath(new URL("../bin/hurdle.mjs", import.meta.url));

test("init pins starter examples to explicit agent models and medium effort", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hurdle-agent-defaults-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const example of ["copy-message", "together-api", "concurrency-smoke"]) {
    for (const [agent, model] of [["claude-code", "claude-opus-5-5"], ["codex", "gpt-6.1-sol"]]) {
      const directory = `${example}-${agent}`;
      const result = spawnSync(process.execPath, [cli, "init", directory, "--example", example, "--agent", agent], { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`Model +${model.replaceAll(".", "\\.")}`));
      assert.match(result.stdout, /Effort +medium/);
      const suitePath = join(cwd, directory, "example.suite.mjs");
      const resolved = await resolveV1Suite({ suitePath });
      try {
        assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
        assert.deepEqual(resolved.defaults.agentSelections, [{ adapterId: agent, requestedModel: model, settings: { effort: "medium" } }]);
      } finally { resolved.dispose(); }
      const validated = spawnSync(process.execPath, [cli, "validate", suitePath, "--offline", "--model", model], { cwd, encoding: "utf8" });
      assert.equal(validated.status, 0, validated.stderr);
      assert.match(validated.stdout, /medium effort/);
    }
  }
});

test("init model and effort overrides round-trip safely and invalid options create no starter", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hurdle-agent-options-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const model = 'custom-$&-"quoted"';
  const result = spawnSync(process.execPath, [cli, "init", "custom", "--model", model, "--effort", "high", "--agent", "codex"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const resolved = await resolveV1Suite({ suitePath: join(cwd, "custom", "example.suite.mjs") });
  try {
    assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
    assert.deepEqual(resolved.defaults.agentSelections, [{ adapterId: "codex", requestedModel: model, settings: { effort: "high" } }]);
  } finally { resolved.dispose(); }
  for (const args of [["--effort", "invalid"], ["--effort"], ["--model"], ["--model", " "], ["--model", "a", "--model", "b"], ["--effort", "medium", "--effort", "high"]]) {
    const invalid = spawnSync(process.execPath, [cli, "init", "invalid", ...args], { cwd, encoding: "utf8" });
    assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
  }
  await assert.rejects(readFile(join(cwd, "invalid", "example.suite.mjs")), { code: "ENOENT" });
});

test("Suite effort validation preserves omitted settings and rejects invalid effort", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hurdle-suite-effort-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const destination = join(cwd, "evals");
  assert.equal((await initializeSuite({ destination })).ok, true);
  const suitePath = join(destination, "example.suite.mjs");
  const source = await readFile(suitePath, "utf8");
  for (const value of [null, "invalid", 2]) {
    await writeFile(suitePath, source.replace('effort: "medium"', `effort: ${JSON.stringify(value)}`));
    await assert.rejects(resolveV1Suite({ suitePath }), { code: "suite.agent-invalid" });
  }
  await writeFile(suitePath, source.replace(', effort: "medium"', ""));
  const resolved = await resolveV1Suite({ suitePath });
  try {
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.defaults.agentSelections[0].settings, {});
  } finally { resolved.dispose(); }
});

test("both agent adapters validate effort and pass it to the native CLI", () => {
  const claude = createClaudeCodeAdapter({ runtimeEnv: { ANTHROPIC_API_KEY: "test-key" } });
  const codex = createCodexAdapter({ runtimeEnv: {} });
  for (const adapter of [claude, codex]) {
    assert.throws(() => adapter.normalizeSettings({ requestedModel: null, settings: { effort: "invalid" } }), /effort must be/);
    const normalized = adapter.normalizeSettings({ requestedModel: "test-model", settings: { effort: "medium" } });
    const plan = adapter.createLaunchPlan({ prompt: "Copy the message", ...normalized });
    if (adapter.id === "claude-code") {
      assert.deepEqual(plan.args.slice(plan.args.indexOf("--effort"), plan.args.indexOf("--effort") + 2), ["--effort", "medium"]);
    } else {
      assert.ok(plan.args.includes('model_reasoning_effort="medium"'));
    }
  }
});
