import assert from "node:assert/strict";
import test from "node:test";

import { deriveRunOutcome } from "../lib/run-model.mjs";

function snapshot({ deterministic = true, observationOnly = false } = {}) {
  return {
    task: {
      id: "review-answer",
      observationOnly,
      judge: { rubric: "The answer must satisfy the rubric." },
    },
    behavior: {
      deterministicEvaluator: deterministic
        ? { entryPath: "evaluators/review-answer.mjs", sha256: "sha256:deterministic" }
        : null,
    },
  };
}

const requiredPass = [{
  id: "required-check",
  required: true,
  outcome: "pass",
  summary: "The required evidence passed.",
  evidenceRefs: [],
}];

const requiredFail = [{
  ...requiredPass[0],
  outcome: "fail",
  summary: "The required evidence failed.",
}];

test("Judge outcomes can only tighten a deterministic pass", () => {
  for (const outcome of ["pass", "fail", "incomplete"]) {
    assert.deepEqual(
      deriveRunOutcome({
        snapshot: snapshot(),
        checks: requiredPass,
        integrityIssues: [],
        evaluatorStatus: "complete",
        judgeOutcome: outcome,
      }),
      {
        verdict: outcome,
        verdictReasons: [{
          code: `judge.rubric-${outcome}`,
          summary: `The optional Judge returned ${outcome}.`,
          evidenceRefs: [],
        }],
      },
    );
  }
});

test("Judge pass cannot relax deterministic or integrity non-passes", () => {
  const incompleteIssue = {
    code: "controller.capture-incomplete",
    phase: "execute",
    effect: "incomplete",
    message: "Controller capture was incomplete.",
  };
  const cases = [
    {
      checks: requiredFail,
      integrityIssues: [],
      evaluatorStatus: "complete",
      expected: {
        verdict: "fail",
        verdictReasons: [{
          code: "check.required-check",
          summary: "The required evidence failed.",
          evidenceRefs: [],
        }],
      },
    },
    {
      checks: [],
      integrityIssues: [incompleteIssue],
      evaluatorStatus: "blocked_by_evidence",
      expected: {
        verdict: "incomplete",
        verdictReasons: [{
          code: incompleteIssue.code,
          summary: incompleteIssue.message,
          evidenceRefs: [],
        }],
      },
    },
    {
      checks: [],
      integrityIssues: [],
      evaluatorStatus: "invalid",
      expected: { verdict: "unknown", verdictReasons: [] },
    },
    {
      checks: [],
      integrityIssues: [],
      evaluatorStatus: "complete",
      expected: { verdict: "unknown", verdictReasons: [] },
    },
  ];

  for (const value of cases) {
    assert.deepEqual(
      deriveRunOutcome({
        snapshot: snapshot(),
        checks: value.checks,
        integrityIssues: value.integrityIssues,
        evaluatorStatus: value.evaluatorStatus,
        judgeOutcome: "pass",
      }),
      value.expected,
    );
  }
});

test("a clean Judge-only Task can establish an outcome but other unknowns cannot", () => {
  for (const outcome of ["pass", "fail", "incomplete"]) {
    assert.equal(
      deriveRunOutcome({
        snapshot: snapshot({ deterministic: false }),
        checks: [],
        integrityIssues: [],
        evaluatorStatus: "not_requested",
        judgeOutcome: outcome,
      }).verdict,
      outcome,
    );
  }

  assert.equal(
    deriveRunOutcome({
      snapshot: snapshot({ deterministic: false, observationOnly: true }),
      checks: [],
      integrityIssues: [],
      evaluatorStatus: "not_requested",
      judgeOutcome: "pass",
    }).verdict,
    "unknown",
  );
  assert.equal(
    deriveRunOutcome({
      snapshot: snapshot({ deterministic: false }),
      checks: [],
      integrityIssues: [{
        code: "run.execution-failed",
        phase: "execute",
        effect: "incomplete",
        message: "Execution failed.",
      }],
      evaluatorStatus: "not_requested",
      judgeOutcome: "pass",
    }).verdict,
    "incomplete",
  );
});

test("pending or failed judging preserves the supplied deterministic outcome byte-for-byte", () => {
  const deterministicOutcome = {
    verdict: "pass",
    verdictReasons: [{
      code: "checks.required-pass",
      summary: "All required checks passed.",
      evidenceRefs: [],
    }],
  };

  assert.deepEqual(
    deriveRunOutcome({
      snapshot: snapshot(),
      checks: requiredPass,
      integrityIssues: [],
      evaluatorStatus: "complete",
      deterministicOutcome,
      judgeOutcome: null,
    }),
    deterministicOutcome,
  );
});
