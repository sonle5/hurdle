import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertRunHistory,
  assertRunTransition,
  compareRunsNewestFirst,
  jsonSemanticallyEqual,
  normalizeResultStoreQuery,
} from "../lib/result-store-policy.mjs";
import { fingerprintSnapshot, sha256 } from "../lib/run-model.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/canonical-run-record-v2.json", import.meta.url),
  "utf8",
));

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

function judgeBasis(record) {
  return {
    sourceRevision: 2,
    snapshotFingerprint: record.snapshotFingerprint,
    rubricSha256: `sha256:${"a".repeat(64)}`,
    inputSha256: `sha256:${"b".repeat(64)}`,
  };
}

function judgeResult(record, outcome = "fail") {
  return {
    schemaVersion: 1,
    kind: "result",
    basis: judgeBasis(record),
    outcome,
    summary: "The response missed a rubric requirement.",
    judgeId: "controlled-judge",
    model: "test-model",
    startedAt: "2026-08-22T10:00:00.000Z",
    completedAt: "2026-08-22T10:00:01.000Z",
    durationMs: 1_000,
  };
}

function judgeError(record) {
  return {
    schemaVersion: 1,
    kind: "error",
    basis: judgeBasis(record),
    code: "judge.provider-failed",
    message: "The optional Judge provider failed.",
    judgeId: "controlled-judge",
    model: "test-model",
    startedAt: "2026-08-22T10:00:00.000Z",
    completedAt: "2026-08-22T10:00:01.000Z",
    durationMs: 1_000,
  };
}

function deterministicV3History() {
  const history = structuredClone(fixture.history);
  const authority = {
    schemaVersion: 1,
    id: "canonical-deterministic",
    kind: "deterministic-primary",
    checkPolicy: {
      defaultRule: "authored",
      rules: [],
      unmatchedRule: "invalidate-evaluator-output",
    },
    judge: { availability: "disabled" },
  };
  for (const record of history) {
    record.schemaVersion = 3;
    record.snapshot.schemaVersion = 2;
    record.snapshot.manifestSchemaVersion = 2;
    record.snapshot.evaluation = {
      taskKind: "scored",
      deterministicEvaluator: "evaluators/exact-copy.mjs",
      authority,
    };
    record.headline = null;
    record.snapshotFingerprint = fingerprintSnapshot(record.snapshot);
  }
  const complete = history.at(-1);
  complete.runTrust = { schemaVersion: 1, status: "trusted", reasons: [] };
  complete.deterministic = {
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
      verdict: "pass",
      verdictReasons: [{
        code: "deterministic.effective.required-pass",
        summary: "All checks required by the selected authority profile passed.",
        evidenceRefs: [],
      }],
    },
  };
  complete.checks = complete.checks.map((check) => ({
    id: check.id,
    authoredAuthority: check.required ? "required" : "advisory",
    effectiveAuthority: check.required ? "required" : "advisory",
    outcome: check.outcome,
    summary: check.summary,
    evidenceRefs: check.evidenceRefs,
    ...(check.details === undefined ? {} : { details: check.details }),
  }));
  complete.headline = {
    ...structuredClone(complete.deterministic.effective),
    decidedBy: "effective-deterministic",
  };
  complete.verdict = complete.headline.verdict;
  complete.verdictReasons = complete.headline.verdictReasons;
  return history;
}

function refingerprintV3History(history) {
  for (const record of history) {
    record.snapshotFingerprint = fingerprintSnapshot(record.snapshot);
  }
  return history;
}

function judgedHybridV3History() {
  const history = deterministicV3History();
  const judge = {
    availability: "required",
    capability: {
      judgeId: "controlled-judge",
      model: "test-model",
      inputSchemaVersion: 2,
    },
    timeoutMs: 1_000,
    rubric: "The response must satisfy the controlled rubric.",
    projection: {
      schemaVersion: 1,
      include: {
        transcript: true,
        stderr: false,
        textArtifacts: true,
        egress: false,
        lifecycleReceipts: false,
        runTrustIssues: true,
        baselineDeterministicOutcome: true,
        effectiveDeterministicOutcome: true,
        requiredChecks: true,
        advisoryChecks: true,
      },
      limits: {
        maxEvidenceItems: 64,
        maxEvidenceItemBytes: 65_536,
        maxEvidenceTextBytes: 524_288,
        maxChecks: 128,
        maxRunTrustIssues: 64,
        maxInputBytes: 1_048_576,
      },
    },
    output: { maxSummaryBytes: 4_096 },
  };
  for (const record of history) {
    record.snapshot.evaluation.authority.kind = "hybrid";
    record.snapshot.evaluation.authority.judge = judge;
    record.snapshotFingerprint = fingerprintSnapshot(record.snapshot);
  }
  const complete = history.at(-1);
  const pending = {
    ...structuredClone(complete),
    revision: 3,
    judgeStatus: "pending",
    judge: null,
  };
  const terminalJudge = {
    schemaVersion: 2,
    kind: "result",
    basis: {
      schemaVersion: 2,
      sourceRevision: 2,
      snapshotFingerprint: complete.snapshotFingerprint,
      authorityProfileId: "canonical-deterministic",
      rubricSha256: sha256(Buffer.from(judge.rubric)),
      inputSha256: `sha256:${"b".repeat(64)}`,
      judgeId: "controlled-judge",
      model: "test-model",
    },
    outcome: "fail",
    summary: "The response missed the controlled rubric.",
    judgeId: "controlled-judge",
    model: "test-model",
    startedAt: "2026-08-22T10:00:00.000Z",
    completedAt: "2026-08-22T10:00:01.000Z",
    durationMs: 1_000,
  };
  const judged = {
    ...structuredClone(pending),
    revision: 4,
    judgeStatus: "complete",
    judge: terminalJudge,
    headline: {
      verdict: "fail",
      verdictReasons: [{
        code: "judge.rubric-fail",
        summary: "The required Judge returned fail.",
        evidenceRefs: [],
      }],
      decidedBy: "judge",
    },
    verdict: "fail",
    verdictReasons: [{
      code: "judge.rubric-fail",
      summary: "The required Judge returned fail.",
      evidenceRefs: [],
    }],
  };
  return [...history, pending, judged];
}

test("Run Record policy compares immutable JSON semantically after a JSONB-style reorder", () => {
  const [queued, running] = fixture.history;
  const reorderedQueued = reverseObjectKeys(queued);

  assert.equal(jsonSemanticallyEqual(queued.snapshot, reorderedQueued.snapshot), true);
  assert.equal(jsonSemanticallyEqual([1, 2], [2, 1]), false);
  assert.doesNotThrow(() => assertRunTransition(reorderedQueued, running));
  assert.deepEqual(assertRunHistory(fixture.history, queued.id), fixture.history);
});

test("Run Record policy normalizes pre-Judge v2 histories without mutating them", () => {
  const preJudgeHistory = structuredClone(fixture.history);
  for (const record of preJudgeHistory) delete record.judge;

  assert.deepEqual(
    assertRunHistory(preJudgeHistory, preJudgeHistory[0].id),
    fixture.history,
  );
  assert.equal(Object.hasOwn(preJudgeHistory[0], "judge"), false);
});

test("Run Record v3 completion is validated by the stored authority definition", () => {
  const history = deterministicV3History();
  assert.deepEqual(assertRunHistory(history, history[0].id), history);

  const falseFingerprint = structuredClone(history);
  for (const record of falseFingerprint) {
    record.snapshotFingerprint = `sha256:${"f".repeat(64)}`;
  }
  assert.throws(
    () => assertRunHistory(falseFingerprint, falseFingerprint[0].id),
    /snapshot fingerprint/i,
  );

  const incompleteJudgePolicy = structuredClone(history);
  for (const record of incompleteJudgePolicy) {
    record.snapshot.evaluation.authority.kind = "hybrid";
    record.snapshot.evaluation.authority.judge = { availability: "required" };
  }
  refingerprintV3History(incompleteJudgePolicy);
  assert.throws(
    () => assertRunHistory(incompleteJudgePolicy.slice(0, 1), incompleteJudgePolicy[0].id),
    /Judge policy|authority/i,
  );
  assert.throws(
    () => assertRunHistory(incompleteJudgePolicy.slice(0, 2), incompleteJudgePolicy[0].id),
    /Judge policy|authority/i,
  );

  const nativeInputV1 = structuredClone(judgedHybridV3History().slice(0, 1));
  nativeInputV1[0].snapshot.evaluation.authority.judge.capability.inputSchemaVersion = 1;
  refingerprintV3History(nativeInputV1);
  assert.throws(
    () => assertRunHistory(nativeInputV1, nativeInputV1[0].id),
    /Judge policy|authority/i,
  );

  const mismatchedCompatibility = structuredClone(nativeInputV1);
  mismatchedCompatibility[0].snapshot.manifestSchemaVersion = 1;
  mismatchedCompatibility[0].snapshot.evaluation.authority.id = "v1-compat-hybrid";
  mismatchedCompatibility[0].snapshot.evaluation.authority.kind = "judge-primary";
  refingerprintV3History(mismatchedCompatibility);
  assert.throws(
    () => assertRunHistory(mismatchedCompatibility, mismatchedCompatibility[0].id),
    /Judge policy|authority/i,
  );

  const forgedCompatibility = structuredClone(nativeInputV1);
  forgedCompatibility[0].snapshot.evaluation.authority.id = "v1-compat-hybrid";
  refingerprintV3History(forgedCompatibility);
  assert.throws(
    () => assertRunHistory(forgedCompatibility, forgedCompatibility[0].id),
    /RunPlan v2 authority/i,
  );

  const impossibleJudgePrimaryCompatibility = structuredClone(nativeInputV1);
  impossibleJudgePrimaryCompatibility[0].snapshot.manifestSchemaVersion = 1;
  impossibleJudgePrimaryCompatibility[0].snapshot.evaluation.authority.id =
    "v1-compat-judge-primary";
  impossibleJudgePrimaryCompatibility[0].snapshot.evaluation.authority.kind =
    "judge-primary";
  refingerprintV3History(impossibleJudgePrimaryCompatibility);
  assert.throws(
    () => assertRunHistory(
      impossibleJudgePrimaryCompatibility,
      impossibleJudgePrimaryCompatibility[0].id,
    ),
    /RunPlan v1 compatibility authority/i,
  );

  const versionedCompatibility = structuredClone(nativeInputV1);
  versionedCompatibility[0].snapshot.manifestSchemaVersion = 1;
  versionedCompatibility[0].snapshot.evaluation.authority.id = "v1-compat-hybrid";
  versionedCompatibility[0].snapshot.evaluation.authority.schemaVersion = 2;
  refingerprintV3History(versionedCompatibility);
  assert.throws(() => assertRunHistory(versionedCompatibility, versionedCompatibility[0].id), /RunPlan v1 compatibility authority/i);

  const inventedCompatibilityPolicy = structuredClone(nativeInputV1);
  inventedCompatibilityPolicy[0].snapshot.manifestSchemaVersion = 1;
  inventedCompatibilityPolicy[0].snapshot.evaluation.authority.id = "v1-compat-hybrid";
  inventedCompatibilityPolicy[0].snapshot.evaluation.authority.checkPolicy = {
    defaultRule: "disabled",
    rules: [{ checkId: "fabricated", rule: "required" }],
    unmatchedRule: "invalidate-evaluator-output",
  };
  inventedCompatibilityPolicy[0].snapshot.evaluation.authority.judge.projection.include =
    Object.fromEntries(
      Object.keys(
        inventedCompatibilityPolicy[0].snapshot.evaluation.authority.judge.projection.include,
      ).map((key) => [key, false]),
    );
  inventedCompatibilityPolicy[0].snapshot.evaluation.authority.judge.projection.limits = {
    maxEvidenceItems: 1,
    maxEvidenceItemBytes: 1,
    maxEvidenceTextBytes: 1,
    maxChecks: 1,
    maxRunTrustIssues: 1,
    maxInputBytes: 1,
  };
  inventedCompatibilityPolicy[0].snapshot.evaluation.authority.judge.output.maxSummaryBytes = 1;
  refingerprintV3History(inventedCompatibilityPolicy);
  assert.throws(
    () => assertRunHistory(inventedCompatibilityPolicy, inventedCompatibilityPolicy[0].id),
    /RunPlan v1 compatibility authority/i,
  );

  const invalidEvaluator = structuredClone(judgedHybridV3History().slice(0, 1));
  invalidEvaluator[0].snapshot.evaluation.authority.kind = "judge-primary";
  invalidEvaluator[0].snapshot.evaluation.deterministicEvaluator = 42;
  refingerprintV3History(invalidEvaluator);
  assert.throws(
    () => assertRunHistory(invalidEvaluator, invalidEvaluator[0].id),
    /Deterministic Evaluator/i,
  );

  const tampered = structuredClone(history);
  tampered.at(-1).deterministic.effective.verdict = "fail";
  assert.throws(
    () => assertRunHistory(tampered, tampered[0].id),
    /authority|deterministic|headline/i,
  );

  const prematureHeadline = structuredClone(history);
  prematureHeadline[1].headline = history.at(-1).headline;
  assert.throws(
    () => assertRunHistory(prematureHeadline, prematureHeadline[0].id),
    /running|headline|Record v3/i,
  );

  const prematureChecks = structuredClone(history);
  prematureChecks[1].checks = history.at(-1).checks;
  assert.throws(
    () => assertRunHistory(prematureChecks, prematureChecks[0].id),
    /running|completed outcome|Record v3/i,
  );
});

test("Run Record v3 Judge history is exactly revision 2 to 3 to 4", () => {
  const history = judgedHybridV3History();
  assert.deepEqual(assertRunHistory(history, history[0].id), history);

  assert.throws(
    () => assertRunHistory([...history.slice(0, 3), history[4]], history[0].id),
    /revision history|advance by one/,
  );
  assert.throws(
    () => assertRunTransition(history[2], {
      ...history[3],
      deterministic: {
        ...history[3].deterministic,
        effective: { verdict: "unknown", verdictReasons: [] },
      },
    }),
    /execution-complete fields cannot change/,
  );
  assert.throws(
    () => assertRunTransition(history[3], {
      ...history[4],
      headline: history[3].headline,
      verdict: history[3].verdict,
      verdictReasons: history[3].verdictReasons,
    }),
    /authority lanes|headline/i,
  );

  for (const judge of [
    {
      ...structuredClone(history[4].judge),
      basis: {
        ...structuredClone(history[4].judge.basis),
        authorityProfileId: "another-profile",
      },
    },
    {
      ...structuredClone(history[4].judge),
      judgeId: "another-judge",
    },
    {
      ...structuredClone(history[4].judge),
      basis: {
        ...structuredClone(history[4].judge.basis),
        rubricSha256: `sha256:${"f".repeat(64)}`,
      },
    },
    {
      ...structuredClone(history[4].judge),
      rawProviderResponse: "must never be persisted",
    },
  ]) {
    assert.throws(
      () => assertRunTransition(history[3], {
        ...structuredClone(history[4]),
        judge,
      }),
      /Judge payload/i,
    );
  }
});

test("Run Record v3 applies the profile summary bound only to Judge results", () => {
  const history = judgedHybridV3History();
  for (const record of history) {
    record.snapshot.evaluation.authority.judge.output.maxSummaryBytes = 1;
  }
  refingerprintV3History(history);
  history[4].judge.basis.snapshotFingerprint = history[4].snapshotFingerprint;

  assert.throws(
    () => assertRunTransition(history[3], history[4]),
    /completed Run Record v3 Judge payload/i,
  );

  const failed = {
    ...structuredClone(history[3]),
    revision: 4,
    judgeStatus: "failed",
    judge: {
      schemaVersion: 2,
      kind: "error",
      basis: {
        ...structuredClone(history[4].judge.basis),
        snapshotFingerprint: history[3].snapshotFingerprint,
      },
      code: "judge.provider-failed",
      message: "The required Judge provider failed.",
      judgeId: "controlled-judge",
      model: "test-model",
      startedAt: "2026-08-22T10:00:00.000Z",
      completedAt: "2026-08-22T10:00:01.000Z",
      durationMs: 1_000,
    },
  };
  assert.doesNotThrow(() => assertRunTransition(history[3], failed));
});

test("Run Record v3 permits an interrupted pending prefix and stores Judge failure without retrying policy", () => {
  const completed = judgedHybridV3History();
  const pendingHistory = completed.slice(0, 4);
  assert.deepEqual(
    assertRunHistory(pendingHistory, pendingHistory[0].id),
    pendingHistory,
  );

  const pending = pendingHistory.at(-1);
  const failed = {
    ...structuredClone(pending),
    revision: 4,
    judgeStatus: "failed",
    judge: {
      schemaVersion: 2,
      kind: "error",
      basis: structuredClone(completed.at(-1).judge.basis),
      code: "judge.provider-failed",
      message: "The required Judge provider failed.",
      judgeId: "controlled-judge",
      model: "test-model",
      startedAt: "2026-08-22T10:00:00.000Z",
      completedAt: "2026-08-22T10:00:01.000Z",
      durationMs: 1_000,
    },
  };
  assert.doesNotThrow(() => assertRunHistory(
    [...pendingHistory, failed],
    pendingHistory[0].id,
  ));

  const disabled = deterministicV3History();
  assert.throws(
    () => assertRunTransition(disabled.at(-1), {
      ...structuredClone(disabled.at(-1)),
      revision: 3,
      judgeStatus: "pending",
      judge: null,
    }),
    /disabled Judge/,
  );
});

test("Run Record policy rejects gaps and changed immutable invocation data", () => {
  const [queued, running, complete] = fixture.history;

  assert.throws(
    () => assertRunHistory([queued, complete], queued.id),
    /revision history|advance by one/,
  );
  assert.throws(
    () => assertRunTransition(running, {
      ...complete,
      invocation: { ...complete.invocation, ordinal: 99 },
    }),
    /invocation cannot change/,
  );
});

test("Run Record policy permits only bounded post-complete Judge revisions", () => {
  const complete = structuredClone(fixture.history.at(-1));
  const pending = {
    ...complete,
    revision: complete.revision + 1,
    judgeStatus: "pending",
    judge: null,
  };
  const judged = {
    ...pending,
    revision: pending.revision + 1,
    judgeStatus: "complete",
    judge: judgeResult(complete),
    verdict: "fail",
    verdictReasons: [{
      code: "judge.rubric-fail",
      summary: "The optional Judge returned fail.",
      evidenceRefs: [],
    }],
  };

  assert.doesNotThrow(() => assertRunTransition(complete, pending));
  assert.doesNotThrow(() => assertRunTransition(pending, judged));
  assert.throws(
    () => assertRunTransition(pending, {
      ...judged,
      execution: { ...judged.execution, durationMs: 1 },
    }),
    /execution-complete fields cannot change/,
  );
  assert.throws(
    () => assertRunTransition(pending, {
      ...pending,
      revision: pending.revision + 1,
      judgeStatus: "failed",
      judge: judgeError(complete),
      verdict: "unknown",
    }),
    /failed Judge cannot change the deterministic verdict/,
  );
  assert.throws(
    () => assertRunTransition(
      { ...pending, verdict: "fail", verdictReasons: judged.verdictReasons },
      { ...judged, verdict: "pass", verdictReasons: [] },
    ),
    /cannot override a deterministic non-pass verdict/,
  );
  assert.throws(
    () => assertRunTransition(pending, {
      ...judged,
      judge: { outcome: "fail", summary: "Legacy opaque payload." },
    }),
    /Judge payload/,
  );
  assert.throws(
    () => assertRunTransition(pending, {
      ...judged,
      judge: {
        ...judged.judge,
        rawProviderResponse: "must not be persisted",
      },
    }),
    /Judge payload/,
  );
});

test("Run Record policy permits only the narrow clean Judge-only transition", () => {
  const deterministic = structuredClone(fixture.history.at(-1));
  deterministic.snapshot.task.judge = { rubric: "Apply the rubric." };
  deterministic.snapshot.task.observationOnly = false;
  deterministic.snapshot.behavior.deterministicEvaluator = null;
  deterministic.checks = [];
  deterministic.integrityIssues = [];
  deterministic.verdict = "unknown";
  deterministic.verdictReasons = [];
  const pending = {
    ...deterministic,
    revision: 3,
    judgeStatus: "pending",
    judge: null,
  };
  const judged = {
    ...pending,
    revision: 4,
    judgeStatus: "complete",
    judge: judgeResult(deterministic, "pass"),
    verdict: "pass",
    verdictReasons: [{
      code: "judge.rubric-pass",
      summary: "The optional Judge returned pass.",
      evidenceRefs: [],
    }],
  };

  assert.doesNotThrow(() => assertRunTransition(deterministic, pending));
  assert.doesNotThrow(() => assertRunTransition(pending, judged));
  assert.throws(
    () => assertRunTransition(
      {
        ...pending,
        integrityIssues: [{
          code: "run.execution-failed",
          phase: "execute",
          effect: "incomplete",
          message: "Execution failed.",
        }],
      },
      {
        ...judged,
        integrityIssues: [{
          code: "run.execution-failed",
          phase: "execute",
          effect: "incomplete",
          message: "Execution failed.",
        }],
      },
    ),
    /cannot override a deterministic non-pass verdict/,
  );
});

test("Result Store query policy is bounded by input validity and has stable tie ordering", () => {
  assert.deepEqual(normalizeResultStoreQuery(), { limit: 100, targetId: undefined });
  assert.deepEqual(normalizeResultStoreQuery({ limit: 0 }), {
    limit: 0,
    targetId: undefined,
  });
  assert.deepEqual(normalizeResultStoreQuery({ limit: 5, targetId: "starter-target" }), {
    limit: 5,
    targetId: "starter-target",
  });
  assert.throws(() => normalizeResultStoreQuery({ limit: -1 }), /non-negative safe integer/);
  assert.throws(() => normalizeResultStoreQuery({ targetId: "" }), /non-empty string/);
  assert.throws(() => normalizeResultStoreQuery({ unexpected: true }), /unknown field/);

  const left = { id: "run_11111111-1111-4111-8111-111111111111", createdAt: "2026-01-01T00:00:00.000Z" };
  const right = { id: "run_22222222-2222-4222-8222-222222222222", createdAt: left.createdAt };
  assert.ok(compareRunsNewestFirst(left, right) > 0);
});
