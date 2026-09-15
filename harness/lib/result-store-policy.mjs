import {
  deepFreeze,
  deriveRunOutcome,
  fingerprintSnapshot,
  sha256,
} from "./run-model.mjs";
import {
  assertEvaluationAuthority,
  evaluateAuthority,
} from "./evaluation-authority.mjs";
import { assertV1CompatibilityAuthority } from "./authority-profile.mjs";
import { deriveRunTrust } from "./run-trust.mjs";

const RUN_ID_PATTERN = /^run_[a-f0-9-]{36}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const V3_COMPLETION_FIELDS = [
  "verdictReasons",
  "completedAt",
  "execution",
  "metrics",
  "integrityIssues",
  "evidence",
  "checks",
  "runTrust",
  "deterministic",
];
const RESULT_STORE_QUERY_FIELDS = new Set(["limit", "targetId"]);
const JUDGE_ERROR_CODES = new Set([
  "judge.cancelled",
  "judge.timed-out",
  "judge.provider-failed",
  "judge.invalid-output",
  "judge.input-unavailable",
]);

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key])]),
    );
  }
  return value;
}

export function jsonSemanticallyEqual(left, right) {
  return JSON.stringify(canonicalizeJson(left)) === JSON.stringify(canonicalizeJson(right));
}

export function assertRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new TypeError("run id is invalid");
  }
}

export function assertInitialRunRecord(record) {
  assertRunId(record?.id);
  if (
    ![2, 3].includes(record.schemaVersion)
    || record.state !== "queued"
    || record.revision !== 0
    || record.verdict !== null
    || record.judgeStatus !== "not_requested"
    || record.judge !== null
    || (record.schemaVersion === 2 && record.snapshot?.schemaVersion !== 1)
    || (record.schemaVersion === 3 && (
      record.snapshot?.schemaVersion !== 2
      || record.headline !== null
      || Object.hasOwn(record, "startedAt")
      || hasAnyOwn(record, V3_COMPLETION_FIELDS)
    ))
  ) {
    throw new TypeError("initial Run Record must be queued revision 0");
  }
  if (
    record.schemaVersion === 3
    && (
      !FINGERPRINT_PATTERN.test(record.snapshotFingerprint ?? "")
      || record.snapshotFingerprint !== fingerprintSnapshot(record.snapshot)
    )
  ) {
    throw new TypeError("Run Record v3 snapshot fingerprint is invalid");
  }
  if (record.schemaVersion === 3) {
    const evaluation = record.snapshot.evaluation;
    const manifestSchemaVersion = record.snapshot.manifestSchemaVersion;
    if (
      ![1, 2].includes(manifestSchemaVersion)
      || !evaluation
      || !["scored", "observation"].includes(evaluation.taskKind)
      || !Object.hasOwn(evaluation, "deterministicEvaluator")
      || !Object.hasOwn(evaluation, "authority")
    ) {
      throw new TypeError("Run Record v3 stored evaluation plan is invalid");
    }
    if (evaluation.taskKind === "observation") {
      if (evaluation.deterministicEvaluator !== null || evaluation.authority !== null) {
        throw new TypeError("Run Record v3 observation plan cannot configure evaluation authority");
      }
    } else {
      assertEvaluationAuthority(evaluation.authority);
      const judge = evaluation.authority.judge;
      if (!(
        evaluation.deterministicEvaluator === null
        || (
          typeof evaluation.deterministicEvaluator === "string"
          && evaluation.deterministicEvaluator.trim()
        )
      )) {
        throw new TypeError("Run Record v3 Deterministic Evaluator is invalid");
      }
      if (manifestSchemaVersion === 1) {
        assertV1CompatibilityAuthority(
          evaluation.authority,
          evaluation.deterministicEvaluator,
        );
      }
      if (
        manifestSchemaVersion === 2
        && (
          evaluation.authority.id.startsWith("v1-compat-")
          || (
            judge.availability === "required"
            && judge.capability.inputSchemaVersion !== 2
          )
        )
      ) {
        throw new TypeError("Run Record v3 RunPlan v2 authority is invalid");
      }
      if (
        ["hybrid", "deterministic-primary"].includes(evaluation.authority.kind)
        && evaluation.deterministicEvaluator === null
      ) {
        throw new TypeError("Run Record v3 stored authority requires a Deterministic Evaluator");
      }
    }
  }
}

function executionCompleteFieldsV2(record) {
  const {
    revision: _revision,
    verdict: _verdict,
    verdictReasons: _verdictReasons,
    judgeStatus: _judgeStatus,
    judge: _judge,
    ...fields
  } = record;
  return fields;
}

function executionCompleteFieldsV3(record) {
  const {
    revision: _revision,
    headline: _headline,
    verdict: _verdict,
    verdictReasons: _verdictReasons,
    judgeStatus: _judgeStatus,
    judge: _judge,
    ...fields
  } = record;
  return fields;
}

function boundedString(value, maxBytes, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.trim() && Buffer.byteLength(value) <= maxBytes;
}

function hasExactlyKeys(value, expectedKeys) {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && keys.every((key) => expectedKeys.includes(key));
}

function hasAnyOwn(value, keys) {
  return keys.some((key) => Object.hasOwn(value, key));
}

function assertJudgePayload(record, status) {
  const value = record.judge;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("terminal Judge payload is invalid");
  }
  if (
    value.schemaVersion !== 1
    || !value.basis
    || typeof value.basis !== "object"
    || Array.isArray(value.basis)
    || !hasExactlyKeys(value.basis, [
      "sourceRevision",
      "snapshotFingerprint",
      "rubricSha256",
      "inputSha256",
    ])
    || value.basis.sourceRevision !== 2
    || value.basis.snapshotFingerprint !== record.snapshotFingerprint
    || !FINGERPRINT_PATTERN.test(value.basis.rubricSha256 ?? "")
    || !FINGERPRINT_PATTERN.test(value.basis.inputSha256 ?? "")
    || !boundedString(value.judgeId, 256)
    || !boundedString(value.model, 256, { nullable: true })
    || typeof value.startedAt !== "string"
    || !Number.isFinite(Date.parse(value.startedAt))
    || typeof value.completedAt !== "string"
    || !Number.isFinite(Date.parse(value.completedAt))
    || Date.parse(value.completedAt) < Date.parse(value.startedAt)
    || !Number.isFinite(value.durationMs)
    || value.durationMs < 0
  ) {
    throw new TypeError("terminal Judge payload is invalid");
  }
  if (
    status === "complete"
    && (
      !hasExactlyKeys(value, [
        "schemaVersion",
        "kind",
        "basis",
        "outcome",
        "summary",
        "judgeId",
        "model",
        "startedAt",
        "completedAt",
        "durationMs",
      ])
      || value.kind !== "result"
      || !["pass", "fail", "incomplete"].includes(value.outcome)
      || !boundedString(value.summary, 4 * 1024)
    )
  ) {
    throw new TypeError("completed Judge payload is invalid");
  }
  if (
    status === "failed"
    && (
      !hasExactlyKeys(value, [
        "schemaVersion",
        "kind",
        "basis",
        "code",
        "message",
        "judgeId",
        "model",
        "startedAt",
        "completedAt",
        "durationMs",
      ])
      || value.kind !== "error"
      || !JUDGE_ERROR_CODES.has(value.code)
      || !boundedString(value.message, 4 * 1024)
    )
  ) {
    throw new TypeError("failed Judge payload is invalid");
  }
}

function assertJudgeTransitionV2(current, next) {
  if (!jsonSemanticallyEqual(executionCompleteFieldsV2(current), executionCompleteFieldsV2(next))) {
    throw new TypeError("execution-complete fields cannot change during Judge revisions");
  }
  const allowed = (
    current.judgeStatus === "not_requested" && next.judgeStatus === "pending"
  ) || (
    current.judgeStatus === "pending"
    && ["complete", "failed"].includes(next.judgeStatus)
  );
  if (!allowed) {
    throw new TypeError(`illegal Judge Status transition: ${current.judgeStatus} -> ${next.judgeStatus}`);
  }
  if (next.judgeStatus === "pending" && next.judge !== null) {
    throw new TypeError("pending Judge revision cannot contain Judge output");
  }
  if (
    ["complete", "failed"].includes(next.judgeStatus)
  ) {
    assertJudgePayload(next, next.judgeStatus);
  }
  if (
    next.judgeStatus !== "complete"
    && (
      next.verdict !== current.verdict
      || !jsonSemanticallyEqual(next.verdictReasons, current.verdictReasons)
    )
  ) {
    throw new TypeError(`${next.judgeStatus} Judge cannot change the deterministic verdict`);
  }
  if (
    next.judgeStatus === "complete"
    && !jsonSemanticallyEqual(
      {
        verdict: next.verdict,
        verdictReasons: next.verdictReasons,
      },
      deriveRunOutcome({
        snapshot: current.snapshot,
        checks: current.checks,
        integrityIssues: current.integrityIssues,
        evaluatorStatus: current.snapshot.behavior.deterministicEvaluator === null
          ? "not_requested"
          : "complete",
        deterministicOutcome: {
          verdict: current.verdict,
          verdictReasons: current.verdictReasons,
        },
        judgeOutcome: next.judge.outcome,
      }),
    )
  ) {
    throw new TypeError("completed Judge cannot override a deterministic non-pass verdict");
  }
}

function assertJudgePayloadV3(record, status) {
  const value = record.judge;
  const authority = record.snapshot.evaluation.authority;
  const configuredJudge = authority?.judge;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.schemaVersion !== 2
    || !value.basis
    || typeof value.basis !== "object"
    || Array.isArray(value.basis)
    || !hasExactlyKeys(value.basis, [
      "schemaVersion",
      "sourceRevision",
      "snapshotFingerprint",
      "authorityProfileId",
      "rubricSha256",
      "inputSha256",
      "judgeId",
      "model",
    ])
    || value.basis.schemaVersion !== 2
    || value.basis.sourceRevision !== 2
    || value.basis.snapshotFingerprint !== record.snapshotFingerprint
    || value.basis.authorityProfileId !== authority?.id
    || !FINGERPRINT_PATTERN.test(value.basis.rubricSha256 ?? "")
    || value.basis.rubricSha256 !== sha256(Buffer.from(configuredJudge?.rubric ?? ""))
    || !FINGERPRINT_PATTERN.test(value.basis.inputSha256 ?? "")
    || configuredJudge?.availability !== "required"
    || value.basis.judgeId !== configuredJudge.capability.judgeId
    || value.basis.model !== configuredJudge.capability.model
    || value.judgeId !== value.basis.judgeId
    || value.model !== value.basis.model
    || !boundedString(value.judgeId, 256)
    || !boundedString(value.model, 256, { nullable: true })
    || typeof value.startedAt !== "string"
    || !Number.isFinite(Date.parse(value.startedAt))
    || typeof value.completedAt !== "string"
    || !Number.isFinite(Date.parse(value.completedAt))
    || Date.parse(value.completedAt) < Date.parse(value.startedAt)
    || !Number.isFinite(value.durationMs)
    || value.durationMs < 0
  ) {
    throw new TypeError("terminal Run Record v3 Judge payload is invalid");
  }
  const maxSummaryBytes = Math.min(configuredJudge.output.maxSummaryBytes, 4 * 1024);
  if (
    status === "complete"
    && (
      !hasExactlyKeys(value, [
        "schemaVersion",
        "kind",
        "basis",
        "outcome",
        "summary",
        "judgeId",
        "model",
        "startedAt",
        "completedAt",
        "durationMs",
      ])
      || value.kind !== "result"
      || !["pass", "fail", "incomplete"].includes(value.outcome)
      || !boundedString(value.summary, maxSummaryBytes)
    )
  ) {
    throw new TypeError("completed Run Record v3 Judge payload is invalid");
  }
  if (
    status === "failed"
    && (
      !hasExactlyKeys(value, [
        "schemaVersion",
        "kind",
        "basis",
        "code",
        "message",
        "judgeId",
        "model",
        "startedAt",
        "completedAt",
        "durationMs",
      ])
      || value.kind !== "error"
      || !JUDGE_ERROR_CODES.has(value.code)
      || !boundedString(value.message, 4 * 1024)
    )
  ) {
    throw new TypeError("failed Run Record v3 Judge payload is invalid");
  }
}

function rawEvaluatorChecks(checks) {
  return checks.map((check) => ({
    id: check.id,
    required: check.authoredAuthority === "required",
    outcome: check.outcome,
    summary: check.summary,
    evidenceRefs: [...check.evidenceRefs],
    ...(check.details === undefined
      ? {}
      : { details: structuredClone(check.details) }),
  }));
}

function assertCompleteRunRecordV3(record) {
  if (
    record.state !== "complete"
    || record.snapshot?.schemaVersion !== 2
    || ![2, 3, 4].includes(record.revision)
    || !record.headline
    || record.verdict !== record.headline.verdict
    || !jsonSemanticallyEqual(record.verdictReasons, record.headline.verdictReasons)
    || !record.runTrust
    || !record.deterministic
    || !Array.isArray(record.integrityIssues)
    || !Array.isArray(record.checks)
  ) {
    throw new TypeError("complete Run Record v3 is invalid");
  }
  const revisionStateIsValid = (
    record.revision === 2
    && record.judgeStatus === "not_requested"
    && record.judge === null
  ) || (
    record.revision === 3
    && record.judgeStatus === "pending"
    && record.judge === null
  ) || (
    record.revision === 4
    && ["complete", "failed"].includes(record.judgeStatus)
  );
  if (!revisionStateIsValid) {
    throw new TypeError("Run Record v3 revision does not match Judge Status");
  }
  if (record.revision === 4) {
    assertJudgePayloadV3(record, record.judgeStatus);
  }
  const runTrust = deriveRunTrust({ integrityIssues: record.integrityIssues });
  if (!jsonSemanticallyEqual(record.runTrust, runTrust)) {
    throw new TypeError("Run Record v3 Run Trust does not match integrity facts");
  }
  const evaluated = evaluateAuthority({
    taskKind: record.snapshot.evaluation.taskKind,
    authority: record.snapshot.evaluation.authority,
    runTrust,
    evaluatorStatus: record.deterministic.evaluatorStatus,
    checks: rawEvaluatorChecks(record.checks),
    judgeStatus: record.judgeStatus,
    judge: record.judge,
  });
  if (
    !jsonSemanticallyEqual(record.deterministic, evaluated.deterministic)
    || !jsonSemanticallyEqual(record.checks, evaluated.resolvedChecks)
    || !jsonSemanticallyEqual(record.headline, evaluated.headline)
  ) {
    throw new TypeError("Run Record v3 authority lanes do not match the snapshotted policy");
  }
}

function assertRunningRunRecordV3(record) {
  if (
    record.state !== "running"
    || record.revision !== 1
    || record.headline !== null
    || record.verdict !== null
    || record.judgeStatus !== "not_requested"
    || record.judge !== null
    || typeof record.startedAt !== "string"
    || !Number.isFinite(Date.parse(record.startedAt))
    || hasAnyOwn(record, V3_COMPLETION_FIELDS)
  ) {
    throw new TypeError("running Run Record v3 cannot contain completed outcome lanes");
  }
}

function assertJudgeTransitionV3(current, next) {
  if (!jsonSemanticallyEqual(
    executionCompleteFieldsV3(current),
    executionCompleteFieldsV3(next),
  )) {
    throw new TypeError("execution-complete fields cannot change during Judge revisions");
  }
  if (current.snapshot.evaluation.authority?.judge?.availability !== "required") {
    throw new TypeError("a disabled Judge cannot add Run Record revisions");
  }
  const allowed = (
    current.revision === 2
    && current.judgeStatus === "not_requested"
    && next.revision === 3
    && next.judgeStatus === "pending"
  ) || (
    current.revision === 3
    && current.judgeStatus === "pending"
    && next.revision === 4
    && ["complete", "failed"].includes(next.judgeStatus)
  );
  if (!allowed) {
    throw new TypeError(
      `illegal Run Record v3 Judge transition: ${current.judgeStatus} -> ${next.judgeStatus}`,
    );
  }
  if (
    next.revision === 3
    && (
      next.judge !== null
      || !jsonSemanticallyEqual(next.headline, current.headline)
      || next.verdict !== current.verdict
      || !jsonSemanticallyEqual(next.verdictReasons, current.verdictReasons)
    )
  ) {
    throw new TypeError("pending Judge revision cannot change the stored headline");
  }
  assertCompleteRunRecordV3(next);
}

export function assertRunTransition(current, next) {
  if (next.id !== current.id) throw new TypeError("run id cannot change");
  if (next.revision !== current.revision + 1) {
    throw new TypeError("run revision must advance by one");
  }
  if (next.snapshotFingerprint !== current.snapshotFingerprint) {
    throw new TypeError("snapshot fingerprint cannot change");
  }
  if (!jsonSemanticallyEqual(next.snapshot, current.snapshot)) {
    throw new TypeError("Run Definition Snapshot cannot change");
  }
  if (next.schemaVersion !== current.schemaVersion) {
    throw new TypeError("run schema version cannot change");
  }
  if (next.experimentVersion !== current.experimentVersion) {
    throw new TypeError("Experiment Version cannot change");
  }
  if (next.createdAt !== current.createdAt) {
    throw new TypeError("run creation time cannot change");
  }
  if (!jsonSemanticallyEqual(next.invocation, current.invocation)) {
    throw new TypeError("run invocation cannot change");
  }
  if (current.state === "complete" && next.state === "complete") {
    if (current.schemaVersion === 2) {
      assertJudgeTransitionV2(current, next);
    } else {
      assertJudgeTransitionV3(current, next);
    }
    return;
  }
  if (
    !(
      (current.state === "queued" && next.state === "running")
      || (current.state === "running" && next.state === "complete")
    )
  ) throw new TypeError(`illegal Run State transition: ${current.state} -> ${next.state}`);
  if (next.schemaVersion === 3) {
    if (next.state === "running") assertRunningRunRecordV3(next);
    if (next.state === "complete") assertCompleteRunRecordV3(next);
  }
}

export function assertRunHistory(records, expectedRunId) {
  assertRunId(expectedRunId);
  const normalizedRecords = records.map(normalizeRunRecord);
  if (normalizedRecords.length > 0) assertInitialRunRecord(normalizedRecords[0]);
  for (const [revision, record] of normalizedRecords.entries()) {
    if (record.id !== expectedRunId || record.revision !== revision) {
      throw new Error(`Run '${expectedRunId}' has an invalid revision history`);
    }
    if (revision > 0) assertRunTransition(normalizedRecords[revision - 1], record);
  }
  return deepFreeze(normalizedRecords);
}

export function normalizeResultStoreQuery(query = {}) {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new TypeError("Result Store query must be an object");
  }
  for (const key of Object.keys(query)) {
    if (!RESULT_STORE_QUERY_FIELDS.has(key)) {
      throw new TypeError(`Result Store query has unknown field '${key}'`);
    }
  }
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("Result Store query limit must be a non-negative safe integer");
  }
  const targetId = query.targetId;
  if (targetId !== undefined && (typeof targetId !== "string" || !targetId.trim())) {
    throw new TypeError("Result Store query targetId must be a non-empty string");
  }
  return deepFreeze({ limit, targetId });
}

export function compareRunsNewestFirst(left, right) {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

export function normalizeRunRecord(record) {
  return record
    && typeof record === "object"
    && record.schemaVersion === 2
    && !Object.hasOwn(record, "judge")
      ? { ...record, judge: null }
      : record;
}

export function collectRunEvidence(record) {
  if (record.state !== "complete") return deepFreeze([]);
  const collected = [];
  const add = (kind, reference) => {
    if (reference) collected.push({ kind, reference });
  };
  add("canonical-evidence", record.evidence.transcript);
  add("canonical-evidence", record.evidence.stderr);
  for (const reference of record.evidence.structured) add("canonical-evidence", reference);
  for (const entry of record.evidence.egress) add("canonical-evidence", entry.content);
  for (const value of Object.values(record.evidence.lifecycle ?? {})) {
    for (const reference of Array.isArray(value) ? value : [value]) {
      add("canonical-evidence", reference);
    }
  }
  for (const artifact of record.evidence.artifacts) {
    add("output-artifact", artifact.content);
  }
  return deepFreeze(collected);
}
