import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAuthority } from "../lib/evaluation-authority.mjs";
import { deriveRunTrust } from "../lib/run-trust.mjs";

const trusted = deriveRunTrust({ integrityIssues: [] });

function requiredJudgePolicy() {
  return {
    availability: "required",
    capability: {
      judgeId: "controlled-judge",
      model: "judge-model",
      inputSchemaVersion: 2,
    },
    timeoutMs: 1_000,
    rubric: "Apply the controlled rubric.",
    projection: {
      schemaVersion: 1,
      include: {
        transcript: true,
        stderr: true,
        textArtifacts: true,
        egress: true,
        lifecycleReceipts: true,
        runTrustIssues: true,
        baselineDeterministicOutcome: true,
        effectiveDeterministicOutcome: true,
        requiredChecks: true,
        advisoryChecks: true,
      },
      limits: {
        maxEvidenceItems: 64,
        maxEvidenceItemBytes: 64 * 1024,
        maxEvidenceTextBytes: 512 * 1024,
        maxChecks: 128,
        maxRunTrustIssues: 64,
        maxInputBytes: 1024 * 1024,
      },
    },
    output: { maxSummaryBytes: 4 * 1024 },
  };
}

function profile({
  id = "deterministic-v1",
  kind = "deterministic-primary",
  defaultRule = "authored",
  rules = [],
  judge = { availability: "disabled" },
} = {}) {
  return {
    schemaVersion: 1,
    id,
    kind,
    checkPolicy: {
      defaultRule,
      rules,
      unmatchedRule: "invalidate-evaluator-output",
    },
    judge: judge.availability === "required"
      ? {
          ...requiredJudgePolicy(),
          ...judge,
          capability: {
            ...requiredJudgePolicy().capability,
            ...judge.capability,
          },
        }
      : judge,
  };
}

function check({
  id = "required-check",
  required = true,
  outcome = "pass",
  summary = `${id} returned ${outcome}.`,
} = {}) {
  return { id, required, outcome, summary, evidenceRefs: [] };
}

function judgeResult(outcome) {
  return {
    schemaVersion: 2,
    kind: "result",
    outcome,
    summary: `The rubric returned ${outcome}.`,
  };
}

const judgeCases = [
  { label: "not requested", judgeStatus: "not_requested", judge: null },
  { label: "pending", judgeStatus: "pending", judge: null },
  {
    label: "failed",
    judgeStatus: "failed",
    judge: { schemaVersion: 2, kind: "error", code: "judge.provider-failed" },
  },
  ...["pass", "fail", "incomplete"].map((outcome) => ({
    label: `complete ${outcome}`,
    judgeStatus: "complete",
    judge: judgeResult(outcome),
  })),
];

test("authority v2 hybrid requires both code and Judge without changing v1 history", () => {
  for (const schemaVersion of [1, 2]) {
    for (const outcome of ["pass", "fail", "skip"]) {
      for (const value of judgeCases) {
        const authority = { ...profile({ kind: "hybrid", judge: { availability: "required" } }), schemaVersion };
        const result = evaluateAuthority({
          taskKind: "scored", authority, runTrust: trusted,
          evaluatorStatus: "complete", checks: [check({ outcome })],
          judgeStatus: value.judgeStatus, judge: value.judge,
        });
        const expected = outcome === "fail" ? "fail" : outcome === "skip" ? "incomplete"
          : value.judgeStatus === "complete" ? value.judge.outcome
            : schemaVersion === 2 ? "incomplete" : "pass";
        assert.equal(result.headline.verdict, expected, `v${schemaVersion}: ${outcome}, Judge ${value.label}`);
        if (schemaVersion === 2 && outcome === "pass" && value.judgeStatus !== "complete") {
          assert.equal(result.headline.decidedBy, "judge");
          assert.equal(result.headline.verdictReasons[0].code, "judge.result-required");
        }
      }
    }
  }
});

test("strict hybrid preserves Run Trust and rejects unknown or non-hybrid policy versions", () => {
  const authority = { ...profile({ kind: "hybrid", judge: { availability: "required" } }), schemaVersion: 2 };
  const args = { taskKind: "scored", authority, runTrust: trusted, evaluatorStatus: "complete", checks: [check()], judgeStatus: "complete", judge: judgeResult("pass") };
  for (const status of ["incomplete", "unknown"]) {
    assert.equal(evaluateAuthority({ ...args, runTrust: { schemaVersion: 1, status, reasons: [{ code: "environment.disposal-failed", summary: "Disposal failed.", evidenceRefs: [] }] } }).headline.verdict, status);
  }
  for (const invalid of [{ ...authority, schemaVersion: 3 }, { ...authority, kind: "judge-primary" }, { ...authority, judge: { availability: "disabled" } }]) {
    assert.throws(() => evaluateAuthority({ ...args, authority: invalid }), /authority|Judge/i);
  }
});

function evaluated({
  kind,
  evaluatorStatus = "complete",
  checks,
  runTrust = trusted,
  judgeStatus = "not_requested",
  judge = null,
}) {
  return evaluateAuthority({
    taskKind: "scored",
    authority: profile({
      kind,
      id: `${kind}-v1`,
      judge: { availability: "required" },
    }),
    runTrust,
    evaluatorStatus,
    checks: checks ?? (evaluatorStatus === "complete" ? [check()] : []),
    judgeStatus,
    judge,
  });
}

test("Run Trust preserves mandatory integrity failures outside profile policy", () => {
  assert.deepEqual(
    deriveRunTrust({
      integrityIssues: [{
        code: "lifecycle.cleanup-failed",
        phase: "cleanup",
        effect: "incomplete",
        message: "Required cleanup did not complete.",
      }],
    }),
    {
      schemaVersion: 1,
      status: "incomplete",
      reasons: [{
        code: "lifecycle.cleanup-failed",
        summary: "Required cleanup did not complete.",
        evidenceRefs: [],
      }],
    },
  );
});

test("Run Trust is trusted only without issues and incomplete precedes unknown", () => {
  assert.deepEqual(deriveRunTrust({ integrityIssues: [] }), {
    schemaVersion: 1,
    status: "trusted",
    reasons: [],
  });

  const unknown = {
    code: "evidence.redaction-failed",
    phase: "capture",
    effect: "unknown",
    message: "Safe evidence could not be established.",
  };
  assert.equal(
    deriveRunTrust({ integrityIssues: [unknown] }).status,
    "unknown",
  );
  const mixed = deriveRunTrust({
    integrityIssues: [unknown, {
      code: "environment.disposal-failed",
      phase: "dispose",
      effect: "incomplete",
      message: "Environment disposal did not complete.",
    }],
  });
  assert.deepEqual(
    [mixed.status, mixed.reasons.map(({ code }) => code)],
    [
      "incomplete",
      ["evidence.redaction-failed", "environment.disposal-failed"],
    ],
  );
});

test("Run Trust rejects malformed issues instead of silently trusting them", () => {
  assert.throws(
    () => deriveRunTrust({
      integrityIssues: [{
        code: "evidence.bad-effect",
        phase: "capture",
        effect: "ignored",
        message: "This issue must not disappear.",
      }],
    }),
    /Integrity Issue effect is invalid/,
  );
});

test("authority mapping preserves baseline truth and derives effective truth", () => {
  assert.deepEqual(
    evaluateAuthority({
      taskKind: "scored",
      authority: profile({
        rules: [{ checkId: "advisory-check", rule: "required" }],
      }),
      runTrust: trusted,
      evaluatorStatus: "complete",
      checks: [
        check(),
        check({
          id: "advisory-check",
          required: false,
          outcome: "fail",
          summary: "The promoted check failed.",
        }),
      ],
      judgeStatus: "not_requested",
      judge: null,
    }),
    {
      deterministic: {
        evaluatorStatus: "complete",
        baseline: {
          verdict: "pass",
          verdictReasons: [{
            code: "deterministic.baseline.required-pass",
            summary: "All evaluator-authored required checks passed.",
            evidenceRefs: [],
          }],
        },
        effective: {
          verdict: "fail",
          verdictReasons: [{
            code: "check.advisory-check",
            summary: "The promoted check failed.",
            evidenceRefs: [],
          }],
        },
      },
      resolvedChecks: [
        {
          id: "required-check",
          authoredAuthority: "required",
          effectiveAuthority: "required",
          outcome: "pass",
          summary: "required-check returned pass.",
          evidenceRefs: [],
        },
        {
          id: "advisory-check",
          authoredAuthority: "advisory",
          effectiveAuthority: "required",
          outcome: "fail",
          summary: "The promoted check failed.",
          evidenceRefs: [],
        },
      ],
      headline: {
        verdict: "fail",
        verdictReasons: [{
          code: "check.advisory-check",
          summary: "The promoted check failed.",
          evidenceRefs: [],
        }],
        decidedBy: "effective-deterministic",
      },
    },
  );
});

test("required, advisory, and disabled are distinct effective authorities", () => {
  const result = evaluateAuthority({
    taskKind: "scored",
    authority: profile({
      rules: [
        { checkId: "authored-advisory", rule: "advisory" },
        { checkId: "authored-required", rule: "disabled" },
      ],
    }),
    runTrust: trusted,
    evaluatorStatus: "complete",
    checks: [
      check({ id: "effective-required" }),
      check({ id: "authored-required", outcome: "fail" }),
      check({ id: "authored-advisory", required: false, outcome: "fail" }),
    ],
    judgeStatus: "not_requested",
    judge: null,
  });

  assert.deepEqual(
    result.resolvedChecks.map(({ id, authoredAuthority, effectiveAuthority }) => ({
      id,
      authoredAuthority,
      effectiveAuthority,
    })),
    [
      {
        id: "effective-required",
        authoredAuthority: "required",
        effectiveAuthority: "required",
      },
      {
        id: "authored-required",
        authoredAuthority: "required",
        effectiveAuthority: "disabled",
      },
      {
        id: "authored-advisory",
        authoredAuthority: "advisory",
        effectiveAuthority: "advisory",
      },
    ],
  );
  assert.equal(result.deterministic.baseline.verdict, "fail");
  assert.equal(result.deterministic.effective.verdict, "pass");
  assert.equal(result.headline.verdict, "pass");
});

test("a check rule that matches no emitted check invalidates evaluator output", () => {
  const result = evaluateAuthority({
    taskKind: "scored",
    authority: profile({
      rules: [{ checkId: "renamed-check", rule: "required" }],
    }),
    runTrust: trusted,
    evaluatorStatus: "complete",
    checks: [check()],
    judgeStatus: "not_requested",
    judge: null,
  });

  const invalid = {
    verdict: "unknown",
    verdictReasons: [{
      code: "evaluator.check-policy-unmatched",
      summary: "Authority rules did not match emitted checks: renamed-check.",
      evidenceRefs: [],
    }],
  };
  assert.equal(result.deterministic.evaluatorStatus, "invalid_output");
  assert.deepEqual(result.deterministic.baseline, invalid);
  assert.deepEqual(result.deterministic.effective, invalid);
  assert.deepEqual(result.headline, {
    ...invalid,
    decidedBy: "effective-deterministic",
  });
  assert.equal(result.resolvedChecks.length, 1);
});

test("clean authority kinds implement every Judge state and outcome", () => {
  for (const value of judgeCases) {
    const deterministic = evaluated({
      kind: "deterministic-primary",
      ...value,
    });
    assert.deepEqual(
      [deterministic.headline.verdict, deterministic.headline.decidedBy],
      ["pass", "effective-deterministic"],
      `deterministic-primary pass with Judge ${value.label}`,
    );

    const hybrid = evaluated({ kind: "hybrid", ...value });
    assert.deepEqual(
      [hybrid.headline.verdict, hybrid.headline.decidedBy],
      value.judgeStatus === "complete"
        ? [value.judge.outcome, "judge"]
        : ["pass", "effective-deterministic"],
      `hybrid pass with Judge ${value.label}`,
    );
    if (value.judgeStatus === "complete") {
      assert.equal(
        hybrid.headline.verdictReasons[0].code,
        `judge.rubric-${value.judge.outcome}`,
      );
    }

    for (const evaluator of ["pass", "no-authoritative-checks", "absent"]) {
      const judgePrimary = evaluated({
        kind: "judge-primary",
        evaluatorStatus: evaluator === "absent" ? "not_configured" : "complete",
        checks: evaluator === "pass" ? [check()] : [],
        ...value,
      });
      assert.deepEqual(
        [judgePrimary.headline.verdict, judgePrimary.headline.decidedBy],
        value.judgeStatus === "complete"
          ? [value.judge.outcome, "judge"]
          : ["unknown", "judge"],
        `judge-primary ${evaluator} with Judge ${value.label}`,
      );
    }
  }
});

test("no effective required checks never lets hybrid or deterministic-primary delegate", () => {
  for (const kind of ["deterministic-primary", "hybrid"]) {
    for (const value of judgeCases) {
      const result = evaluated({ kind, checks: [], ...value });
      assert.deepEqual(
        [result.headline.verdict, result.headline.decidedBy],
        ["unknown", "effective-deterministic"],
        `${kind} with Judge ${value.label}`,
      );
      assert.equal(
        result.headline.verdictReasons[0].code,
        "deterministic.effective.no-authoritative-checks",
      );
    }
  }
});

test("deterministic fail and incomplete precede every profile and Judge result", () => {
  for (const kind of ["deterministic-primary", "hybrid", "judge-primary"]) {
    for (const value of judgeCases) {
      for (const [outcome, verdict] of [["fail", "fail"], ["skip", "incomplete"]]) {
        const result = evaluated({
          kind,
          checks: [check({ outcome })],
          ...value,
        });
        assert.deepEqual(
          [result.headline.verdict, result.headline.decidedBy],
          [verdict, "effective-deterministic"],
          `${kind} ${outcome} with Judge ${value.label}`,
        );
      }
    }
  }
});

test("Run Trust is a non-overridable gate after a trustworthy fail", () => {
  const trustCases = [
    {
      status: "incomplete",
      reason: {
        code: "lifecycle.cleanup-failed",
        summary: "Required cleanup did not complete.",
        evidenceRefs: [],
      },
    },
    {
      status: "unknown",
      reason: {
        code: "evidence.redaction-failed",
        summary: "Safe evidence could not be established.",
        evidenceRefs: [],
      },
    },
  ];

  for (const kind of ["deterministic-primary", "hybrid", "judge-primary"]) {
    for (const value of judgeCases) {
      for (const { status, reason } of trustCases) {
        const runTrust = { schemaVersion: 1, status, reasons: [reason] };
        const gated = evaluated({ kind, runTrust, ...value });
        assert.deepEqual(gated.headline, {
          verdict: status,
          verdictReasons: [reason],
          decidedBy: "mandatory-run-trust",
        }, `${kind} ${status} with Judge ${value.label}`);

        const failed = evaluated({
          kind,
          runTrust,
          checks: [check({ outcome: "fail" })],
          ...value,
        });
        assert.deepEqual(
          [failed.headline.verdict, failed.headline.decidedBy],
          ["fail", "effective-deterministic"],
          `${kind} trustworthy fail preserves separate ${status} trust lane`,
        );
        assert.deepEqual(runTrust.reasons, [reason]);
      }
    }
  }
});

test("universal precedence keeps incomplete ahead of unknown", () => {
  const incompleteTrust = {
    schemaVersion: 1,
    status: "incomplete",
    reasons: [{
      code: "lifecycle.cleanup-failed",
      summary: "Required cleanup did not complete.",
      evidenceRefs: [],
    }],
  };
  const unknownTrust = {
    schemaVersion: 1,
    status: "unknown",
    reasons: [{
      code: "evidence.redaction-failed",
      summary: "Safe evidence could not be established.",
      evidenceRefs: [],
    }],
  };

  const deterministicIncomplete = evaluated({
    kind: "judge-primary",
    checks: [check({ outcome: "skip" })],
    runTrust: unknownTrust,
    judgeStatus: "complete",
    judge: judgeResult("pass"),
  });
  assert.deepEqual(
    [deterministicIncomplete.headline.verdict, deterministicIncomplete.headline.decidedBy],
    ["incomplete", "effective-deterministic"],
  );

  const trustBeforeEvaluator = evaluated({
    kind: "judge-primary",
    evaluatorStatus: "invalid_output",
    runTrust: incompleteTrust,
    judgeStatus: "complete",
    judge: judgeResult("pass"),
  });
  assert.deepEqual(
    [trustBeforeEvaluator.headline.verdict, trustBeforeEvaluator.headline.decidedBy],
    ["incomplete", "mandatory-run-trust"],
  );
});

test("Evaluator failure, trust blocking, and invalid output cannot be overridden", () => {
  for (const kind of ["deterministic-primary", "hybrid", "judge-primary"]) {
    for (const value of judgeCases) {
      for (const evaluatorStatus of [
        "failed",
        "blocked_by_run_trust",
        "invalid_output",
      ]) {
        const result = evaluated({ kind, evaluatorStatus, ...value });
        assert.deepEqual(
          [
            result.deterministic.baseline.verdict,
            result.deterministic.effective.verdict,
            result.headline.verdict,
            result.headline.decidedBy,
          ],
          ["unknown", "unknown", "unknown", "effective-deterministic"],
          `${kind} ${evaluatorStatus} with Judge ${value.label}`,
        );
        assert.equal(
          result.headline.verdictReasons[0].code,
          {
            failed: "evaluator.failed",
            blocked_by_run_trust: "evaluator.blocked-by-run-trust",
            invalid_output: "evaluator.invalid-output",
          }[evaluatorStatus],
        );
      }
    }
  }
});

test("observation-only Tasks remain unknown before every scored authority lane", () => {
  const runTrust = {
    schemaVersion: 1,
    status: "incomplete",
    reasons: [{
      code: "environment.disposal-failed",
      summary: "Environment disposal did not complete.",
      evidenceRefs: [],
    }],
  };
  assert.deepEqual(evaluateAuthority({
    taskKind: "observation",
    authority: null,
    runTrust,
    evaluatorStatus: "not_configured",
    checks: [],
    judgeStatus: "not_requested",
    judge: null,
  }), {
    deterministic: {
      evaluatorStatus: "not_configured",
      baseline: null,
      effective: null,
    },
    resolvedChecks: [],
    headline: {
      verdict: "unknown",
      verdictReasons: [{
        code: "task.observation-only",
        summary: "Observation-only Tasks do not have a scored outcome.",
        evidenceRefs: [],
      }],
      decidedBy: "observation",
    },
  });
});

test("ambiguous check policy and malformed settlement states are rejected", () => {
  const base = {
    taskKind: "scored",
    authority: profile(),
    runTrust: trusted,
    evaluatorStatus: "complete",
    checks: [check()],
    judgeStatus: "not_requested",
    judge: null,
  };

  assert.throws(
    () => evaluateAuthority({
      ...base,
      checks: [check(), check()],
    }),
    /duplicate check id 'required-check'/,
  );
  assert.throws(
    () => evaluateAuthority({
      ...base,
      authority: profile({
        rules: [
          { checkId: "required-check", rule: "required" },
          { checkId: "required-check", rule: "advisory" },
        ],
      }),
    }),
    /duplicate rule for check 'required-check'/,
  );
  assert.throws(
    () => evaluateAuthority({
      ...base,
      authority: profile({
        id: "native-hybrid-v1",
        kind: "hybrid",
        judge: {
          ...requiredJudgePolicy(),
          capability: {
            ...requiredJudgePolicy().capability,
            inputSchemaVersion: 1,
          },
        },
      }),
      judgeStatus: "pending",
    }),
    /Judge policy|authority/i,
  );
  assert.throws(
    () => evaluateAuthority({
      ...base,
      authority: profile(),
      judgeStatus: "pending",
    }),
    /disabled Judge must be not_requested/,
  );
  assert.throws(
    () => evaluateAuthority({
      ...base,
      authority: profile({ kind: "hybrid", judge: { availability: "required" } }),
      judgeStatus: "complete",
      judge: null,
    }),
    /complete Judge requires a version 2 result/,
  );
  assert.throws(
    () => evaluateAuthority({
      ...base,
      evaluatorStatus: "not_configured",
    }),
    /unconfigured Evaluator cannot emit checks/,
  );
});

test("authority results are immutable without freezing caller-owned inputs", () => {
  const runTrust = { schemaVersion: 1, status: "trusted", reasons: [] };
  const details = { nested: ["evidence"] };
  const result = evaluateAuthority({
    taskKind: "scored",
    authority: profile(),
    runTrust,
    evaluatorStatus: "complete",
    checks: [{ ...check({ id: "immutable-check" }), details }],
    judgeStatus: "not_requested",
    judge: null,
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.resolvedChecks[0].details.nested), true);
  assert.equal(Object.isFrozen(runTrust), false);
  assert.equal(Object.isFrozen(details), false);
});
