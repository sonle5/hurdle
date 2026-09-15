import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const readRepoFile = (relativePath) =>
  readFileSync(new URL(relativePath, repoRoot), "utf8");
const readPackage = (relativePath) =>
  JSON.parse(readRepoFile(relativePath));

test("the root bill-free command includes every local test suite", () => {
  const rootPackage = readPackage("package.json");
  const expectedTestScripts = [
    [
      "harness/package.json",
      "npm --prefix harness test",
      "cd .. && node --test harness/test/*.test.mjs",
    ],
    [
      "viewer/package.json",
      "npm --prefix viewer test",
      "node --test test/*.test.mjs",
    ],
  ];

  for (const [packagePath, , packageCommand] of expectedTestScripts) {
    const packageJson = readPackage(packagePath);
    assert.equal(packageJson.scripts?.test, packageCommand);
  }

  assert.equal(
    rootPackage.scripts.test,
    expectedTestScripts.map(([, rootCommand]) => rootCommand).join(" && "),
  );
});

test("pull request CI runs only the documented bill-free path", () => {
  const workflow = readRepoFile(".github/workflows/ci.yml");

  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/,
  );
  assert.match(
    workflow,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/,
  );
  assert.match(workflow, /run: npm run setup:ci/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm run build/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|npm run (?:eval|smoke)|harness\/(?:e2b|tester)|harness-(?:codex|opencode)/,
  );
});
