import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultLocalStoreRoot, projectRuntimePath } from "../lib/project-paths.mjs";
import { resolveRuntimeProfile } from "../lib/runtime-profile.mjs";
import { runSourceQuickstart } from "../lib/source-quickstart.mjs";

function project(t) {
  const cwd = mkdtempSync(join(tmpdir(), "hurdle-project-paths-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test("new projects use .hurdle, existing stores stay visible, and current stores take precedence", async t => {
  const cwd = project(t);
  const current = join(cwd, ".hurdle/results-v1");
  const legacy = join(cwd, ".tae/results-v1");
  assert.equal(defaultLocalStoreRoot(cwd), current);
  assert.equal(resolveRuntimeProfile({ cwd }).resultStore.root, current);
  assert.equal(existsSync(current), false, "Discovery must not create a store");
  mkdirSync(legacy, { recursive: true });
  assert.equal(resolveRuntimeProfile({ cwd }).resultStore.root, legacy);
  const calls = [];
  await runSourceQuickstart({ cwd, runCli: async args => { calls.push(args); return 0; } });
  assert.equal(calls[0][calls[0].indexOf("--store") + 1], legacy);
  assert.equal(calls[1][calls[1].indexOf("--store") + 1], legacy);
  assert.equal(existsSync(current), false);
  mkdirSync(current, { recursive: true });
  assert.equal(resolveRuntimeProfile({ cwd }).resultStore.root, current);
});

test("current Runtime wins over legacy, and explicit Runtime store paths remain unchanged", t => {
  const cwd = project(t);
  assert.equal(projectRuntimePath(cwd), null);
  const config = { schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "local", root: "../custom-results" } };
  mkdirSync(join(cwd, ".tae/runtime"), { recursive: true });
  writeFileSync(join(cwd, ".tae/runtime/default.json"), JSON.stringify(config));
  assert.equal(projectRuntimePath(cwd), ".tae/runtime/default.json");
  assert.equal(resolveRuntimeProfile({ cwd, runtimePath: projectRuntimePath(cwd) }).resultStore.root, join(cwd, ".tae/custom-results"));
  mkdirSync(join(cwd, ".hurdle/runtime"), { recursive: true });
  writeFileSync(join(cwd, ".hurdle/runtime/default.json"), JSON.stringify(config));
  assert.equal(projectRuntimePath(cwd), ".hurdle/runtime/default.json");
  assert.equal(resolveRuntimeProfile({ cwd, runtimePath: ".tae/runtime/default.json" }).resultStore.root, join(cwd, ".tae/custom-results"));
});
