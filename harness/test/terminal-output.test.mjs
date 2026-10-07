import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createFrameworkCli } from "../bin/hurdle.mjs";
import { quoteCommandArgument } from "../lib/terminal-output.mjs";
import { createQuickstartViewerOutput } from "../lib/source-quickstart.mjs";

function output(cwd, isTTY) {
  let stdout = "", stderr = "";
  return {
    io: { cwd, stdin: { isTTY: false }, stdout: { isTTY, write(v) { stdout += v; } }, stderr: { isTTY, write(v) { stderr += v; } } },
    read: () => ({ stdout, stderr }),
  };
}

test("init, validation, setup, and help share terminal styling without ANSI in redirected/NO_COLOR output", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = process.env.NO_COLOR;
  t.after(() => original === undefined ? delete process.env.NO_COLOR : process.env.NO_COLOR = original);
  const cli = createFrameworkCli({ env: {}, promptSetup: async () => null, checkAgentReadiness: async () => ({ ok: true, checks: [{ status: "pass", message: "Credentials verified" }] }), assertRuntimeDependencies() {} });
  for (const [name, isTTY, noColor] of [["color", true, false], ["pipe", false, false], ["no-color", true, true]]) {
    if (noColor) process.env.NO_COLOR = "1"; else delete process.env.NO_COLOR;
    const capture = output(root, isTTY);
    assert.equal(await cli.main(["init", name, "--example", "together-api"], capture.io), 0);
    assert.equal(await cli.main(["validate", `${name}/example.suite.mjs`, "--offline"], capture.io), 0);
    // Missing credentials stop setup before any network call or template build.
    assert.equal(await cli.main(["setup", `${name}/example.suite.mjs`], capture.io), 1);
    assert.equal(await cli.main(["help", "init"], capture.io), 0);
    assert.equal(await cli.main(["init", "--agent", "unknown"], capture.io), 2);
    const raw = capture.read();
    const text = stripVTControlCharacters(raw.stdout);
    assert.equal((text.match(/^Hurdle$/gm) ?? []).length, 4);
    assert.match(text, /✓ Evaluation created/);
    assert.match(text, /! Readiness not checked/);
    assert.match(text, /✗ hurdle \[setup\.credentials-missing\] Missing credentials: E2B_API_KEY/);
    assert.match(text, new RegExp(`Next      npx hurdle setup ${name}/example.suite.mjs`));
    assert.equal(existsSync(join(root, ".hurdle")), false);
    if (isTTY && !noColor) {
      assert.match(raw.stdout, /\u001b\[1mHurdle/);
      assert.match(raw.stdout, /\u001b\[32m✓/);
      assert.match(raw.stdout, /\u001b\[33m!/);
      assert.match(raw.stdout, /\u001b\[31m✗/);
      assert.match(raw.stderr, /\u001b\[31m✗/);
    } else assert.doesNotMatch(raw.stdout + raw.stderr, /\u001b/);
  }
});

test("custom-suite next steps are concise and round-trip shell metacharacters safely", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-output-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = "evals/a ' $(touch unexpected) `touch unexpected`";
  const suite = `${directory}/example.suite.mjs`;
  mkdirSync(join(root, "evals"));
  const capture = output(root, false);
  const cli = createFrameworkCli();
  assert.equal(await cli.main(["init", directory, "--example", "together-api"], capture.io), 0);
  const commands = capture.read().stdout.split("\n").filter(line => line.includes("npx hurdle setup") || line.includes("npx hurdle run"));
  assert.equal(commands.length, 2);
  for (const line of commands) {
    const command = line.slice(line.indexOf("npx hurdle"));
    const parsed = spawnSync("/bin/sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], { cwd: root, encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.deepEqual(parsed.stdout.trimEnd().split("\n"), ["npx", "hurdle", command.includes(" setup ") ? "setup" : "run", suite, ...(command.endsWith(" --view") ? ["--view"] : [])]);
  }
  assert.equal(existsSync(join(root, "unexpected")), false);
  assert.equal(quoteCommandArgument("evals/together-api/example.suite.mjs"), "evals/together-api/example.suite.mjs");
});

test("source runtime tools share formatting without making provider requests", t => {
  const cwd = mkdtempSync(join(tmpdir(), "hurdle-source-output-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (file, args = []) => spawnSync(process.execPath, [fileURLToPath(new URL(`../bin/${file}`, import.meta.url)), ...args], {
    cwd, encoding: "utf8", env: { PATH: process.env.PATH },
  });
  const created = run("init-runtime.mjs", ["e2b", "--template", "example:v1"]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Hurdle\n\n✓ Runtime created/);
  assert.match(created.stdout, /Runtime   \.hurdle\/runtime\/e2b.json/);
  assert.match(created.stdout, /Next      npm run preflight/);
  const duplicate = run("init-runtime.mjs", ["e2b", "--template", "example:v1"]);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /^✗ .*already exists/);
  const checked = run("preflight.mjs");
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /Hurdle\n\n  Source/);
  assert.match(checked.stdout, /! No configured credentials found/);
  const migrated = run("migrate-postgres-result-store.mjs");
  assert.equal(migrated.status, 1);
  assert.match(migrated.stderr, /^✗ hurdle \[migration-failed\]/);
  assert.doesNotMatch(created.stdout + duplicate.stderr + checked.stdout + migrated.stderr, /\u001b/);
});

test("source quickstart stops its spinner when the current Viewer output is ready", async () => {
  let text = "", ready = 0;
  const cli = createFrameworkCli({ async launchViewer({ onReady }) {
    onReady("http://127.0.0.1:3000");
    return { kind: "stopped" };
  } });
  const stream = { isTTY: true, write(value) { text += value; } };
  const stdout = createQuickstartViewerOutput({ stream, onReady() { ready++; } });
  assert.equal(await cli.main(["view", "--store", "/tmp/hurdle-output-results"], { cwd: "/tmp", stdout, stderr: { write() {} } }), 0);
  const plain = stripVTControlCharacters(text);
  assert.equal(ready, 1);
  assert.doesNotMatch(plain, /^Hurdle$/m);
  assert.match(plain, /✓ Viewer ready/);
  assert.match(plain, /URL       http:\/\/127.0.0.1:3000/);
  assert.match(plain, /Store     hurdle-output-results/);
});
