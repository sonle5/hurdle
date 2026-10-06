// Presentation-only bucket: default CLI runs legitimately have no version label.
// Escape an explicit matching prefix so user labels cannot collide with it.
const UNVERSIONED_ID = "__tae_unversioned__";
function versionId(record) {
  const value = record.experimentVersion;
  return value == null ? UNVERSIONED_ID
    : value.startsWith(UNVERSIONED_ID) ? UNVERSIONED_ID + value : value;
}

import { projectEvaluatorSourceSummaries } from "./canonical-results.mjs";

const AGENTS = Object.freeze({
  "claude-code": Object.freeze({ slug: "CC", name: "Claude Code" }),
  codex: Object.freeze({ slug: "CDX", name: "OpenAI Codex" }),
});

const CONDITIONS = Object.freeze({
  baseline: Object.freeze({ id: "C1", label: "Baseline" }),
  mcp: Object.freeze({ id: "C2", label: "MCP" }),
  skills: Object.freeze({ id: "C3", label: "Skills" }),
  "mcp-skills": Object.freeze({ id: "C4", label: "MCP + Skills" }),
});

export const MAX_CANONICAL_DASHBOARD_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
export const MAX_CANONICAL_DASHBOARD_EGRESS_BYTES = 16 * 1024 * 1024;
const MAX_CANONICAL_DASHBOARD_REQUESTS = 250;
const MAX_CANONICAL_EGRESS_SOURCE_REQUESTS = 10_000;

function completeAt(record) {
  return record.completedAt ?? record.startedAt ?? record.createdAt;
}

function headlineVerdict(record) {
  const verdict = record.headline?.verdict ?? record.verdict;
  return ["pass", "fail", "incomplete"].includes(verdict) ? verdict : "unknown";
}

function passed(verdict) {
  if (verdict === "pass") return true;
  if (verdict === "fail") return false;
  return null;
}

function projectToolVersions(value) {
  // Run metrics are arbitrary JSON; this presentation field has a narrower shape.
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(["runner", "node", "python", "pip"].map((name) => {
    const version = value[name];
    return [name, typeof version === "string" && /^\d{1,4}\.\d{1,4}(?:\.\d{1,8})?(?:[-+][a-zA-Z0-9.-]{1,32})?$/.test(version) ? version : null];
  }));
}

function note(record) {
  const reasons = [
    ...(record.runTrust?.reasons ?? []),
    ...(record.headline?.verdictReasons ?? record.verdictReasons ?? []),
  ]
    .map((reason) => {
      if (!reason || typeof reason !== "object") return null;
      if (reason.summary) return `${reason.code}: ${reason.summary}`;
      return reason.code ?? null;
    })
    .filter(Boolean);
  const checks = (record.checks ?? [])
    .filter((check) => check?.outcome && check.outcome !== "pass")
    .map((check) => (
      `${check.id} ${check.outcome}${check.summary ? ` — ${check.summary}` : ""}`
    ));
  const lines = [...new Set([...reasons, ...checks])];
  return lines.length > 0 ? lines.join("\n") : null;
}

function projectSummary(record) {
  const snapshot = record.snapshot;
  const conditionId = snapshot.condition.id;
  const condition = CONDITIONS[conditionId] ?? {
    id: conditionId,
    label: snapshot.condition.definition?.displayName ?? conditionId,
  };
  const adapterId = snapshot.agent.adapterId;
  const agent = AGENTS[adapterId] ?? {
    slug: adapterId.toUpperCase().slice(0, 8),
    name: adapterId,
  };
  const metrics = record.state === "complete" ? record.metrics?.common ?? {} : {};
  const execution = record.state === "complete" ? record.execution : null;
  const verdict = headlineVerdict(record);
  const createdAt = new Date(completeAt(record));
  return {
    id: `canonical--${record.id}`,
    canonicalRunId: record.id,
    snapshotFingerprint: record.snapshotFingerprint,
    sourceKind: "canonical",
    createdAt,
    version: versionId(record),
    run: `run${record.invocation.repeatOrdinal}`,
    agent: agent.slug,
    agentName: agent.name,
    configId: condition.id,
    configLabel: condition.label,
    configFull: `${condition.id} — ${condition.label}`,
    configDir: conditionId,
    model: snapshot.agent.requestedModel,
    modelResolved: execution?.observedModel ?? null,
    task: snapshot.task.id,
    taskName: snapshot.task.id,
    durationSec: Number.isSafeInteger(execution?.durationMs)
      ? Math.round(execution.durationMs / 1_000)
      : 0,
    corrections: 0,
    passed: passed(verdict),
    result: verdict,
    rawResult: verdict,
    auditVerdict: record.judge?.kind === "result" ? record.judge.outcome : null,
    manualOverride: null,
    toolCalls: Number.isFinite(metrics.toolCalls) ? metrics.toolCalls : null,
    totalTokensIn: Number.isFinite(metrics.totalTokens)
      ? metrics.totalTokens
      : Number.isFinite(metrics.inputTokens)
        ? metrics.inputTokens
        : 0,
    costUsd: Number.isFinite(metrics.costUsd)
      ? metrics.costUsd
      : Number.isFinite(metrics.reportedCostUsd)
        ? metrics.reportedCostUsd
        : 0,
    mcpCalls: Number.isFinite(metrics.mcpCalls) ? metrics.mcpCalls : 0,
    skillInjections: Number.isFinite(metrics.skillInjections) ? metrics.skillInjections : 0,
    injectedSkills: [],
    mcpMethods: [],
    toolVersions: record.state === "complete"
      ? projectToolVersions(record.metrics?.adapters?.[adapterId]?.toolVersions)
      : null,
    failureAnalysis: null,
    failureReview: null,
    note: note(record),
    prompt: snapshot.task.prompt,
    gradingCriteria: null,
    needsFollowup: false,
    followupReason: null,
    docsCandidateCount: 0,
    docsCandidateStatuses: [],
  };
}

function versionFromRecord(record) {
  const timestamp = completeAt(record);
  return {
    id: versionId(record),
    name: record.experimentVersion ?? "Unversioned runs",
    description: "Canonical Run Records",
    kind: "experiment",
    runAt: timestamp,
    createdAt: timestamp,
    model: record.snapshot.agent.requestedModel,
    ccVersion: null,
  };
}

function runIdFromSessionId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.startsWith("canonical--run_")) {
    return null;
  }
  const runId = sessionId.slice("canonical--".length);
  return /^run_[a-f0-9-]{36}$/.test(runId) ? runId : null;
}

function deepAudit(record) {
  if (record.judge?.kind !== "result") return null;
  return {
    verdict: record.judge.outcome,
    summary: record.judge.summary,
    judgeId: record.judge.judgeId,
    model: record.judge.model,
    basis: record.judge.basis ?? null,
  };
}

function judgeStatusLabel(record) {
  const availability = record.snapshot.evaluation?.authority?.judge?.availability
    ?? (record.snapshot.task.judge ? "required" : "disabled");
  if (record.judgeStatus === "not_requested") return availability === "disabled" ? "Not used" : "Not run";
  return ({ pending: "Pending", failed: "Failed", complete: "Complete" })[record.judgeStatus] ?? "Missing";
}

async function transcript(reader, record) {
  const reference = record.state === "complete" ? record.evidence?.transcript : null;
  if (
    !reference
    || reference.availability !== "available"
    || !Number.isSafeInteger(reference.sizeBytes)
    || reference.sizeBytes < 0
    || reference.sizeBytes > MAX_CANONICAL_DASHBOARD_TRANSCRIPT_BYTES
  ) {
    return null;
  }
  try {
    const bytes = await reader.readEvidence(reference, {
      maxBytes: MAX_CANONICAL_DASHBOARD_TRANSCRIPT_BYTES,
    });
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

function boundedString(value, maxLength = 4_096) {
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function boundedNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function projectRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const path = boundedString(request.path);
  const host = boundedString(request.host, 253);
  if (!path || !host) return null;
  const common = {
    ts: boundedString(request.observedAt, 64),
    host,
    path,
    status: boundedNumber(request.statusCode),
    duration_ms: boundedNumber(request.durationMs),
    model: null,
    response_id: null,
    prompt_tokens: null,
    completion_tokens: null,
  };
  if (request.kind === "http-request") {
    const method = boundedString(request.method, 32);
    return method ? {
      ...common,
      method,
      ...(request.disposition === "blocked" ? { disposition: "blocked" } : {}),
    } : null;
  }
  if (request.kind === "websocket-session") {
    return {
      ...common,
      method: "WS",
      frames_sent: boundedNumber(request.framesSent),
      frames_recv: boundedNumber(request.framesReceived),
      bytes_sent: boundedNumber(request.bytesSent),
      bytes_recv: boundedNumber(request.bytesReceived),
    };
  }
  return null;
}

async function togetherRequests(reader, record) {
  if (record.state !== "complete") return { rows: [], truncated: false };
  const projected = [];
  let truncated = false;
  outer:
  for (const entry of record.evidence?.egress ?? []) {
    const reference = entry.status === "captured" ? entry.content : null;
    if (
      !reference
      || reference.availability !== "available"
      || reference.mediaType !== "application/json"
      || !Number.isSafeInteger(reference.sizeBytes)
      || reference.sizeBytes < 0
      || reference.sizeBytes > MAX_CANONICAL_DASHBOARD_EGRESS_BYTES
    ) continue;
    try {
      const bytes = await reader.readEvidence(reference, {
        maxBytes: MAX_CANONICAL_DASHBOARD_EGRESS_BYTES,
      });
      const body = JSON.parse(bytes.toString("utf8"));
      if (
        body?.status !== "captured"
        || !Array.isArray(body.requests)
        || body.requests.length > MAX_CANONICAL_EGRESS_SOURCE_REQUESTS
      ) continue;
      for (const request of body.requests) {
        const row = projectRequest(request);
        if (!row) continue;
        if (projected.length >= MAX_CANONICAL_DASHBOARD_REQUESTS) {
          truncated = true;
          break outer;
        }
        projected.push(row);
      }
    } catch {
      // Evidence remains available from the immutable record when presentation fails.
    }
  }
  return { rows: projected, truncated };
}

async function projectDetail(reader, record) {
  const summary = projectSummary(record);
  const resources = record.snapshot.condition.definition?.resources ?? {};
  const [sessionJsonl, requestProjection] = await Promise.all([
    transcript(reader, record),
    togetherRequests(reader, record),
  ]);
  return {
    ...summary,
    readOnly: true,
    sessionJsonl,
    gradingCriteria: null,
    findings: null,
    skills: resources.skills ?? [],
    mcpEnabled: (resources.mcpServers ?? []).length > 0,
    agentVersion: summary.toolVersions?.runner ?? null,
    sandboxId: null,
    claudeSessionId: record.execution?.sessionId ?? null,
    resultsPath: null,
    audit: null,
    deepAudit: deepAudit(record),
    judgeStatusLabel: judgeStatusLabel(record),
    togetherRequests: requestProjection.rows,
    togetherRequestsTruncated: requestProjection.truncated,
    docsCandidates: [],
    discovery: null,
    storedChecks: record.state === "complete" ? record.checks : [],
    evaluatorSources: projectEvaluatorSourceSummaries(record),
    deterministicEffectiveVerdict: record.state === "complete"
      ? record.deterministic?.effective?.verdict ?? null
      : null,
  };
}

export function createCanonicalDashboardProjection(reader) {
  if (
    !reader
    || typeof reader.listRuns !== "function"
    || typeof reader.getRun !== "function"
    || typeof reader.readEvidence !== "function"
  ) {
    throw new TypeError("Canonical dashboard projection requires a read-only Result Store");
  }

  async function records() {
    return reader.listRuns({ limit: 10_000 });
  }

  return Object.freeze({
    async listVersions() {
      const byId = new Map();
      for (const record of await records()) {
        const current = byId.get(versionId(record));
        if (!current || Date.parse(completeAt(record)) > Date.parse(current.runAt)) {
          byId.set(versionId(record), versionFromRecord(record));
        }
      }
      return Object.freeze([...byId.values()].sort((left, right) => (
        Date.parse(right.runAt) - Date.parse(left.runAt)
      )));
    },

    async listSessions(experimentVersion) {
      return Object.freeze((await records())
        .filter((record) => versionId(record) === experimentVersion)
        .map(projectSummary));
    },

    async findSession(sessionId) {
      const runId = runIdFromSessionId(sessionId);
      if (!runId) return null;
      const record = await reader.getRun(runId);
      return record ? projectDetail(reader, record) : null;
    },
  });
}
