import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = path => JSON.parse(readFileSync(join(root, path), "utf8"));

test("Local setup skips beta SDKs and the unused harness TypeScript install; CI keeps backend coverage", () => {
  const harness = read("harness/package.json");
  const scripts = read("package.json").scripts;
  for (const name of ["e2b", "https-proxy-agent", "ws"]) {
    assert.equal(harness.dependencies[name], undefined, name);
    assert.ok(harness.optionalDependencies[name], name);
  }
  assert.equal(harness.devDependencies?.typescript, undefined);
  assert.equal(harness.devDependencies?.["@types/node"], undefined);
  assert.ok(harness.dependencies.pg, "the Viewer keeps its small Postgres driver");
  assert.match(scripts.setup, /--prefix harness install --omit=optional/);
  assert.match(scripts["setup:backends"], /--prefix harness install --include=optional/);
  assert.match(scripts["setup:ci"], /--prefix harness ci --include=optional/);
  const quickstart = readFileSync(join(root, "harness/bin/source-quickstart.mjs"), "utf8");
  assert.match(quickstart, /prefix === "harness".*"--omit=optional"/);
});

test("the root tae command exposes the public CLI", () => {
  const result = spawnSync("npm", ["run", "tae", "--", "--help"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^> tae\n> node harness\/bin\/tae\.mjs --help\n/m);
  assert.match(result.stdout, /^TAE\n\nUsage:\n  tae <command> \[options\]/m);
});

test("a Local install runs a real controller without E2B and rejects missing E2B before opening a store", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-core-only-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const harness = join(cwd, "harness");
  cpSync(join(root, "examples/copy-message"), join(cwd, "examples/copy-message"), { recursive: true });
  // No npm/network in unit tests: isolate framework source and expose only core modules.
  mkdirSync(harness);
  for (const path of ["bin", "lib", "verify", "types", "index.mjs", "package.json"]) {
    cpSync(join(root, "harness", path), join(harness, path), { recursive: true });
  }
  mkdirSync(join(harness, "node_modules"));
  for (const name of Object.keys(read("harness/package.json").dependencies)) {
    symlinkSync(join(root, "harness/node_modules", name), join(harness, "node_modules", name));
  }
  const env = { PATH: process.env.PATH, E2B_API_KEY: "test-not-a-real-key" };
  const cli = (...args) => spawnSync(process.execPath, [join(harness, "bin/tae.mjs"), ...args], { cwd, env, encoding: "utf8", timeout: 20_000 });
  const initialized = cli("init", "evals");
  assert.equal(initialized.status, 0, initialized.stderr);
  const validated = cli("validate", "evals/example.suite.mjs");
  assert.equal(validated.status, 0, validated.stderr);
  const remote = cli("run", "evals/example.suite.mjs", "--environment", "e2b");
  assert.equal(remote.status, 2, remote.stderr);
  assert.match(remote.stderr, /\[backend-not-installed\].*E2B.*npm run setup:backends/);
  assert.equal(existsSync(join(cwd, ".tae/results-v1")), false);
  // Exercise the real Local controller and filesystem store with a fake Agent.
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const agent = join(bin, "claude");
  writeFileSync(agent, [
    "#!/usr/bin/env node",
    'const { readFileSync, writeFileSync } = require("node:fs");',
    'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
    'readFileSync(0, "utf8");',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "core-only" }));',
    'console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "core-only", model: "test-model" }));',
  ].join("\n"));
  chmodSync(agent, 0o755);
  env.PATH = `${bin}:${process.env.PATH}`;
  env.ANTHROPIC_API_KEY = "test-only-key";
  const local = cli("run", "evals/example.suite.mjs");
  assert.equal(local.status, 0, local.stderr + local.stdout);
  assert.match(local.stdout, /^  Result\s+Passed$/m);
  assert.match(local.stdout, /^  Runs\s+1 passed$/m);
  assert.equal(existsSync(join(cwd, ".tae/results-v1")), true);
});
