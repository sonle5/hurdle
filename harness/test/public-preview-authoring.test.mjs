import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFrameworkCli } from "../bin/tae.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

function output(cwd) {
  let text = "";
  return { cwd, stdout: { write(value) { text += value; } }, stderr: { write(value) { text += value; } }, read: () => text };
}

test("init produces the same Suite format used by quickstart and user tasks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-public-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = output(root);
  const cli = createFrameworkCli().main;
  assert.equal(await cli(["init"], io), 0, io.read());
  const suitePath = join(root, "evals", "example.suite.mjs");
  assert.equal(existsSync(suitePath), true);
  assert.equal(existsSync(join(root, "evals", "eval.config.json")), false);
  const suite = await resolveV1Suite({ suitePath });
  t.after(() => suite.dispose());
  assert.equal(suite.ok, true, JSON.stringify(suite.diagnostics));
  assert.deepEqual(suite.defaults.taskIds, ["copy-message"]);
  assert.equal(suite.value.definition.tasks["copy-message"].evaluation.authority.defaultProfileId, "v1-code");
  assert.equal(await cli(["validate", "--offline"], output(join(root, "evals"))), 0);
  assert.equal(await cli(["init"], io), 1, "existing files must not be overwritten");
  const readme = readFileSync(join(root, "evals", "README.md"), "utf8");
  assert.match(readme, /npx hurdle run --view/);
  assert.doesNotMatch(readme, /Two repeats execute twice/);
  renameSync(join(root, "evals/tasks/copy-message/checks.mjs"), join(root, "evals/tasks/copy-message/checks.ts"));
  await assert.rejects(resolveV1Suite({ suitePath }), { code: "task.checks-invalid" });
});

for (const specifier of ["tae", "@nutlope/tae"]) {
  test(`existing Suites and checks using ${specifier} remain valid`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "hurdle-authoring-compat-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const io = output(root);
    assert.equal(await createFrameworkCli().main(["init"], io), 0, io.read());
    const suitePath = join(root, "evals", "example.suite.mjs");
    for (const path of [suitePath, join(root, "evals", "tasks", "copy-message", "checks.mjs")]) {
      const source = readFileSync(path, "utf8");
      assert.match(source, /from "hurdle"/);
      writeFileSync(path, source.replaceAll('from "hurdle"', `from "${specifier}"`));
    }
    const suite = await resolveV1Suite({ suitePath });
    t.after(() => suite.dispose());
    assert.equal(suite.ok, true, JSON.stringify(suite.diagnostics));
    assert.deepEqual(suite.defaults.taskIds, ["copy-message"]);
  });
}

test("public CLI rejects authored manifests and authority/retry override flags before effects", async () => {
  let effects = 0;
  const cli = createFrameworkCli({ resolveV1Suite: async () => { effects += 1; throw new Error("not reached"); } }).main;
  for (const args of [
    ["validate", "eval.config.json"],
    ["run", "eval.config.json"],
    ["validate", "example.suite.ts"],
    ["run", "example.suite.ts"],
    ["run", "example.suite.mjs", "--authority-profile", "custom"],
    ["run", "example.suite.mjs", "--retries", "2"],
    ["run", "example.suite.mjs", "--profile", "codex=gpt-5.5"],
  ]) {
    const io = output(process.cwd());
    assert.equal(await cli(args, io), 2, io.read());
    assert.match(io.read(), /Suite|Unknown run option/);
  }
  assert.equal(effects, 0);
});
