import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
test("all public setup and evaluation commands use the one source Suite path", () => {
  assert.deepEqual(readdirSync(new URL("examples/", root)).sort(), ["concurrency-smoke", "copy-message", "kitchen-sink", "together-api"]);
  assert.equal(pkg.scripts.quickstart, "node harness/bin/source-quickstart.mjs");
  assert.equal(pkg.scripts.showcase, "npm run legacy --");
  assert.match(pkg.scripts.legacy, /legacy\.suite\.mjs/);
  assert.match(pkg.scripts.hybrid, /hybrid\.suite\.mjs/);
  assert.match(pkg.scripts.legacy, /--experiment-version together-legacy/);
  assert.match(pkg.scripts.hybrid, /--experiment-version together-hybrid/);
  assert.match(pkg.scripts["chat-app"], /chat-app\.suite\.mjs/);
  for (const script of Object.values(pkg.scripts)) assert.doesNotMatch(script, /eval\.config\.json|source-showcase|legacy\//);
  for (const name of ["showcase:evidence", "showcase:together", "showcase:v1", "env:check"]) assert.equal(pkg.scripts[name], undefined);
  const quickstart = readFileSync(new URL("harness/lib/source-quickstart.mjs", root), "utf8");
  assert.match(quickstart, /examples\/copy-message\/example\.suite\.mjs/);
  assert.match(quickstart, /--store/);
});
test("the release source has no legacy manifest, resource tour or private deploy workflow", () => {
  for (const path of [
    "evals/together/eval.config.json", "evals/together/legacy/eval.config.json",
    "evals/together/bin/source-showcase.mjs", "evals/together/lifecycle/dmi.mjs",
    "harness/eval.config.json",
    ".github/workflows/framework-e2b-smoke.yml", ".github/workflows/framework-sweep.yml",
  ]) assert.equal(existsSync(new URL(path, root)), false, path);
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const togetherReadme = readFileSync(new URL("evals/together/README.md", root), "utf8");
  assert.match(togetherReadme, /Do not combine these results with the\s+historical score series/);
  assert.match(readme, /not a security sandbox/);
});
