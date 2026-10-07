import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createViewerOnboarding, validateViewerOnboarding } from "../lib/viewer-onboarding.mjs";

test("source Viewer commands keep the Suite and E2B Runtime, with literal shell paths", t => {
  if (process.platform === "win32") return t.skip("POSIX shell guidance");
  const root = mkdtempSync(join(tmpdir(), "hurdle-viewer-onboarding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project '$(echo unexpected)' dir");
  mkdirSync(cwd);
  const cliPath = join(root, "draft ' cli.mjs");
  const capture = join(root, "args.jsonl");
  writeFileSync(cliPath, 'import {appendFileSync} from "node:fs"; appendFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2))+"\\n");');
  const context = createViewerOnboarding({
    cwd, cliPath, sourceCheckout: true, suite: "evals/custom suite.mjs",
    runtimeProfile: { sourcePath: join(cwd, "runtime ' file.json"), environment: { kind: "e2b" } },
  });
  const result = spawnSync("/bin/sh", [], {
    input: context.commands, encoding: "utf8",
    env: { PATH: process.env.PATH, CAPTURE: capture },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse), [
    ["validate", "evals/custom suite.mjs", "--runtime", "runtime ' file.json"],
    ["run", "evals/custom suite.mjs", "--runtime", "runtime ' file.json"],
  ]);
  assert.equal(context.runtimeLabel, "E2B sandbox");
  assert.doesNotMatch(context.commands, /npx hurdle/);
});

test("installed Viewer commands select the requested Local store rather than a discovered Runtime", () => {
  const context = createViewerOnboarding({
    cwd: "/project", cliPath: "/package/cli.mjs", sourceCheckout: false, suite: "example.suite.mjs",
    runtimeProfile: { sourcePath: null, environment: { kind: "local" }, resultStore: { kind: "local", root: "/project/custom-results" } },
  });
  assert.match(context.commands, /npx hurdle validate --environment local --store custom-results/);
  assert.match(context.commands, /npx hurdle run --environment local --store custom-results/);
  assert.equal(context.setupCommand, "npx hurdle setup");
});

test("a store override conflicting with a saved Runtime does not suggest an incorrect run", () => {
  const context = createViewerOnboarding({
    cwd: "/project", cliPath: "/package/cli.mjs", sourceCheckout: false, suite: "example.suite.mjs", storeOverride: true,
    runtimeProfile: { sourcePath: "/project/runtime.json", environment: { kind: "e2b" } },
  });
  assert.equal(context.commands, null);
});

test("Viewer display metadata rejects extra fields and control characters", () => {
  const context = { projectDirectory: "/project", commands: "hurdle run", setupCommand: "hurdle setup", runtimeLabel: "Local" };
  assert.deepEqual(validateViewerOnboarding(context), context);
  assert.throws(() => validateViewerOnboarding({ ...context, ANTHROPIC_API_KEY: "secret" }), /invalid/);
  assert.throws(() => validateViewerOnboarding({ ...context, commands: "bad\u001bcommand" }), /invalid/);
});
