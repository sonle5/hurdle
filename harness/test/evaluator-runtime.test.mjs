import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDeterministicEvaluator } from "../lib/evaluator-runtime.mjs";

function writeEvaluator(t, source) {
  const behaviorRoot = mkdtempSync(join(tmpdir(), "hurdle-evaluator-runtime-"));
  t.after(() => rmSync(behaviorRoot, { recursive: true, force: true }));
  const evaluatorPath = join(behaviorRoot, "evaluator.mjs");
  writeFileSync(evaluatorPath, source);
  return { behaviorRoot, evaluatorPath };
}

test("a large transcript is evaluated within the isolated runtime bound", async (t) => {
  const { behaviorRoot, evaluatorPath } = writeEvaluator(t, [
    "export function evaluate(input) {",
    "  return { checks: [], targetMetrics: {}, transcriptBytes: input.transcript.text.length };",
    "}",
    "",
  ].join("\n"));
  // Long Agent sessions can approach the 64 MiB controller capture limit.
  const text = `${JSON.stringify({ type: "assistant", text: "x".repeat(72 * 1024 * 1024) })}\n`;

  const result = await runDeterministicEvaluator({
    evaluatorPath,
    behaviorRoot,
    snapshot: {},
    transcript: { text },
    execution: {},
    artifacts: [],
  });

  assert.equal(result.status, "complete");
  assert.deepEqual(result.integrityIssues, []);
});
