function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

const EVALUATOR_SOURCE_PROVENANCE = "run_definition_behavior_source:";
const MAX_EVALUATOR_SOURCE_BYTES = 512 * 1024;

function evaluatorSourcePath(reference) {
  if (
    reference?.availability !== "available"
    || typeof reference.provenance !== "string"
    || !reference.provenance.startsWith(EVALUATOR_SOURCE_PROVENANCE)
  ) {
    return null;
  }
  try {
    const path = decodeURIComponent(
      reference.provenance.slice(EVALUATOR_SOURCE_PROVENANCE.length),
    );
    return path && !path.startsWith("/") && !path.split("/").includes("..")
      ? path
      : null;
  } catch {
    return null;
  }
}

function evaluatorSourceReferences(record) {
  if (record.state !== "complete") return [];
  const evaluator = record.snapshot?.behavior?.deterministicEvaluator;
  if (!evaluator || typeof evaluator !== "object" || !evaluator.modules) return [];
  const expectedModules = evaluator.modules;
  return record.evidence.structured.flatMap((reference) => {
    const path = evaluatorSourcePath(reference);
    if (
      !path
      || expectedModules[path] !== reference.sha256
      || reference.sizeBytes > MAX_EVALUATOR_SOURCE_BYTES
    ) {
      return [];
    }
    return [{
      path,
      sha256: reference.sha256,
      sizeBytes: reference.sizeBytes,
      entry: path === evaluator.entryPath,
      reference,
    }];
  }).sort((left, right) => (
    Number(right.entry) - Number(left.entry) || left.path.localeCompare(right.path)
  ));
}

export function projectEvaluatorSourceSummaries(record) {
  return evaluatorSourceReferences(record).map(({ reference: _reference, ...source }) => source);
}

function evidenceReference(reference) {
  if (!reference) return null;
  return {
    sha256: reference.sha256,
    mediaType: reference.mediaType,
    sizeBytes: reference.sizeBytes,
    provenance: reference.provenance,
    authority: reference.authority,
    producer: reference.producer,
    lifecyclePhase: reference.lifecyclePhase,
    capturedAt: reference.capturedAt,
    trust: reference.trust,
    availability: reference.availability,
  };
}

function checkCounts(checks) {
  const counts = { total: 0, required: 0, pass: 0, fail: 0, skip: 0 };
  for (const check of checks) {
    counts.total += 1;
    if (check.required || check.effectiveAuthority === "required") {
      counts.required += 1;
    }
    counts[check.outcome] += 1;
  }
  return counts;
}

function artifactCounts(artifacts) {
  const counts = {
    total: artifacts.length,
    captured: 0,
    missing: 0,
    rejected: 0,
    contentAvailable: 0,
    contentUnavailable: 0,
  };
  for (const artifact of artifacts) {
    counts[artifact.status] += 1;
    if (artifact.content?.availability === "available") counts.contentAvailable += 1;
    if (artifact.content?.availability === "unavailable") counts.contentUnavailable += 1;
  }
  return counts;
}

function toSummary(record) {
  const complete = record.state === "complete";
  const execution = complete ? record.execution : null;
  const checks = complete ? record.checks : [];
  const artifacts = complete ? record.evidence.artifacts : [];
  return deepFreeze({
    id: record.id,
    revision: record.revision,
    createdAt: record.createdAt,
    startedAt: record.startedAt ?? null,
    completedAt: complete ? record.completedAt : null,
    experimentVersion: record.experimentVersion,
    snapshotFingerprint: record.snapshotFingerprint,
    target: {
      id: record.snapshot.target.id,
      displayName: record.snapshot.target.displayName,
    },
    taskId: record.snapshot.task.id,
    conditionId: record.snapshot.condition.id,
    adapterId: record.snapshot.agent.adapterId,
    requestedModel: record.snapshot.agent.requestedModel,
    observedModel: execution?.observedModel ?? null,
    environmentId: record.snapshot.environment.environmentId,
    state: record.state,
    authority: authorityView(record),
    verdict: record.verdict,
    judgeStatus: record.judgeStatus,
    durationMs: execution?.durationMs ?? null,
    commonMetrics: copy(complete ? record.metrics.common : {}),
    checkCounts: checkCounts(checks),
    artifactCounts: artifactCounts(artifacts),
    integrityIssueCount: complete ? record.integrityIssues.length : 0,
  });
}

function flattenEvidence(record) {
  if (record.state !== "complete") return [];
  const items = [];
  const add = (kind, label, reference, status = null, reason = null) => {
    items.push({
      kind,
      label,
      status,
      reason,
      reference: evidenceReference(reference),
    });
  };
  if (record.evidence.transcript) {
    add("transcript", "Transcript", record.evidence.transcript);
  }
  if (record.evidence.stderr) add("stderr", "Standard error", record.evidence.stderr);
  record.evidence.structured.forEach((reference, index) => {
    add("structured", `Structured evidence ${index + 1}`, reference);
  });
  record.evidence.egress.forEach((entry, index) => {
    add(
      "egress",
      `Egress collection ${index + 1}`,
      entry.content,
      entry.status,
      entry.reason ?? null,
    );
  });
  for (const [phase, value] of Object.entries(record.evidence.lifecycle ?? {})) {
    const references = Array.isArray(value) ? value : [value];
    references.forEach((reference, index) => {
      add(
        "lifecycle",
        references.length === 1 ? phase : `${phase} ${index + 1}`,
        reference,
      );
    });
  }
  return items;
}

function toArtifact(artifact) {
  return {
    path: artifact.path,
    kind: artifact.kind,
    required: artifact.required,
    captureStatus: artifact.status,
    reason: artifact.reason ?? null,
    sizeBytes: artifact.sizeBytes ?? null,
    sha256: artifact.sha256 ?? null,
    contentAvailability: artifact.content?.availability ?? "not_recorded",
    evidence: evidenceReference(artifact.content),
    provenance: artifact.provenance,
    authority: artifact.authority,
    producer: artifact.producer,
    lifecyclePhase: artifact.lifecyclePhase,
    capturedAt: artifact.capturedAt,
    trust: artifact.trust,
  };
}

function metricItems(value) {
  return Object.entries(value ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, itemValue]) => ({ name, value: copy(itemValue) }));
}

function metricGroups(record) {
  if (record.state !== "complete") return [];
  return [
    { namespace: "common", ownerId: null, items: metricItems(record.metrics.common) },
    ...Object.entries(record.metrics.adapters)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ownerId, values]) => ({
        namespace: "adapter",
        ownerId,
        items: metricItems(values),
      })),
    ...Object.entries(record.metrics.targets)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ownerId, values]) => ({
        namespace: "target",
        ownerId,
        items: metricItems(values),
      })),
  ];
}

function toJudge(record) {
  if (record.judgeStatus === "complete") {
    return { status: "complete", result: copy(record.judge) };
  }
  if (record.judgeStatus === "failed") {
    return { status: "failed", error: copy(record.judge) };
  }
  return { status: record.judgeStatus };
}

function authorityView(record) {
  if (record.schemaVersion === 2) {
    return {
      kind: "legacy-v2",
      label: "Legacy canonical v2 · implicit fixed policy",
      profileId: null,
      profileKind: null,
    };
  }
  const authority = record.snapshot.evaluation.authority;
  if (authority === null) {
    return {
      kind: "observation",
      label: "Observation only",
      profileId: null,
      profileKind: null,
    };
  }
  return {
    kind: "profile",
    label: authority.id,
    profileId: authority.id,
    profileKind: authority.kind,
  };
}

function recordedLane(value, unavailableReason = "not-configured") {
  return value === null || value === undefined
    ? { availability: "unavailable", reason: unavailableReason }
    : { availability: "recorded", outcome: copy(value) };
}

function authorityLanes(record) {
  if (record.schemaVersion === 2) {
    const unavailable = {
      availability: "unavailable",
      reason: "not-recorded-in-v2",
    };
    return {
      runTrust: unavailable,
      deterministicBaseline: unavailable,
      deterministicEffective: unavailable,
      headline: record.verdict === null
        ? null
        : {
            verdict: record.verdict,
            verdictReasons: copy(record.verdictReasons ?? []),
            decidedBy: "legacy-v2",
          },
    };
  }
  if (record.state !== "complete") {
    const unavailable = { availability: "unavailable", reason: "not-complete" };
    return {
      runTrust: unavailable,
      deterministicBaseline: unavailable,
      deterministicEffective: unavailable,
      headline: null,
    };
  }
  return {
    runTrust: record.runTrust
      ? { availability: "recorded", ...copy(record.runTrust) }
      : { availability: "unavailable", reason: "not-complete" },
    deterministicBaseline: recordedLane(record.deterministic?.baseline),
    deterministicEffective: recordedLane(record.deterministic?.effective),
    headline: copy(record.headline ?? null),
  };
}

function toDetail(record) {
  const summary = toSummary(record);
  const evidence = flattenEvidence(record);
  const artifacts = record.state === "complete"
    ? record.evidence.artifacts.map(toArtifact)
    : [];
  const evidenceIndex = new Map();
  for (const item of evidence) {
    if (item.reference) evidenceIndex.set(item.reference.sha256, item.reference);
  }
  for (const artifact of artifacts) {
    if (artifact.evidence) {
      evidenceIndex.set(artifact.evidence.sha256, artifact.evidence);
    }
  }
  const lanes = authorityLanes(record);
  const evaluatorSources = projectEvaluatorSourceSummaries(record);
  return deepFreeze({
    summary,
    authority: authorityView(record),
    ...lanes,
    judge: toJudge(record),
    verdictReasons: copy(record.verdictReasons ?? []),
    checks: (record.checks ?? []).map((check) => ({
      id: check.id,
      required: check.required ?? check.effectiveAuthority === "required",
      authoredAuthority: check.authoredAuthority
        ?? (check.required ? "required" : "advisory"),
      effectiveAuthority: check.effectiveAuthority ?? null,
      outcome: check.outcome,
      summary: check.summary,
      details: copy(check.details ?? null),
      evidenceRefs: [...check.evidenceRefs],
      evidence: check.evidenceRefs
        .map((reference) => evidenceIndex.get(reference))
        .filter(Boolean),
    })),
    evaluatorSources,
    integrityIssues: copy(record.integrityIssues ?? []),
    evidence,
    artifacts,
    metrics: metricGroups(record),
    execution: copy(record.execution ?? null),
    invocation: copy(record.invocation),
  });
}

export function createCanonicalResultsClient(store) {
  if (
    !store
    || typeof store.listRuns !== "function"
    || typeof store.getRun !== "function"
    || typeof store.readEvidence !== "function"
  ) {
    throw new TypeError("Canonical Results Client requires Result Store read methods");
  }
  return Object.freeze({
    async list(query) {
      return deepFreeze((await store.listRuns(query)).map(toSummary));
    },
    async find(id) {
      const record = await store.getRun(id);
      return record ? toDetail(record) : null;
    },
    async readEvaluatorSource(id, path) {
      const record = await store.getRun(id);
      const source = record
        ? evaluatorSourceReferences(record).find((candidate) => candidate.path === path)
        : null;
      if (!source) throw new Error("Evaluator source is not available for this run");
      const bytes = await store.readEvidence(source.reference, {
        maxBytes: MAX_EVALUATOR_SOURCE_BYTES,
      });
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Evaluator source is not valid UTF-8");
      }
      return deepFreeze({ path: source.path, sha256: source.sha256, source: text });
    },
  });
}
