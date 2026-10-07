import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createFrameworkCli } from "../bin/tae.mjs";
import { resolveRuntimeProfile } from "../lib/runtime-profile.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

const togetherRoot = fileURLToPath(new URL("../../evals/together/", import.meta.url));
const legacyRoot = join(togetherRoot, "legacy");
const legacySuite = join(togetherRoot, "legacy.suite.mjs");
const legacySmokeSuite = join(togetherRoot, "legacy-smoke.suite.mjs");
const legacySmokeLocalRuntime = join(
  togetherRoot,
  "runtime",
  "legacy-smoke-e2b-local.example.json",
);
const legacySmokePostgresRuntime = join(
  togetherRoot,
  "runtime",
  "legacy-smoke-e2b-postgres.example.json",
);
test("legacy smoke Runtime examples keep E2B fixed while selecting either Result Store", () => {
  const local = resolveRuntimeProfile({
    runtimePath: legacySmokeLocalRuntime,
    cwd: togetherRoot,
  });
  const postgres = resolveRuntimeProfile({
    runtimePath: legacySmokePostgresRuntime,
    cwd: togetherRoot,
  });

  assert.deepEqual(local.environment, postgres.environment);
  assert.deepEqual(local.judge, postgres.judge);
  assert.deepEqual(local.environment, {
    kind: "e2b",
    apiKeyEnv: "E2B_API_KEY",
    settings: {
      workloadTemplate: "REPLACE_WITH_CALLER_OWNED_CLAUDE_E2B_TEMPLATE",
      guardianTemplate: "base",
      cpuCount: 2,
      memoryMiB: 2048,
      maxLifetimeMs: 3_600_000,
    },
  });
  assert.deepEqual(local.resultStore, {
    kind: "local",
    root: resolve(togetherRoot, "../../.hurdle/legacy-smoke-local-results-v1"),
  });
  assert.deepEqual(postgres.resultStore, {
    kind: "postgres",
    databaseUrlEnv: "TAE_RESULT_STORE_DATABASE_URL",
    artifactRoot: resolve(togetherRoot, "../../.hurdle/legacy-smoke-postgres-artifacts"),
  });
  assert.deepEqual(local.judge, {
    kind: "anthropic-json-v1",
    model: "claude-opus-4-8",
    credentialEnv: "ANTHROPIC_API_KEY",
  });
  assert.equal(local.viewer.port, 3000);
  assert.equal(postgres.viewer.port, 3001);
});
