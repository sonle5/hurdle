const CHECK_AUTHORITIES = new Set(["required", "advisory", "disabled"]);
const AUTHORITY_RULES = new Set(["authored", ...CHECK_AUTHORITIES]);
const AUTHORITY_KINDS = new Set([
  "judge-primary",
  "hybrid",
  "deterministic-primary",
]);
const EVALUATOR_STATUSES = new Set([
  "not_configured",
  "complete",
  "failed",
  "blocked_by_run_trust",
  "invalid_output",
]);
const JUDGE_STATUSES = new Set([
  "not_requested",
  "pending",
  "complete",
  "failed",
]);
const JUDGE_ERROR_CODES = new Set([
  "judge.cancelled",
  "judge.timed-out",
  "judge.provider-failed",
  "judge.invalid-output",
  "judge.input-unavailable",
]);
const JUDGE_REQUEST_REQUIREMENTS = new Set([
  "controller-transcript",
  "execution-summary",
  "workspace-artifact-metadata",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonblank(value) {
  return typeof value === "string" && value.trim() !== "";
}

function boundedString(value, maxBytes, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return nonblank(value) && Buffer.byteLength(value) <= maxBytes;
}

function boundedInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function hasExactlyKeys(value, expected) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length
    && keys.every((key) => expected.includes(key));
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function authoredAuthority(check) {
  return check.required ? "required" : "advisory";
}

function validRequestProtocol(protocol) {
  if (protocol === undefined) return true;
  if (
    !hasExactlyKeys(protocol, [
      "schemaVersion",
      "id",
      "fingerprint",
      "requirements",
      "maxRequestBytes",
    ])
    || protocol.schemaVersion !== 1
    || !/^[a-z][a-z0-9-]{0,127}$/.test(protocol.id ?? "")
    || !/^sha256:[a-f0-9]{64}$/.test(protocol.fingerprint ?? "")
    || !Array.isArray(protocol.requirements)
    || protocol.requirements.length < 1
    || protocol.requirements.length > 3
    || new Set(protocol.requirements).size !== protocol.requirements.length
    || protocol.requirements.some((value) => !JUDGE_REQUEST_REQUIREMENTS.has(value))
    || protocol.requirements.some((value, index) => (
      index > 0 && protocol.requirements[index - 1] > value
    ))
    || !boundedInteger(protocol.maxRequestBytes, 1024 * 1024)
  ) {
    return false;
  }
  return true;
}

function assertReason(reason, label) {
  if (
    !isRecord(reason)
    || !nonblank(reason.code)
    || !nonblank(reason.summary)
    || !Array.isArray(reason.evidenceRefs)
    || reason.evidenceRefs.some((reference) => typeof reference !== "string")
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertRunTrust(runTrust) {
  if (
    !isRecord(runTrust)
    || runTrust.schemaVersion !== 1
    || !["trusted", "incomplete", "unknown"].includes(runTrust.status)
    || !Array.isArray(runTrust.reasons)
  ) {
    throw new TypeError("Run Trust assessment is invalid");
  }
  runTrust.reasons.forEach((reason, index) => {
    assertReason(reason, `Run Trust reason ${index}`);
  });
  if (runTrust.status === "trusted" && runTrust.reasons.length !== 0) {
    throw new TypeError("trusted Run Trust cannot contain reasons");
  }
  if (runTrust.status !== "trusted" && runTrust.reasons.length === 0) {
    throw new TypeError("non-trusted Run Trust requires a reason");
  }
}

function assertAuthority(authority) {
  if (
    !isRecord(authority)
    || !hasExactlyKeys(authority, [
      "schemaVersion",
      "id",
      "kind",
      "checkPolicy",
      "judge",
    ])
    || ![1, 2].includes(authority.schemaVersion)
    || (authority.schemaVersion === 2 && authority.kind !== "hybrid")
    || !/^[a-z][a-z0-9-]{0,127}$/.test(authority.id ?? "")
    || !AUTHORITY_KINDS.has(authority.kind)
    || !hasExactlyKeys(authority.checkPolicy, [
      "defaultRule",
      "rules",
      "unmatchedRule",
    ])
    || !AUTHORITY_RULES.has(authority.checkPolicy.defaultRule)
    || !Array.isArray(authority.checkPolicy.rules)
    || authority.checkPolicy.unmatchedRule !== "invalidate-evaluator-output"
    || !isRecord(authority.judge)
    || !["disabled", "required"].includes(authority.judge.availability)
  ) {
    throw new TypeError("Resolved authority profile is invalid");
  }
  if (
    ["judge-primary", "hybrid"].includes(authority.kind)
    && authority.judge.availability !== "required"
  ) {
    throw new TypeError(`${authority.kind} requires a Judge`);
  }
  const checkIds = new Set();
  for (const [index, rule] of authority.checkPolicy.rules.entries()) {
    if (
      !hasExactlyKeys(rule, ["checkId", "rule"])
      || !/^[a-z][a-z0-9-]{0,127}$/.test(rule.checkId ?? "")
      || !AUTHORITY_RULES.has(rule.rule)
    ) {
      throw new TypeError("Authority check rule is invalid");
    }
    if (checkIds.has(rule.checkId)) {
      throw new TypeError(`Authority profile has duplicate rule for check '${rule.checkId}'`);
    }
    if (index > 0 && authority.checkPolicy.rules[index - 1].checkId > rule.checkId) {
      throw new TypeError("Authority check rules must be sorted by check id");
    }
    checkIds.add(rule.checkId);
  }
  if (authority.judge.availability === "disabled") {
    if (!hasExactlyKeys(authority.judge, ["availability"])) {
      throw new TypeError("disabled Judge policy is invalid");
    }
    return;
  }
  const judge = authority.judge;
  const includeKeys = [
    "transcript",
    "stderr",
    "textArtifacts",
    "egress",
    "lifecycleReceipts",
    "runTrustIssues",
    "baselineDeterministicOutcome",
    "effectiveDeterministicOutcome",
    "requiredChecks",
    "advisoryChecks",
  ];
  const limitMaximums = {
    maxEvidenceItems: 64,
    maxEvidenceItemBytes: 64 * 1024,
    maxEvidenceTextBytes: 512 * 1024,
    maxChecks: 128,
    maxRunTrustIssues: 64,
    maxInputBytes: 1024 * 1024,
  };
  if (
    !hasExactlyKeys(judge, [
      "availability",
      "capability",
      "timeoutMs",
      "rubric",
      "projection",
      "output",
    ])
    || !hasExactlyKeys(judge.capability, judge.capability.requestProtocol === undefined
      ? ["judgeId", "model", "inputSchemaVersion"]
      : ["judgeId", "model", "inputSchemaVersion", "requestProtocol"])
    || !boundedString(judge.capability.judgeId, 256)
    || !boundedString(judge.capability.model, 256, { nullable: true })
    || !(
      judge.capability.inputSchemaVersion === 2
      || (
        judge.capability.inputSchemaVersion === 1
        && authority.id === `v1-compat-${authority.kind}`
        && ["judge-primary", "hybrid"].includes(authority.kind)
      )
    )
    || !validRequestProtocol(judge.capability.requestProtocol)
    || (
      judge.capability.requestProtocol
      && judge.capability.requestProtocol.maxRequestBytes
        > judge.projection?.limits?.maxInputBytes
    )
    || !boundedInteger(judge.timeoutMs, 300_000)
    || !boundedString(judge.rubric, 64 * 1024)
    || !hasExactlyKeys(judge.projection, ["schemaVersion", "include", "limits"])
    || ![1, 2].includes(judge.projection.schemaVersion)
    || (judge.projection.schemaVersion === 2 && judge.capability.inputSchemaVersion !== 2)
    || !hasExactlyKeys(judge.projection.include, includeKeys)
    || includeKeys.some((key) => typeof judge.projection.include[key] !== "boolean")
    || !hasExactlyKeys(judge.projection.limits, Object.keys(limitMaximums))
    || Object.entries(limitMaximums).some(
      ([key, maximum]) => !boundedInteger(judge.projection.limits[key], maximum),
    )
    || !hasExactlyKeys(judge.output, ["maxSummaryBytes"])
    || !boundedInteger(judge.output.maxSummaryBytes, 4 * 1024)
  ) {
    throw new TypeError("required Judge policy is invalid");
  }
}

export function assertEvaluationAuthority(authority) {
  assertAuthority(authority);
}

function assertChecks(checks) {
  if (!Array.isArray(checks)) {
    throw new TypeError("Evaluator checks must be an array");
  }
  const checkIds = new Set();
  for (const check of checks) {
    if (
      !isRecord(check)
      || !nonblank(check.id)
      || typeof check.required !== "boolean"
      || !["pass", "fail", "skip"].includes(check.outcome)
      || !nonblank(check.summary)
      || !Array.isArray(check.evidenceRefs)
      || check.evidenceRefs.some((reference) => typeof reference !== "string")
    ) {
      throw new TypeError("Evaluator check is invalid");
    }
    if (checkIds.has(check.id)) {
      throw new TypeError(`Evaluator output has duplicate check id '${check.id}'`);
    }
    checkIds.add(check.id);
  }
}

function assertJudgeState(authority, judgeStatus, judge) {
  if (!JUDGE_STATUSES.has(judgeStatus)) {
    throw new TypeError("Judge status is invalid");
  }
  if (
    authority.judge.availability === "disabled"
    && (judgeStatus !== "not_requested" || judge !== null)
  ) {
    throw new TypeError("disabled Judge must be not_requested with no output");
  }
  if (["not_requested", "pending"].includes(judgeStatus) && judge !== null) {
    throw new TypeError(`${judgeStatus} Judge cannot contain output`);
  }
  if (
    judgeStatus === "complete"
    && (
      !isRecord(judge)
      || judge.schemaVersion !== 2
      || judge.kind !== "result"
      || !["pass", "fail", "incomplete"].includes(judge.outcome)
    )
  ) {
    throw new TypeError("complete Judge requires a version 2 result");
  }
  if (
    judgeStatus === "failed"
    && (
      !isRecord(judge)
      || judge.schemaVersion !== 2
      || judge.kind !== "error"
      || !JUDGE_ERROR_CODES.has(judge.code)
    )
  ) {
    throw new TypeError("failed Judge requires a version 2 error");
  }
}

function concreteRule(rule, check) {
  if (rule === "authored") return authoredAuthority(check);
  if (CHECK_AUTHORITIES.has(rule)) return rule;
  throw new TypeError(`Authority rule for check '${check.id}' is invalid`);
}

function resolveChecks(authority, checks) {
  const rules = new Map(
    authority.checkPolicy.rules.map(({ checkId, rule }) => [checkId, rule]),
  );
  return checks.map((check) => ({
    id: check.id,
    authoredAuthority: authoredAuthority(check),
    effectiveAuthority: concreteRule(
      rules.get(check.id) ?? authority.checkPolicy.defaultRule,
      check,
    ),
    outcome: check.outcome,
    summary: check.summary,
    evidenceRefs: [...check.evidenceRefs],
    ...(check.details === undefined
      ? {}
      : { details: structuredClone(check.details) }),
  }));
}

function evaluatorUnavailableOutcome(evaluatorStatus, unmatchedCheckIds) {
  if (unmatchedCheckIds.length > 0) {
    return {
      verdict: "unknown",
      verdictReasons: [{
        code: "evaluator.check-policy-unmatched",
        summary: `Authority rules did not match emitted checks: ${unmatchedCheckIds.join(", ")}.`,
        evidenceRefs: [],
      }],
    };
  }
  if (evaluatorStatus === "complete") return null;
  const values = {
    failed: ["evaluator.failed", "The Deterministic Evaluator did not complete."],
    blocked_by_run_trust: [
      "evaluator.blocked-by-run-trust",
      "The Deterministic Evaluator was blocked by unavailable required run evidence.",
    ],
    invalid_output: [
      "evaluator.invalid-output",
      "The Deterministic Evaluator output is invalid.",
    ],
  };
  const [code, summary] = values[evaluatorStatus] ?? [
    "evaluator.invalid-status",
    "The Deterministic Evaluator status is invalid.",
  ];
  return {
    verdict: "unknown",
    verdictReasons: [{ code, summary, evidenceRefs: [] }],
  };
}

function requiredOutcome(
  checks,
  authorityField,
  lane,
  evaluatorStatus,
  unmatchedCheckIds,
) {
  if (evaluatorStatus === "not_configured") return null;
  const unavailable = evaluatorUnavailableOutcome(
    evaluatorStatus,
    unmatchedCheckIds,
  );
  if (unavailable) return unavailable;
  const required = checks.filter((check) => check[authorityField] === "required");
  const failed = required.filter((check) => check.outcome === "fail");
  if (failed.length > 0) {
    return {
      verdict: "fail",
      verdictReasons: failed.map((check) => ({
        code: `check.${check.id}`,
        summary: check.summary,
        evidenceRefs: [...check.evidenceRefs],
      })),
    };
  }
  const skipped = required.filter((check) => check.outcome === "skip");
  if (skipped.length > 0) {
    return {
      verdict: "incomplete",
      verdictReasons: skipped.map((check) => ({
        code: `check.${check.id}`,
        summary: check.summary,
        evidenceRefs: [...check.evidenceRefs],
      })),
    };
  }
  if (required.length === 0) {
    return {
      verdict: "unknown",
      verdictReasons: [{
        code: `deterministic.${lane}.no-authoritative-checks`,
        summary: lane === "baseline"
          ? "The Deterministic Evaluator emitted no evaluator-authored required checks."
          : "The selected authority profile has no effective required checks.",
        evidenceRefs: [],
      }],
    };
  }
  return {
    verdict: "pass",
    verdictReasons: [{
      code: `deterministic.${lane}.required-pass`,
      summary: lane === "baseline"
        ? "All evaluator-authored required checks passed."
        : "All checks required by the selected authority profile passed.",
      evidenceRefs: [],
    }],
  };
}

function judgeOutcome(judge) {
  return {
    verdict: judge.outcome,
    verdictReasons: [{
      code: `judge.rubric-${judge.outcome}`,
      summary: `The required Judge returned ${judge.outcome}.`,
      evidenceRefs: [],
    }],
    decidedBy: "judge",
  };
}

function judgeRequiredOutcome(verdict = "unknown") {
  return {
    verdict,
    verdictReasons: [{
      code: "judge.result-required",
      summary: "The selected authority profile requires a completed Judge result.",
      evidenceRefs: [],
    }],
    decidedBy: "judge",
  };
}

function cleanHeadline({ authority, effective, judgeStatus, judge }) {
  if (authority.kind === "judge-primary") {
    return judgeStatus === "complete"
      ? judgeOutcome(judge)
      : judgeRequiredOutcome();
  }
  if (
    authority.kind === "hybrid"
    && effective.verdict === "pass"
  ) {
    if (judgeStatus === "complete") return judgeOutcome(judge);
    // Snapshotted v1 policies retain their historical code-only fallback.
    if (authority.schemaVersion === 2) return judgeRequiredOutcome("incomplete");
  }
  return { ...effective, decidedBy: "effective-deterministic" };
}

function observationEvaluation() {
  return {
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
  };
}

function headlineOutcome({
  authority,
  runTrust,
  evaluatorStatus,
  effective,
  judgeStatus,
  judge,
}) {
  if (["fail", "incomplete"].includes(effective?.verdict)) {
    return { ...effective, decidedBy: "effective-deterministic" };
  }
  if (["incomplete", "unknown"].includes(runTrust.status)) {
    return {
      verdict: runTrust.status,
      verdictReasons: structuredClone(runTrust.reasons),
      decidedBy: "mandatory-run-trust",
    };
  }
  if (!["complete", "not_configured"].includes(evaluatorStatus)) {
    return { ...effective, decidedBy: "effective-deterministic" };
  }
  return cleanHeadline({ authority, effective, judgeStatus, judge });
}

export function evaluateAuthority({
  taskKind,
  authority,
  runTrust,
  evaluatorStatus,
  checks,
  judgeStatus,
  judge,
} = {}) {
  assertRunTrust(runTrust);
  if (taskKind === "observation") {
    if (
      authority !== null
      || evaluatorStatus !== "not_configured"
      || !Array.isArray(checks)
      || checks.length !== 0
      || judgeStatus !== "not_requested"
      || judge !== null
    ) {
      throw new TypeError("observation-only authority inputs are invalid");
    }
    return freeze(observationEvaluation());
  }
  if (taskKind !== "scored") {
    throw new TypeError("Task kind is invalid");
  }
  assertAuthority(authority);
  if (!EVALUATOR_STATUSES.has(evaluatorStatus)) {
    throw new TypeError("Evaluator status is invalid");
  }
  assertChecks(checks);
  if (evaluatorStatus !== "complete" && checks.length !== 0) {
    throw new TypeError(
      evaluatorStatus === "not_configured"
        ? "unconfigured Evaluator cannot emit checks"
        : "unavailable Evaluator cannot emit checks",
    );
  }
  if (
    ["hybrid", "deterministic-primary"].includes(authority.kind)
    && evaluatorStatus === "not_configured"
  ) {
    throw new TypeError(`${authority.kind} requires a configured Evaluator`);
  }
  assertJudgeState(authority, judgeStatus, judge);
  const resolvedChecks = resolveChecks(authority, checks);
  const emittedCheckIds = new Set(checks.map(({ id }) => id));
  const unmatchedCheckIds = evaluatorStatus === "complete"
    ? authority.checkPolicy.rules
      .map(({ checkId }) => checkId)
      .filter((checkId) => !emittedCheckIds.has(checkId))
    : [];
  const effectiveEvaluatorStatus = unmatchedCheckIds.length > 0
    ? "invalid_output"
    : evaluatorStatus;
  const baseline = requiredOutcome(
    resolvedChecks,
    "authoredAuthority",
    "baseline",
    effectiveEvaluatorStatus,
    unmatchedCheckIds,
  );
  const effective = requiredOutcome(
    resolvedChecks,
    "effectiveAuthority",
    "effective",
    effectiveEvaluatorStatus,
    unmatchedCheckIds,
  );
  const headline = headlineOutcome({
    authority,
    runTrust,
    evaluatorStatus: effectiveEvaluatorStatus,
    effective,
    judgeStatus,
    judge,
  });
  return freeze({
    deterministic: {
      evaluatorStatus: effectiveEvaluatorStatus,
      baseline,
      effective,
    },
    resolvedChecks,
    headline,
  });
}
