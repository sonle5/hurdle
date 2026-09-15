function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function materializeV2Authority(profile, binding) {
  return deepFreeze({
    schemaVersion: profile.schemaVersion,
    id: profile.id,
    kind: profile.kind,
    checkPolicy: {
      defaultRule: profile.checkPolicy.defaultRule,
      rules: structuredClone(binding.checkRules),
      unmatchedRule: "invalidate-evaluator-output",
    },
    judge: profile.judge.availability === "disabled"
      ? { availability: "disabled" }
      : {
          availability: "required",
          capability: structuredClone(profile.judge.capability),
          timeoutMs: profile.judge.timeoutMs,
          rubric: binding.rubric,
          projection: structuredClone(profile.judge.projection),
          output: structuredClone(profile.judge.output),
        },
  });
}

function requestProtocolMatches(expected, offered) {
  if (expected === undefined) return true;
  if (!Array.isArray(offered)) return false;
  const expectedJson = JSON.stringify(expected);
  return offered.some((candidate) => JSON.stringify(candidate) === expectedJson);
}

function judgeCapabilityDiagnostic(profile, judgeCapability, taskId) {
  if (profile.judge.availability === "disabled") return null;
  if (!judgeCapability) {
    return deepFreeze({
      category: "capability",
      code: "authority.judge-capability-missing",
      message: `Task '${taskId}' Authority Profile '${profile.id}' requires a Judge capability.`,
      taskId,
      authorityProfileId: profile.id,
    });
  }
  const expected = profile.judge;
  const matches = (
    judgeCapability.judgeId === expected.capability.judgeId
    && judgeCapability.model === expected.capability.model
    && Array.isArray(judgeCapability.inputSchemaVersions)
    && judgeCapability.inputSchemaVersions.includes(expected.capability.inputSchemaVersion)
    && Number.isSafeInteger(judgeCapability.maxTimeoutMs)
    && expected.timeoutMs <= judgeCapability.maxTimeoutMs
    && Number.isSafeInteger(judgeCapability.maxInputBytes)
    && expected.projection.limits.maxInputBytes <= judgeCapability.maxInputBytes
    && Number.isSafeInteger(judgeCapability.maxOutputBytes)
    && expected.output.maxSummaryBytes <= judgeCapability.maxOutputBytes
    && requestProtocolMatches(
      expected.capability.requestProtocol,
      judgeCapability.requestProtocols,
    )
  );
  if (matches) return null;
  return deepFreeze({
    category: "capability",
    code: "authority.judge-capability-mismatch",
    message: `Task '${taskId}' Authority Profile '${profile.id}' does not match the injected Judge capability.`,
    taskId,
    authorityProfileId: profile.id,
  });
}

const LEGACY_JUDGE_PROJECTION = deepFreeze({
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
});

export function assertV1CompatibilityAuthority(authority, deterministicEvaluator) {
  const hasEvaluator = (
    typeof deterministicEvaluator === "string"
    && Boolean(deterministicEvaluator.trim())
  );
  const expectedKind = authority?.judge?.availability === "required"
    ? (hasEvaluator ? "hybrid" : "judge-primary")
    : "deterministic-primary";
  const checkPolicyMatches = (
    authority?.checkPolicy?.defaultRule === "authored"
    && authority.checkPolicy.unmatchedRule === "invalidate-evaluator-output"
    && Array.isArray(authority.checkPolicy.rules)
    && authority.checkPolicy.rules.length === 0
  );
  const projectionMatches = (
    authority?.judge?.projection?.schemaVersion === LEGACY_JUDGE_PROJECTION.schemaVersion
    && Object.entries(LEGACY_JUDGE_PROJECTION.include).every(
      ([key, value]) => authority.judge.projection.include[key] === value,
    )
    && Object.entries(LEGACY_JUDGE_PROJECTION.limits).every(
      ([key, value]) => authority.judge.projection.limits[key] === value,
    )
  );
  const judgeMatches = authority?.judge?.availability === "required"
    ? (
        authority.judge.capability.inputSchemaVersion === 1
        && projectionMatches
        && authority.judge.output.maxSummaryBytes === 4 * 1024
      )
    : (
        authority?.judge?.availability === "disabled"
        && hasEvaluator
      );
  if (
    authority?.schemaVersion !== 1
    || authority?.kind !== expectedKind
    || authority.id !== `v1-compat-${expectedKind}`
    || !checkPolicyMatches
    || !judgeMatches
  ) {
    throw new TypeError("Run Record v3 RunPlan v1 compatibility authority is invalid");
  }
}

function legacyCapabilityDiagnostic(judgeCapability, taskId) {
  if (!judgeCapability) return null;
  const matches = (
    typeof judgeCapability.judgeId === "string"
    && judgeCapability.judgeId.trim()
    && (judgeCapability.model === null || typeof judgeCapability.model === "string")
    && Array.isArray(judgeCapability.inputSchemaVersions)
    && judgeCapability.inputSchemaVersions.includes(1)
    && Number.isSafeInteger(judgeCapability.maxTimeoutMs)
    && judgeCapability.maxTimeoutMs >= 1
    && Number.isSafeInteger(judgeCapability.maxInputBytes)
    && judgeCapability.maxInputBytes >= LEGACY_JUDGE_PROJECTION.limits.maxInputBytes
    && Number.isSafeInteger(judgeCapability.maxOutputBytes)
    && judgeCapability.maxOutputBytes >= 4 * 1024
  );
  if (matches) return null;
  return deepFreeze({
    category: "capability",
    code: "authority.judge-capability-mismatch",
    message: `Task '${taskId}' legacy judging does not match the injected Judge capability.`,
    taskId,
  });
}

function materializeV1Authority(task, judgeCapability) {
  const evaluatorConfigured = Boolean(task.evaluation?.deterministicEvaluator);
  if (!judgeCapability) {
    return deepFreeze({
      schemaVersion: 1,
      id: "v1-compat-deterministic-primary",
      kind: "deterministic-primary",
      checkPolicy: {
        defaultRule: "authored",
        rules: [],
        unmatchedRule: "invalidate-evaluator-output",
      },
      judge: { availability: "disabled" },
    });
  }
  const kind = evaluatorConfigured ? "hybrid" : "judge-primary";
  return deepFreeze({
    schemaVersion: 1,
    id: `v1-compat-${kind}`,
    kind,
    checkPolicy: {
      defaultRule: "authored",
      rules: [],
      unmatchedRule: "invalidate-evaluator-output",
    },
    judge: {
      availability: "required",
      capability: {
        judgeId: judgeCapability.judgeId,
        model: judgeCapability.model,
        inputSchemaVersion: 1,
      },
      timeoutMs: Math.min(judgeCapability.maxTimeoutMs, 300_000),
      rubric: task.evaluation.judge.rubric,
      projection: structuredClone(LEGACY_JUDGE_PROJECTION),
      output: { maxSummaryBytes: 4 * 1024 },
    },
  });
}

function resolveV1AuthoritySelections({
  definition,
  selectedTaskIds,
  authorityProfileId,
  legacyJudging,
  judgeCapability,
}) {
  if (authorityProfileId !== undefined) {
    return {
      ok: false,
      diagnostics: [deepFreeze({
        category: "selection",
        code: "authority.profile-selection-unsupported",
        message: "RunPlan v1 does not declare selectable Authority Profiles.",
        authorityProfileId,
      })],
    };
  }
  if (!["task", "disabled", "required"].includes(legacyJudging)) {
    throw new TypeError("legacyJudging must be task, disabled, or required");
  }
  const diagnostics = [];
  const pending = [];
  for (const taskId of selectedTaskIds) {
    const task = definition.tasks[taskId];
    if (!task) throw new TypeError(`Task '${taskId}' does not exist`);
    if (task.observationOnly === true) {
      pending.push([taskId, null]);
      continue;
    }
    const rubric = task.evaluation?.judge?.rubric;
    const evaluatorConfigured = Boolean(task.evaluation?.deterministicEvaluator);
    if (legacyJudging === "required" && !rubric) {
      diagnostics.push(deepFreeze({
        category: "selection",
        code: "authority.legacy-rubric-missing",
        message: `Task '${taskId}' has no legacy Judge rubric.`,
        taskId,
      }));
      continue;
    }
    const judgeNeededForEvaluability = !evaluatorConfigured && Boolean(rubric);
    if (
      (legacyJudging === "required" || judgeNeededForEvaluability)
      && legacyJudging !== "disabled"
      && !judgeCapability
    ) {
      diagnostics.push(deepFreeze({
        category: "capability",
        code: "authority.judge-capability-missing",
        message: `Task '${taskId}' requires a Judge capability.`,
        taskId,
      }));
      continue;
    }
    if (!evaluatorConfigured && legacyJudging === "disabled") {
      diagnostics.push(deepFreeze({
        category: "selection",
        code: "authority.legacy-evaluator-missing",
        message: `Task '${taskId}' has no Deterministic Evaluator to use with disabled judging.`,
        taskId,
      }));
      continue;
    }
    const selectJudge = (
      legacyJudging !== "disabled"
      && Boolean(rubric)
      && Boolean(judgeCapability)
    );
    const capabilityDiagnostic = selectJudge
      ? legacyCapabilityDiagnostic(judgeCapability, taskId)
      : null;
    if (capabilityDiagnostic) {
      diagnostics.push(capabilityDiagnostic);
      continue;
    }
    pending.push([
      taskId,
      materializeV1Authority(task, selectJudge ? judgeCapability : null),
    ]);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    value: deepFreeze({ byTaskId: Object.fromEntries(pending) }),
    diagnostics: [],
  };
}

export function resolveAuthoritySelections({
  definition,
  selectedTaskIds,
  authorityProfileId,
  legacyJudging = "task",
  judgeCapability = null,
} = {}) {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("definition must be a resolved RunPlan definition");
  }
  if (!Array.isArray(selectedTaskIds) || selectedTaskIds.length === 0) {
    throw new TypeError("selectedTaskIds must be a non-empty array");
  }
  if (definition.schemaVersion === 1) {
    return resolveV1AuthoritySelections({
      definition,
      selectedTaskIds,
      authorityProfileId,
      legacyJudging,
      judgeCapability,
    });
  }
  if (definition.schemaVersion !== 2) {
    throw new TypeError("definition schemaVersion must be 1 or 2");
  }
  if (legacyJudging !== "task") {
    return {
      ok: false,
      diagnostics: [deepFreeze({
        category: "selection",
        code: "authority.legacy-selection-conflict",
        message: "RunPlan v2 does not accept legacy judging selection.",
      })],
    };
  }
  const profilesById = new Map(
    definition.authorityProfiles.map((profile) => [profile.id, profile]),
  );
  if (authorityProfileId !== undefined && !profilesById.has(authorityProfileId)) {
    return {
      ok: false,
      diagnostics: [deepFreeze({
        category: "selection",
        code: "authority.profile-unknown",
        message: `Authority Profile '${authorityProfileId}' does not exist.`,
        authorityProfileId,
      })],
    };
  }
  const diagnostics = [];
  const pending = [];
  for (const taskId of selectedTaskIds) {
    const task = definition.tasks[taskId];
    if (!task) throw new TypeError(`Task '${taskId}' does not exist`);
    if (task.observationOnly === true) {
      pending.push([taskId, null]);
      continue;
    }
    const selectedProfileId = authorityProfileId
      ?? task.evaluation.authority.defaultProfileId;
    const binding = task.evaluation.authority.bindings.find(
      (candidate) => candidate.profileId === selectedProfileId,
    );
    if (!binding) {
      diagnostics.push(deepFreeze({
        category: "selection",
        code: "authority.profile-unbound",
        message: `Task '${taskId}' does not bind Authority Profile '${selectedProfileId}'.`,
        taskId,
        authorityProfileId: selectedProfileId,
      }));
      continue;
    }
    const profile = profilesById.get(selectedProfileId);
    const capabilityDiagnostic = judgeCapabilityDiagnostic(
      profile,
      judgeCapability,
      taskId,
    );
    if (capabilityDiagnostic) {
      diagnostics.push(capabilityDiagnostic);
      continue;
    }
    pending.push([taskId, materializeV2Authority(profile, binding)]);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    value: deepFreeze({ byTaskId: Object.fromEntries(pending) }),
    diagnostics: [],
  };
}
