import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeExecutionProgressObserver,
  reportExecutionProgress,
} from "../lib/execution-progress.mjs";

test("execution progress projects closed frozen events and isolates observer failures", async () => {
  const events = [];
  const observer = normalizeExecutionProgressObserver({
    observe(event) {
      events.push(event);
      if (event.kind === "cell-started") throw new Error("presentation failed");
      if (event.kind === "cell-completed") return Promise.reject(new Error("async failure"));
      return undefined;
    },
  });

  assert.doesNotThrow(() => reportExecutionProgress(observer, {
    kind: "matrix-ready",
    total: 6,
    secret: "must-not-cross",
  }));
  assert.doesNotThrow(() => reportExecutionProgress(observer, {
    kind: "cell-started",
    cell: {
      ordinal: 1,
      total: 6,
      taskId: "rag-search-evidence-v1",
      conditionId: "baseline",
      adapterId: "claude-code",
      repeatOrdinal: 1,
      repeatTotal: 1,
      secret: "must-not-cross",
    },
  }));
  assert.doesNotThrow(() => reportExecutionProgress(observer, {
    kind: "cell-completed",
    cell: {
      ordinal: 1,
      total: 6,
      taskId: "rag-search-evidence-v1",
      conditionId: "baseline",
      adapterId: "claude-code",
      repeatOrdinal: 1,
      repeatTotal: 1,
    },
    terminal: {
      id: "run_one",
      verdict: "pass",
      snapshotFingerprint: "must-not-cross",
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    { kind: "matrix-ready", total: 6 },
    {
      kind: "cell-started",
      cell: {
        ordinal: 1,
        total: 6,
        taskId: "rag-search-evidence-v1",
        conditionId: "baseline",
        adapterId: "claude-code",
        repeatOrdinal: 1,
        repeatTotal: 1,
      },
    },
    {
      kind: "cell-completed",
      cell: {
        ordinal: 1,
        total: 6,
        taskId: "rag-search-evidence-v1",
        conditionId: "baseline",
        adapterId: "claude-code",
        repeatOrdinal: 1,
        repeatTotal: 1,
      },
      terminal: { id: "run_one", verdict: "pass", verdictReasons: [] },
    },
  ]);
  assert.equal(Object.isFrozen(events[0]), true);
  assert.equal(Object.isFrozen(events[1].cell), true);
  assert.equal(reportExecutionProgress(null, { kind: "matrix-ready", total: 1 }), false);
  assert.equal(reportExecutionProgress(observer, { kind: "unknown" }), false);
});

test("non-pass progress projects only bounded single-line stored reasons", () => {
  const events = [];
  const cell = { ordinal: 1, total: 1, taskId: "sample", conditionId: "baseline", adapterId: "codex", repeatOrdinal: 1, repeatTotal: 1 };
  const reason = { code: "environment.acquire-failed", summary: "E2B failed.\n\u001b[31mCheck setup.\u001b[0m", evidenceRefs: ["not-for-terminal"], rawError: "private-error" };
  reportExecutionProgress({ observe(event) { events.push(event); } }, {
    kind: "cell-completed", cell,
    terminal: { id: "run_one", verdict: "incomplete", runTrustReasons: [{
      code: "environment.nonzero-exit",
      summary: "Agent could not start.",
      evidenceRefs: ["not-for-terminal"],
    }], verdictReasons: [
      reason, reason, { code: "invalid\ncode", summary: "ignored" },
      { code: "artifact.required-missing", summary: "x".repeat(1000) },
      { code: "judge.result-required", summary: "Judge unavailable." },
      { code: "omitted", summary: "fourth reason" },
    ] },
  });
  const reasons = events[0].terminal.verdictReasons;
  assert.deepEqual(events[0].terminal.runTrustReasons, [{
    code: "environment.nonzero-exit",
    summary: "Agent could not start.",
  }]);
  assert.equal(reasons.length, 3);
  assert.deepEqual(reasons[0], { code: reason.code, summary: "E2B failed. Check setup." });
  assert.equal(reasons[1].summary.length, 300);
  assert.ok(reasons[1].summary.endsWith("…"));
  assert.ok(Object.isFrozen(reasons) && reasons.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(reasons), /private-error|not-for-terminal|fourth reason|\\u001b|\\n/);
});
