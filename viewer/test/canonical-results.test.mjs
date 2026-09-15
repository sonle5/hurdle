import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createCanonicalResultsClient,
} from "../lib/canonical-results.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../../harness/test/fixtures/canonical-run-record-v2.json", import.meta.url),
  "utf8",
));
const completeRecord = fixture.history.at(-1);

function fixtureStore(record = completeRecord, evidenceBySha = new Map()) {
  return {
    async listRuns() {
      return [record];
    },
    async getRun(id) {
      return id === record.id ? record : null;
    },
    async getRunHistory() {
      throw new Error("the Viewer must not query run history");
    },
    async readEvidence(reference) {
      const bytes = evidenceBySha.get(reference.sha256);
      if (!bytes) throw new Error("the Viewer must not read unrelated evidence blobs");
      return bytes;
    },
  };
}

function recordV3() {
  return {
    ...structuredClone(completeRecord),
    schemaVersion: 3,
    snapshot: {
      ...structuredClone(completeRecord.snapshot),
      schemaVersion: 2,
      evaluation: {
        taskKind: "scored",
        deterministicEvaluator: "evaluators/exact-copy.mjs",
        authority: {
          schemaVersion: 1,
          id: "hybrid-v1",
          kind: "hybrid",
          checkPolicy: {
            defaultRule: "authored",
            rules: [{ checkId: "style-note", rule: "disabled" }],
            unmatchedRule: "invalidate-evaluator-output",
          },
          judge: {
            availability: "required",
            capability: {
              judgeId: "controlled-judge",
              model: "judge-test-model",
              inputSchemaVersion: 2,
            },
            timeoutMs: 1_000,
            rubric: "The response must copy the fixture exactly.",
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
          },
        },
      },
    },
    runTrust: { schemaVersion: 1, status: "trusted", reasons: [] },
    deterministic: {
      evaluatorStatus: "complete",
      baseline: {
        verdict: "pass",
        verdictReasons: [{
          code: "checks.required-pass",
          summary: "All evaluator-authored required checks passed.",
          evidenceRefs: [],
        }],
      },
      effective: {
        verdict: "pass",
        verdictReasons: [{
          code: "checks.required-pass",
          summary: "All selected required checks passed.",
          evidenceRefs: [],
        }],
      },
    },
    headline: {
      verdict: "pass",
      verdictReasons: structuredClone(completeRecord.verdictReasons),
      decidedBy: "effective-deterministic",
    },
    checks: completeRecord.checks.map((check) => ({
      ...check,
      authoredAuthority: check.required ? "required" : "advisory",
      effectiveAuthority: check.id === "style-note" ? "disabled" : "required",
    })).map(({ required: _required, ...check }) => check),
  };
}

function recordV3WithEvaluatorSource() {
  const source = Buffer.from([
    "export function evaluate() {",
    "  return { checks: [], targetMetrics: {} };",
    "}",
    "",
  ].join("\n"));
  const digest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  const record = recordV3();
  record.snapshot.behavior.deterministicEvaluator.modules = {
    "evaluators/exact-copy.mjs": digest,
  };
  record.evidence.structured = [{
    runId: record.id,
    key: digest.slice("sha256:".length),
    mediaType: "text/javascript; charset=utf-8",
    sizeBytes: source.byteLength,
    sha256: digest,
    provenance: "run_definition_behavior_source:evaluators%2Fexact-copy.mjs",
    authority: "controller",
    producer: "run-engine",
    lifecyclePhase: "definition",
    capturedAt: record.createdAt,
    trust: "controller_verified",
    availability: "available",
  }];
  return { record, source, digest };
}

test("the canonical client projects stored truth without reading or rescoring evidence", async () => {
  const client = createCanonicalResultsClient(fixtureStore());
  const [summary] = await client.list({ limit: 100 });
  const detail = await client.find(completeRecord.id);

  assert.equal(summary.state, "complete");
  assert.equal(summary.verdict, "pass");
  assert.equal(summary.judgeStatus, "not_requested");
  assert.equal(summary.taskId, "copy-message");
  assert.equal(summary.conditionId, "default");
  assert.equal(summary.requestedModel, "claude-sonnet-4-5");
  assert.equal(summary.observedModel, "claude-sonnet-4-5-20250929");
  assert.deepEqual(summary.checkCounts, {
    total: 2,
    required: 1,
    pass: 1,
    fail: 1,
    skip: 0,
  });
  assert.deepEqual(summary.artifactCounts, {
    total: 3,
    captured: 2,
    missing: 1,
    rejected: 0,
    contentAvailable: 1,
    contentUnavailable: 1,
  });
  assert.equal(summary.commonMetrics.toolCalls, 7);

  assert.equal(detail.summary.verdict, completeRecord.verdict);
  assert.deepEqual(detail.judge, { status: "not_requested" });
  assert.deepEqual(detail.verdictReasons, completeRecord.verdictReasons);
  assert.deepEqual(
    detail.checks.map(({ id, required, outcome }) => ({ id, required, outcome })),
    [
      { id: "exact-copy", required: true, outcome: "pass" },
      { id: "style-note", required: false, outcome: "fail" },
    ],
  );
  assert.deepEqual(
    detail.metrics.map(({ namespace, ownerId }) => ({ namespace, ownerId })),
    [
      { namespace: "common", ownerId: null },
      { namespace: "adapter", ownerId: "claude-code" },
      { namespace: "target", ownerId: "starter-target" },
    ],
  );
  assert.ok(detail.evidence.some((item) => (
    item.kind === "transcript"
    && item.reference.provenance === "controller_observed_parent_pipe"
    && item.reference.trust === "controller_observed"
  )));
  assert.ok(detail.evidence.some((item) => (
    item.kind === "egress"
    && item.reference.authority === "environment"
    && item.reference.trust === "environment-observed"
  )));
  assert.deepEqual(
    detail.artifacts.map(({
      path,
      captureStatus,
      contentAvailability,
      provenance,
      trust,
    }) => ({
      path,
      captureStatus,
      contentAvailability,
      provenance,
      trust,
    })),
    [
      {
        path: "answer.txt",
        captureStatus: "captured",
        contentAvailability: "available",
        provenance: "controller_sealed_workspace_file",
        trust: "controller_sealed",
      },
      {
        path: "missing.txt",
        captureStatus: "missing",
        contentAvailability: "not_recorded",
        provenance: "controller_sealed_workspace_file",
        trust: "controller_sealed",
      },
      {
        path: "remote-only.bin",
        captureStatus: "captured",
        contentAvailability: "unavailable",
        provenance: "controller_sealed_workspace_file",
        trust: "controller_sealed",
      },
    ],
  );
});

test("the canonical client exposes and lazily reads only snapshot-matched evaluator source", async () => {
  const { record, source, digest } = recordV3WithEvaluatorSource();
  const store = fixtureStore(record, new Map([[digest, source]]));
  const client = createCanonicalResultsClient(store);
  const detail = await client.find(record.id);

  assert.deepEqual(detail.evaluatorSources, [{
    path: "evaluators/exact-copy.mjs",
    sha256: digest,
    sizeBytes: source.byteLength,
    entry: true,
  }]);
  assert.deepEqual(
    await client.readEvaluatorSource(record.id, "evaluators/exact-copy.mjs"),
    {
      path: "evaluators/exact-copy.mjs",
      sha256: digest,
      source: source.toString("utf8"),
    },
  );

  await assert.rejects(
    () => client.readEvaluatorSource(record.id, "../secrets.env"),
    /Evaluator source is not available/,
  );
});

test("the canonical client names every stored v3 authority lane and keeps v2 lanes unavailable", async () => {
  const v3 = recordV3();
  const v3Client = createCanonicalResultsClient(fixtureStore(v3));
  const [v3Summary] = await v3Client.list();
  const v3Detail = await v3Client.find(v3.id);

  assert.deepEqual(v3Summary.authority, v3Detail.authority);
  assert.equal(v3Summary.checkCounts.required, 1);
  assert.deepEqual(v3Detail.authority, {
    kind: "profile",
    label: "hybrid-v1",
    profileId: "hybrid-v1",
    profileKind: "hybrid",
  });
  assert.deepEqual(v3Detail.runTrust, {
    availability: "recorded",
    schemaVersion: 1,
    status: "trusted",
    reasons: [],
  });
  assert.deepEqual(v3Detail.deterministicBaseline, {
    availability: "recorded",
    outcome: v3.deterministic.baseline,
  });
  assert.deepEqual(v3Detail.deterministicEffective, {
    availability: "recorded",
    outcome: v3.deterministic.effective,
  });
  assert.deepEqual(v3Detail.headline, v3.headline);
  assert.deepEqual(
    v3Detail.checks.map(({ id, authoredAuthority, effectiveAuthority }) => ({
      id,
      authoredAuthority,
      effectiveAuthority,
    })),
    [
      {
        id: "exact-copy",
        authoredAuthority: "required",
        effectiveAuthority: "required",
      },
      {
        id: "style-note",
        authoredAuthority: "advisory",
        effectiveAuthority: "disabled",
      },
    ],
  );

  const v2Detail = await createCanonicalResultsClient(
    fixtureStore(completeRecord),
  ).find(completeRecord.id);
  assert.deepEqual(v2Detail.authority, {
    kind: "legacy-v2",
    label: "Legacy canonical v2 · implicit fixed policy",
    profileId: null,
    profileKind: null,
  });
  assert.deepEqual(v2Detail.runTrust, {
    availability: "unavailable",
    reason: "not-recorded-in-v2",
  });
  assert.deepEqual(v2Detail.deterministicBaseline, {
    availability: "unavailable",
    reason: "not-recorded-in-v2",
  });
  assert.deepEqual(v2Detail.deterministicEffective, {
    availability: "unavailable",
    reason: "not-recorded-in-v2",
  });
  assert.equal(v2Detail.headline.verdict, completeRecord.verdict);
});

test("the canonical client projects typed Judge result and error without interpretation", async () => {
  const basis = {
    sourceRevision: 2,
    snapshotFingerprint: completeRecord.snapshotFingerprint,
    rubricSha256: `sha256:${"a".repeat(64)}`,
    inputSha256: `sha256:${"b".repeat(64)}`,
  };
  const resultRecord = {
    ...structuredClone(completeRecord),
    revision: 4,
    verdict: "fail",
    verdictReasons: [{
      code: "judge.rubric-fail",
      summary: "The optional Judge returned fail.",
      evidenceRefs: [],
    }],
    judgeStatus: "complete",
    judge: {
      schemaVersion: 1,
      kind: "result",
      basis,
      outcome: "fail",
      summary: "The response missed the rubric.",
      judgeId: "controlled-judge",
      model: "judge-test-model",
      startedAt: "2026-08-22T10:00:00.000Z",
      completedAt: "2026-08-22T10:00:01.000Z",
      durationMs: 1_000,
    },
  };
  const resultDetail = await createCanonicalResultsClient(
    fixtureStore(resultRecord),
  ).find(resultRecord.id);
  assert.deepEqual(resultDetail.judge, {
    status: "complete",
    result: resultRecord.judge,
  });

  const errorRecord = {
    ...resultRecord,
    verdict: completeRecord.verdict,
    verdictReasons: completeRecord.verdictReasons,
    judgeStatus: "failed",
    judge: {
      schemaVersion: 1,
      kind: "error",
      basis,
      code: "judge.provider-failed",
      message: "The optional Judge provider failed.",
      judgeId: "controlled-judge",
      model: null,
      startedAt: "2026-08-22T10:00:00.000Z",
      completedAt: "2026-08-22T10:00:01.000Z",
      durationMs: 1_000,
    },
  };
  const errorDetail = await createCanonicalResultsClient(
    fixtureStore(errorRecord),
  ).find(errorRecord.id);
  assert.deepEqual(errorDetail.judge, {
    status: "failed",
    error: errorRecord.judge,
  });

  const pendingRecord = {
    ...structuredClone(completeRecord),
    revision: 3,
    judgeStatus: "pending",
    judge: null,
  };
  const pendingDetail = await createCanonicalResultsClient(
    fixtureStore(pendingRecord),
  ).find(pendingRecord.id);
  assert.deepEqual(pendingDetail.judge, { status: "pending" });

  const v3 = recordV3();
  v3.revision = 4;
  v3.judgeStatus = "complete";
  v3.judge = {
    schemaVersion: 2,
    kind: "result",
    basis: {
      schemaVersion: 2,
      sourceRevision: 2,
      snapshotFingerprint: v3.snapshotFingerprint,
      authorityProfileId: "hybrid-v1",
      rubricSha256: `sha256:${"c".repeat(64)}`,
      inputSha256: `sha256:${"d".repeat(64)}`,
      judgeId: "controlled-judge",
      model: "judge-test-model",
    },
    outcome: "pass",
    summary: "The response satisfies the rubric.",
    judgeId: "controlled-judge",
    model: "judge-test-model",
    startedAt: "2026-08-22T10:00:00.000Z",
    completedAt: "2026-08-22T10:00:01.000Z",
    durationMs: 1_000,
  };
  const v3Detail = await createCanonicalResultsClient(
    fixtureStore(v3),
  ).find(v3.id);
  assert.deepEqual(v3Detail.judge, {
    status: "complete",
    result: v3.judge,
  });
});

test("the canonical client returns null for an unknown opaque run id", async () => {
  const client = createCanonicalResultsClient(fixtureStore());
  assert.equal(
    await client.find("run_22222222-2222-4222-8222-222222222222"),
    null,
  );
});

test("the canonical client does not mistake an unfinished v3 lane for an unconfigured evaluator", async () => {
  const queued = recordV3();
  queued.revision = 0;
  queued.state = "queued";
  queued.verdict = null;
  queued.verdictReasons = undefined;
  queued.headline = null;
  queued.runTrust = undefined;
  queued.deterministic = undefined;
  queued.checks = undefined;
  queued.execution = undefined;
  queued.completedAt = undefined;

  const detail = await createCanonicalResultsClient(fixtureStore(queued)).find(queued.id);
  assert.deepEqual(detail.runTrust, {
    availability: "unavailable",
    reason: "not-complete",
  });
  assert.deepEqual(detail.deterministicBaseline, {
    availability: "unavailable",
    reason: "not-complete",
  });
  assert.deepEqual(detail.deterministicEffective, {
    availability: "unavailable",
    reason: "not-complete",
  });
});
