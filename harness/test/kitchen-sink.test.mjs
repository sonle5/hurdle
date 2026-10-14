import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createKitchenSinkAgent } from "../experiments/kitchen-sink-agent.mjs";
import { createLocalExecutionEnvironment } from "../lib/execution-environments/local.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

const exampleRoot = fileURLToPath(new URL("../../examples/kitchen-sink/", import.meta.url));

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [relative(exampleRoot, path).split(sep).join("/")];
  });
}

test("init kitchen-sink copies every file in the example", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-kitchen-sink-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await initializeSuite({ destination: join(root, "kitchen-sink"), example: "kitchen-sink" });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual([...result.value.createdFiles].sort(), listFiles(exampleRoot).sort());
});

test("the kitchen-sink example reaches each designed result", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-kitchen-sink-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resolved = await resolveV1Suite({ suitePath: join(exampleRoot, "example.suite.mjs") });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const store = await openLocalResultStore({ root: join(root, "results") });
  const result = await createRunEngine({
    resultStore: store,
    agentAdapter: createKitchenSinkAgent(),
    executionEnvironment: createLocalExecutionEnvironment(),
  }).run({
    runPlan: resolved.value,
    agentSelections: resolved.defaults.agentSelections,
    repeat: resolved.defaults.repeat,
    concurrency: resolved.defaults.concurrency,
    experimentVersion: "kitchen-sink-test",
  });
  assert.equal(result.status, "complete", JSON.stringify(result.diagnostics));

  const runs = Object.fromEntries(await Promise.all(result.runs.map(async ({ id }) => {
    const record = await store.getRun(id);
    return [`${record.snapshot.task.id}/${record.snapshot.condition.id}`, {
      verdict: record.verdict,
      checks: Object.fromEntries(record.checks.map(({ id: checkId, outcome }) => [checkId, outcome])),
    }];
  })));
  assert.deepEqual(Object.fromEntries(Object.entries(runs).map(([cell, { verdict }]) => [cell, verdict])), {
    "order-total/baseline": "pass",
    "order-total/with-skill": "pass",
    "release-notes/baseline": "fail",
    "release-notes/with-skill": "pass",
    "fix-the-bug/baseline": "pass",
    "fix-the-bug/with-skill": "pass",
    "oversized-report/baseline": "incomplete",
    "oversized-report/with-skill": "incomplete",
    "summarize-notes/baseline": "unknown",
    "summarize-notes/with-skill": "unknown",
  });
  assert.deepEqual(runs["release-notes/baseline"].checks, {
    completed: "pass", notes: "pass", "codename-title": "fail", "crew-sign-off": "fail", "grouped-changes": "fail",
  }, "only the skill teaches the house style");
  assert.deepEqual(runs["fix-the-bug/baseline"].checks, {
    completed: "pass", source: "pass", "test-file": "pass", "replaces-every-space": "pass",
    "test-untouched": "pass", "reply-includes": "pass", "one-line-reply": "fail",
  }, "an advisory failure does not fail the run");
  assert.deepEqual(runs["oversized-report/baseline"].checks, {
    completed: "pass", report: "skip", "lists-every-number": "skip",
  }, "a required check that cannot decide makes the run incomplete");
  assert.deepEqual(runs["summarize-notes/baseline"].checks, {
    summary: "pass", "uses-bullets": "pass", "under-120-words": "fail", "names-owners": "pass",
  }, "observations alone never decide a result");
});
