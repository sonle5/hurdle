import {
  deepFreeze,
  sha256,
} from "./run-model.mjs";
import { evaluateAuthority } from "./evaluation-authority.mjs";
import { projectJudgeTranscript, truncateUtf8 } from "./judge-evidence-text.mjs";

const JUDGE_OUTCOMES = new Set(["pass", "fail", "incomplete"]);
const MAX_EVIDENCE_ITEMS = 64;
const MAX_EVIDENCE_ITEM_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_CHECKS = 128;
const MAX_INTEGRITY_ISSUES = 64;
const MAX_SUMMARY_BYTES = 4 * 1024;
const MAX_TIMEOUT_MS = 300_000;

export class JudgeSelectionInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "JudgeSelectionInputError";
    this.code = code;
  }
}

class JudgeInputError extends Error {}

function nonblankBounded(value, maxBytes) {
  return (
    typeof value === "string"
    && value.trim()
    && Buffer.byteLength(value) <= maxBytes
  );
}

function validateJudge(judge) {
  if (judge === null || judge === undefined) return null;
  if (
    !judge
    || typeof judge !== "object"
    || !nonblankBounded(judge.id, 256)
    || !(judge.model === null || nonblankBounded(judge.model, 256))
    || typeof judge.judge !== "function"
  ) {
    throw new TypeError("Judge capability is invalid");
  }
  const inputSchemaVersions = judge.inputSchemaVersions ?? [1];
  const maxTimeoutMs = judge.maxTimeoutMs ?? judge.timeoutMs;
  const maxInputBytes = judge.maxInputBytes ?? MAX_INPUT_BYTES;
  const maxOutputBytes = judge.maxOutputBytes ?? MAX_SUMMARY_BYTES;
  const requestProtocols = judge.requestProtocols ?? [];
  if (
    !Array.isArray(inputSchemaVersions)
    || inputSchemaVersions.length === 0
    || inputSchemaVersions.some((value) => ![1, 2].includes(value))
    || new Set(inputSchemaVersions).size !== inputSchemaVersions.length
    || !Number.isSafeInteger(maxTimeoutMs)
    || maxTimeoutMs < 1
    || maxTimeoutMs > MAX_TIMEOUT_MS
    || !Number.isSafeInteger(maxInputBytes)
    || maxInputBytes < 1
    || maxInputBytes > MAX_INPUT_BYTES
    || !Number.isSafeInteger(maxOutputBytes)
    || maxOutputBytes < 1
    || maxOutputBytes > MAX_SUMMARY_BYTES
    || !Array.isArray(requestProtocols)
    || requestProtocols.some((protocol) => !validJudgeRequestProtocol(protocol))
    || new Set(requestProtocols.map(({ id }) => id)).size !== requestProtocols.length
  ) {
    throw new TypeError("Judge capability is invalid");
  }
  return Object.freeze({
    ...judge,
    inputSchemaVersions: Object.freeze([...inputSchemaVersions]),
    maxTimeoutMs,
    maxInputBytes,
    maxOutputBytes,
    requestProtocols: Object.freeze([...requestProtocols]),
  });
}

function validJudgeRequestProtocol(protocol) {
  const requirements = new Set([
    "controller-transcript",
    "execution-summary",
    "workspace-artifact-metadata",
  ]);
  return !!protocol
    && typeof protocol === "object"
    && !Array.isArray(protocol)
    && protocol.schemaVersion === 1
    && /^[a-z][a-z0-9-]{0,127}$/.test(protocol.id ?? "")
    && /^sha256:[a-f0-9]{64}$/.test(protocol.fingerprint ?? "")
    && Array.isArray(protocol.requirements)
    && protocol.requirements.length >= 1
    && protocol.requirements.length <= 3
    && new Set(protocol.requirements).size === protocol.requirements.length
    && protocol.requirements.every((value) => requirements.has(value))
    && protocol.requirements.every((value, index) => (
      index === 0 || protocol.requirements[index - 1] <= value
    ))
    && Number.isSafeInteger(protocol.maxRequestBytes)
    && protocol.maxRequestBytes >= 1
    && protocol.maxRequestBytes <= MAX_INPUT_BYTES
    && typeof protocol.project === "function";
}

function protocolDescriptor(protocol) {
  return deepFreeze({
    schemaVersion: protocol.schemaVersion,
    id: protocol.id,
    fingerprint: protocol.fingerprint,
    requirements: [...protocol.requirements],
    maxRequestBytes: protocol.maxRequestBytes,
  });
}

function sameProtocol(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertProtocolSources(protocol, sources) {
  for (const requirement of protocol.requirements) {
    const available = {
      "controller-transcript": typeof sources.transcript === "string" && sources.transcript.length > 0,
      "execution-summary": !!sources.executionSummary && typeof sources.executionSummary === "object",
      "workspace-artifact-metadata": Array.isArray(sources.workspaceArtifacts),
    }[requirement];
    if (!available) throw new JudgeInputError(`Judge request source '${requirement}' is unavailable`);
  }
}

function requestProtocolIdentity(deterministic) {
  return deepFreeze({
    runId: deterministic.id,
    snapshotFingerprint: deterministic.snapshotFingerprint,
    task: {
      id: deterministic.snapshot.task.id,
      prompt: deterministic.snapshot.task.prompt,
    },
    conditionId: deterministic.snapshot.condition.id,
    invocation: {
      repeatOrdinal: deterministic.invocation.repeatOrdinal,
      attemptOrdinal: deterministic.invocation.attemptOrdinal,
    },
  });
}

function selectedProtocolSources(protocol, sources) {
  const selected = {};
  for (const requirement of protocol.requirements) {
    if (requirement === "controller-transcript") {
      selected.transcript = sources.transcript;
    } else if (requirement === "execution-summary") {
      selected.executionSummary = structuredClone(sources.executionSummary);
    } else if (requirement === "workspace-artifact-metadata") {
      selected.workspaceArtifacts = structuredClone(sources.workspaceArtifacts);
    }
  }
  return deepFreeze(selected);
}

function projectJudgeRequest({ capability, deterministic, sources, plan, redactText }) {
  const selected = plan.requestProtocol;
  const implementation = capability.requestProtocols.find((candidate) => (
    sameProtocol(protocolDescriptor(candidate), selected)
  ));
  if (!implementation) throw new JudgeInputError("Judge request protocol is unavailable");
  assertProtocolSources(selected, sources);
  let request;
  try {
    request = implementation.project(deepFreeze({
      identity: requestProtocolIdentity(deterministic),
      sources: selectedProtocolSources(selected, sources),
      rubric: plan.rubric,
    }));
  } catch {
    throw new JudgeInputError("Judge request protocol failed");
  }
  if (
    !request
    || typeof request !== "object"
    || Array.isArray(request)
    || request.schemaVersion !== 1
    || request.protocolId !== selected.id
    || request.protocolFingerprint !== selected.fingerprint
    || !nonblankBounded(request.systemPrompt, selected.maxRequestBytes)
    || !nonblankBounded(request.userPrompt, selected.maxRequestBytes)
    || redactText(request.systemPrompt) !== request.systemPrompt
    || redactText(request.userPrompt) !== request.userPrompt
    || Buffer.byteLength(JSON.stringify(request)) > selected.maxRequestBytes
  ) {
    throw new JudgeInputError("Judge request protocol returned an invalid request");
  }
  return deepFreeze(structuredClone(request));
}

function preparedProtocolRequest(kind, deterministic, input = null) {
  return deepFreeze({
    kind,
    runId: deterministic.id,
    snapshotFingerprint: deterministic.snapshotFingerprint,
    input,
  });
}

function protocolInputFromPreparation(prepared, deterministic) {
  if (
    !prepared
    || !["ready", "unavailable"].includes(prepared.kind)
    || prepared.runId !== deterministic.id
    || prepared.snapshotFingerprint !== deterministic.snapshotFingerprint
  ) {
    throw new JudgeInputError("Judge request protocol preparation is invalid");
  }
  if (prepared.kind === "unavailable") {
    throw new JudgeInputError("Judge request protocol input is unavailable");
  }
  return prepared.input;
}

function canonicalInputHash(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function evidenceMetadata(reference, fallback = {}) {
  return {
    mediaType: reference?.mediaType ?? fallback.mediaType ?? "application/json",
    sha256: reference?.sha256 ?? fallback.sha256 ?? null,
    authority: reference?.authority ?? fallback.authority ?? "controller",
    producer: reference?.producer ?? fallback.producer ?? "agent",
    lifecyclePhase: reference?.lifecyclePhase ?? fallback.lifecyclePhase ?? "execute",
    trust: reference?.trust ?? fallback.trust ?? "controller_observed",
  };
}

function buildJudgeInput({ deterministic, sources, rubric, redactText }) {
  if (typeof redactText !== "function") throw new JudgeInputError("Judge redactor is unavailable");
  let remainingBytes = MAX_EVIDENCE_BYTES;
  let itemLimitReached = false;
  const evidence = [];
  const addEvidence = ({
    kind,
    name,
    reference = null,
    fallback = {},
    text = null,
    omission = null,
  }) => {
    if (evidence.length >= MAX_EVIDENCE_ITEMS) {
      if (!itemLimitReached) {
        const lastIndex = MAX_EVIDENCE_ITEMS - 1;
        evidence[lastIndex] = {
          ...evidence[lastIndex],
          name: "Additional evidence omitted",
          content: null,
          omission: "budget_exhausted",
        };
        itemLimitReached = true;
      }
      return;
    }
    const metadata = evidenceMetadata(reference, fallback);
    let content = null;
    let selectedOmission = omission;
    if (text !== null && omission === null) {
      const redacted = redactText(String(text));
      if (remainingBytes <= 0) {
        selectedOmission = "budget_exhausted";
      } else {
        content = truncateUtf8(
          redacted,
          Math.min(MAX_EVIDENCE_ITEM_BYTES, remainingBytes),
        );
        remainingBytes -= content.includedSizeBytes;
      }
    }
    evidence.push({
      kind,
      name,
      ...metadata,
      content,
      omission: selectedOmission,
    });
  };

  addEvidence({
    kind: "transcript",
    name: "Transcript",
    reference: deterministic.evidence.transcript,
    text: sources.transcript,
    omission: sources.transcript === null ? "not_captured" : null,
  });
  addEvidence({
    kind: "stderr",
    name: "Standard error",
    reference: deterministic.evidence.stderr,
    text: sources.stderr,
    omission: sources.stderr === null ? "not_captured" : null,
  });
  for (const artifact of deterministic.evidence.artifacts) {
    const captured = sources.artifacts.find((candidate) => candidate.path === artifact.path);
    addEvidence({
      kind: "artifact",
      name: artifact.path,
      reference: artifact.content,
      fallback: artifact,
      text: artifact.status === "captured" && artifact.kind === "text" && captured?.bytes
        ? Buffer.from(captured.bytes).toString("utf8")
        : null,
      omission: artifact.status === "missing"
        ? "missing"
        : artifact.status === "rejected"
          ? "rejected"
          : artifact.kind === "binary"
            ? "binary"
            : captured?.bytes
              ? null
              : "not_captured",
    });
  }
  for (const [index, collection] of (sources.egress ?? []).entries()) {
    const manifest = deterministic.evidence.egress[index];
    addEvidence({
      kind: "egress",
      name: `Egress collection ${index + 1}`,
      reference: manifest?.content ?? null,
      fallback: manifest?.provenance ?? {},
      text: JSON.stringify(collection),
    });
  }
  for (const [phase, receipt] of Object.entries(sources.lifecycle ?? {})) {
    const stored = deterministic.evidence.lifecycle?.[phase] ?? null;
    const reference = Array.isArray(stored) ? stored.at(-1) : stored;
    addEvidence({
      kind: "lifecycle",
      name: phase,
      reference,
      fallback: {
        authority: "controller",
        producer: "target-hook",
        lifecyclePhase: phase,
        trust: "target-hook",
      },
      text: JSON.stringify(receipt),
    });
  }

  const prompt = truncateUtf8(redactText(deterministic.snapshot.task.prompt), MAX_EVIDENCE_ITEM_BYTES);
  const input = {
    schemaVersion: 1,
    run: {
      id: deterministic.id,
      sourceRevision: 2,
      snapshotFingerprint: deterministic.snapshotFingerprint,
    },
    task: {
      id: deterministic.snapshot.task.id,
      prompt,
      conditionId: deterministic.snapshot.condition.id,
    },
    rubric,
    deterministic: {
      verdict: deterministic.verdict,
      verdictReasons: deterministic.verdictReasons.map((reason) => ({
        code: reason.code,
        summary: redactText(reason.summary),
        evidenceRefs: [...reason.evidenceRefs],
      })),
      checks: deterministic.checks.slice(0, MAX_CHECKS).map((check) => ({
        id: check.id,
        required: check.required ?? check.authoredAuthority === "required",
        outcome: check.outcome,
        summary: redactText(check.summary),
        evidenceRefs: [...check.evidenceRefs],
      })),
      omittedCheckCount: Math.max(0, deterministic.checks.length - MAX_CHECKS),
      integrityIssues: deterministic.integrityIssues
        .slice(0, MAX_INTEGRITY_ISSUES)
        .map((issue) => ({
          code: issue.code,
          phase: issue.phase,
          effect: issue.effect,
          message: truncateUtf8(redactText(issue.message), MAX_EVIDENCE_ITEM_BYTES),
        })),
      omittedIntegrityIssueCount: Math.max(
        0,
        deterministic.integrityIssues.length - MAX_INTEGRITY_ISSUES,
      ),
    },
    evidence,
  };
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) {
    throw new JudgeInputError("Judge input exceeds its serialized limit");
  }
  return deepFreeze(input);
}

const JUDGE_PROJECTION_SECTIONS = Object.freeze([
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
]);

function buildJudgeInputV2({ deterministic, sources, plan, redactText }) {
  if (typeof redactText !== "function") {
    throw new JudgeInputError("Judge redactor is unavailable");
  }
  const { include } = plan.projection;
  const limits = plan.projection.limits;
  const redactOutcome = (outcome) => outcome === null
    ? null
    : {
        verdict: outcome.verdict,
        verdictReasons: outcome.verdictReasons.map((reason) => ({
          code: reason.code,
          summary: redactText(reason.summary),
          evidenceRefs: [...reason.evidenceRefs],
        })),
      };
  let remainingBytes = limits.maxEvidenceTextBytes;
  const evidence = [];
  const omissions = Object.fromEntries(
    JUDGE_PROJECTION_SECTIONS.map((section) => [
      section,
      { omittedCount: 0, reasons: [] },
    ]),
  );
  const omit = (section, count, reason) => {
    if (count < 1) return;
    omissions[section].omittedCount += count;
    if (!omissions[section].reasons.includes(reason)) {
      omissions[section].reasons.push(reason);
    }
  };
  const addEvidence = (section, {
    kind,
    name,
    reference = null,
    fallback = {},
    text = null,
    omission = null,
    projectedContent = null,
  }) => {
    if (evidence.length >= limits.maxEvidenceItems) {
      omit(section, 1, "budget-exhausted");
      return;
    }
    const metadata = evidenceMetadata(reference, fallback);
    let content = null;
    let selectedOmission = omission;
    if (text !== null && omission === null) {
      if (remainingBytes <= 0) {
        selectedOmission = "budget_exhausted";
        omit(section, 1, "budget-exhausted");
      } else {
        const budget = Math.min(limits.maxEvidenceItemBytes, remainingBytes);
        content = projectedContent ?? truncateUtf8(redactText(String(text)), budget);
        remainingBytes -= content.includedSizeBytes;
      }
    }
    evidence.push({
      kind,
      name,
      ...metadata,
      content,
      omission: selectedOmission,
    });
  };

  if (include.transcript) {
    if (plan.projection.schemaVersion === 2 && sources.transcript !== null) {
      const parts = projectJudgeTranscript(redactText(String(sources.transcript)), {
        maxItemBytes: limits.maxEvidenceItemBytes,
        maxTextBytes: remainingBytes,
        maxItems: limits.maxEvidenceItems - evidence.length,
      });
      if (parts === null) {
        throw new JudgeInputError("Transcript structure cannot fit the Judge evidence budget");
      }
      for (const [index, part] of parts.entries()) {
        addEvidence("transcript", {
          kind: "transcript",
          name: parts.length === 1 ? "Transcript" : `Transcript (part ${index + 1} of ${parts.length})`,
          reference: deterministic.evidence.transcript,
          text: part.content,
          projectedContent: part,
        });
      }
    } else {
      addEvidence("transcript", {
        kind: "transcript",
        name: "Transcript",
        reference: deterministic.evidence.transcript,
        text: sources.transcript,
        omission: sources.transcript === null ? "not_captured" : null,
      });
    }
  } else {
    omit("transcript", 1, "profile-excluded");
  }
  if (include.stderr) {
    addEvidence("stderr", {
      kind: "stderr",
      name: "Standard error",
      reference: deterministic.evidence.stderr,
      text: sources.stderr,
      omission: sources.stderr === null ? "not_captured" : null,
    });
  } else {
    omit("stderr", 1, "profile-excluded");
  }

  if (include.textArtifacts) {
    for (const artifact of deterministic.evidence.artifacts) {
      if (artifact.kind !== "text") {
        omit("textArtifacts", 1, "binary");
        continue;
      }
      const captured = sources.artifacts.find(
        (candidate) => candidate.path === artifact.path,
      );
      addEvidence("textArtifacts", {
        kind: "artifact",
        name: artifact.path,
        reference: artifact.content,
        fallback: artifact,
        text: artifact.status === "captured" && captured?.bytes
          ? Buffer.from(captured.bytes).toString("utf8")
          : null,
        omission: artifact.status === "missing"
          ? "missing"
          : artifact.status === "rejected"
            ? "rejected"
            : captured?.bytes
              ? null
              : "not_captured",
      });
    }
  } else {
    omit("textArtifacts", deterministic.evidence.artifacts.length, "profile-excluded");
  }

  if (include.egress) {
    for (const [index, collection] of (sources.egress ?? []).entries()) {
      const manifest = deterministic.evidence.egress[index];
      addEvidence("egress", {
        kind: "egress",
        name: `Egress collection ${index + 1}`,
        reference: manifest?.content ?? null,
        fallback: manifest?.provenance ?? {},
        text: JSON.stringify(collection),
      });
    }
  } else {
    omit("egress", deterministic.evidence.egress.length, "profile-excluded");
  }

  if (include.lifecycleReceipts) {
    for (const [phase, receipt] of Object.entries(sources.lifecycle ?? {})) {
      const stored = deterministic.evidence.lifecycle?.[phase] ?? null;
      const reference = Array.isArray(stored) ? stored.at(-1) : stored;
      addEvidence("lifecycleReceipts", {
        kind: "lifecycle",
        name: phase,
        reference,
        fallback: {
          authority: "controller",
          producer: "target-hook",
          lifecyclePhase: phase,
          trust: "target-hook",
        },
        text: JSON.stringify(receipt),
      });
    }
  } else {
    omit(
      "lifecycleReceipts",
      Object.keys(sources.lifecycle ?? {}).length,
      "profile-excluded",
    );
  }

  const selectedChecks = deterministic.checks.filter((check) => (
    check.effectiveAuthority !== "disabled"
    && (
      (check.effectiveAuthority === "required" && include.requiredChecks)
      || (check.effectiveAuthority === "advisory" && include.advisoryChecks)
    )
  ));
  const requiredOmitted = deterministic.checks.filter((check) => (
    check.effectiveAuthority === "required" && !include.requiredChecks
  )).length;
  const advisoryOmitted = deterministic.checks.filter((check) => (
    check.effectiveAuthority === "advisory" && !include.advisoryChecks
  )).length;
  omit("requiredChecks", requiredOmitted, "profile-excluded");
  omit("advisoryChecks", advisoryOmitted, "profile-excluded");
  if (selectedChecks.length > limits.maxChecks) {
    const overflow = selectedChecks.slice(limits.maxChecks);
    omit(
      "requiredChecks",
      overflow.filter(({ effectiveAuthority }) => effectiveAuthority === "required").length,
      "budget-exhausted",
    );
    omit(
      "advisoryChecks",
      overflow.filter(({ effectiveAuthority }) => effectiveAuthority === "advisory").length,
      "budget-exhausted",
    );
  }
  const checks = selectedChecks.slice(0, limits.maxChecks).map((check) => ({
    id: check.id,
    authoredAuthority: check.authoredAuthority,
    effectiveAuthority: check.effectiveAuthority,
    outcome: check.outcome,
    summary: redactText(check.summary),
    evidenceRefs: [...check.evidenceRefs],
  }));

  const runTrustReasons = include.runTrustIssues
    ? deterministic.runTrust.reasons.slice(0, limits.maxRunTrustIssues).map((reason) => ({
        ...reason,
        summary: redactText(reason.summary),
      }))
    : [];
  if (!include.runTrustIssues) {
    omit("runTrustIssues", deterministic.runTrust.reasons.length, "profile-excluded");
  } else if (deterministic.runTrust.reasons.length > limits.maxRunTrustIssues) {
    omit(
      "runTrustIssues",
      deterministic.runTrust.reasons.length - limits.maxRunTrustIssues,
      "budget-exhausted",
    );
  }
  if (!include.baselineDeterministicOutcome) {
    omit("baselineDeterministicOutcome", 1, "profile-excluded");
  }
  if (!include.effectiveDeterministicOutcome) {
    omit("effectiveDeterministicOutcome", 1, "profile-excluded");
  }

  const input = {
    schemaVersion: 2,
    run: {
      id: deterministic.id,
      sourceRevision: 2,
      snapshotFingerprint: deterministic.snapshotFingerprint,
    },
    authority: {
      profileId: deterministic.snapshot.evaluation.authority.id,
      kind: deterministic.snapshot.evaluation.authority.kind,
    },
    task: {
      id: deterministic.snapshot.task.id,
      prompt: truncateUtf8(
        redactText(deterministic.snapshot.task.prompt),
        limits.maxEvidenceItemBytes,
      ),
      conditionId: deterministic.snapshot.condition.id,
    },
    rubric: plan.rubric,
    redaction: { status: "applied" },
    deterministic: {
      baseline: include.baselineDeterministicOutcome
        ? redactOutcome(deterministic.deterministic.baseline)
        : null,
      effective: include.effectiveDeterministicOutcome
        ? redactOutcome(deterministic.deterministic.effective)
        : null,
      checks,
      omittedCheckCount: Math.max(0, selectedChecks.length - checks.length),
    },
    runTrust: {
      status: deterministic.runTrust.status,
      reasons: runTrustReasons,
      omittedReasonCount: Math.max(
        0,
        deterministic.runTrust.reasons.length - runTrustReasons.length,
      ),
    },
    evidence,
    omissions,
  };
  if (Buffer.byteLength(JSON.stringify(input)) > limits.maxInputBytes) {
    throw new JudgeInputError("Judge input exceeds its serialized limit");
  }
  return deepFreeze(input);
}

function judgeBasis({ deterministic, rubric, input, capability }) {
  return deepFreeze({
    schemaVersion: 2,
    sourceRevision: 2,
    snapshotFingerprint: deterministic.snapshotFingerprint,
    authorityProfileId: deterministic.snapshot.evaluation.authority.id,
    rubricSha256: sha256(Buffer.from(rubric)),
    inputSha256: canonicalInputHash(input),
    judgeId: capability.id,
    model: capability.model,
  });
}

function unavailableBasis(deterministic, rubric, capability) {
  return deepFreeze({
    schemaVersion: 2,
    sourceRevision: 2,
    snapshotFingerprint: deterministic.snapshotFingerprint,
    authorityProfileId: deterministic.snapshot.evaluation.authority.id,
    rubricSha256: sha256(Buffer.from(rubric)),
    inputSha256: canonicalInputHash({
      schemaVersion: deterministic.snapshot.evaluation.authority.judge
        .capability.inputSchemaVersion,
      unavailable: true,
      runId: deterministic.id,
      sourceRevision: 2,
      snapshotFingerprint: deterministic.snapshotFingerprint,
    }),
    judgeId: capability.id,
    model: capability.model,
  });
}

function fixedErrorMessage(code) {
  return {
    "judge.cancelled": "The selected Judge was cancelled.",
    "judge.timed-out": "The selected Judge exceeded its timeout.",
    "judge.provider-failed": "The selected Judge provider failed.",
    "judge.invalid-output": "The selected Judge returned invalid output.",
    "judge.input-unavailable": "The selected Judge input could not be formed.",
  }[code];
}

async function invokeJudge(judge, input, callerSignal, timeoutMs) {
  const controller = new AbortController();
  let cancelListener = null;
  let timeout = null;
  const call = Promise.resolve()
    .then(() => judge.judge(input, { signal: controller.signal }))
    .then(
      (value) => ({ kind: "result", value }),
      () => ({ kind: "error", code: "judge.provider-failed" }),
    );
  const timeoutResult = new Promise((resolve) => {
    timeout = setTimeout(() => {
      controller.abort(new Error("Judge timeout"));
      resolve({ kind: "error", code: "judge.timed-out" });
    }, timeoutMs);
  });
  const races = [call, timeoutResult];
  if (callerSignal) {
    races.push(new Promise((resolve) => {
      cancelListener = () => {
        controller.abort(callerSignal.reason);
        resolve({ kind: "error", code: "judge.cancelled" });
      };
      if (callerSignal.aborted) cancelListener();
      else callerSignal.addEventListener("abort", cancelListener, { once: true });
    }));
  }
  try {
    return await Promise.race(races);
  } finally {
    clearTimeout(timeout);
    if (cancelListener && callerSignal && !callerSignal.aborted) {
      callerSignal.removeEventListener("abort", cancelListener);
    }
  }
}

function validateDecision(value, redactText, maxSummaryBytes) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !JUDGE_OUTCOMES.has(value.outcome)
    || typeof value.summary !== "string"
  ) {
    return null;
  }
  const summary = redactText(value.summary);
  if (!nonblankBounded(summary, maxSummaryBytes)) return null;
  return deepFreeze({ outcome: value.outcome, summary });
}

function timing(startedAt, startedMs) {
  const completedAt = new Date().toISOString();
  return {
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.now() - startedMs),
  };
}

function settleJudgeFailure({
  writer,
  pending,
  basis,
  code,
  capability,
  startedAt,
  startedMs,
}) {
  const judge = {
    schemaVersion: 2,
    kind: "error",
    basis,
    code,
    message: fixedErrorMessage(code),
    judgeId: capability.id,
    model: capability.model,
    ...timing(startedAt, startedMs),
  };
  const outcome = authoritySettlement(pending, "failed", judge);
  return writer.transition(3, deepFreeze({
    ...pending,
    revision: 4,
    ...outcome,
    judgeStatus: "failed",
    judge,
  }));
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

function authoritySettlement(record, judgeStatus, judge) {
  const evaluated = evaluateAuthority({
    taskKind: record.snapshot.evaluation.taskKind,
    authority: record.snapshot.evaluation.authority,
    runTrust: record.runTrust,
    evaluatorStatus: record.deterministic.evaluatorStatus,
    checks: rawEvaluatorChecks(record.checks),
    judgeStatus,
    judge,
  });
  return deepFreeze({
    headline: evaluated.headline,
    verdict: evaluated.headline.verdict,
    verdictReasons: evaluated.headline.verdictReasons,
  });
}

export function createJudgePhase({ writer, judge = null } = {}) {
  if (!writer || typeof writer.transition !== "function") {
    throw new TypeError("Judge phase requires Result Store write authority");
  }
  const capability = validateJudge(judge);
  return Object.freeze({
    capability: capability === null
      ? null
      : Object.freeze({
          judgeId: capability.id,
          model: capability.model,
          inputSchemaVersions: capability.inputSchemaVersions,
          maxTimeoutMs: capability.maxTimeoutMs,
          maxInputBytes: capability.maxInputBytes,
          maxOutputBytes: capability.maxOutputBytes,
          requestProtocols: capability.requestProtocols.map(protocolDescriptor),
        }),
    select(snapshot) {
      const selected = snapshot?.evaluation?.authority?.judge;
      if (!selected || selected.availability === "disabled") {
        return deepFreeze({ kind: "skip" });
      }
      if (!capability) {
        throw new JudgeSelectionInputError(
          "authority.judge-capability-missing",
          `Task '${snapshot?.task?.id ?? "unknown"}' requires a Judge capability.`,
        );
      }
      if (!nonblankBounded(selected.rubric, 64 * 1024)) {
        throw new JudgeSelectionInputError(
          "judge.rubric-invalid",
          `Task '${snapshot.task.id}' has an invalid Judge rubric.`,
        );
      }
      return deepFreeze({
        kind: "run",
        rubric: selected.rubric,
        timeoutMs: selected.timeoutMs,
        inputSchemaVersion: selected.capability.inputSchemaVersion,
        requestProtocol: selected.capability.requestProtocol ?? null,
        projection: selected.projection,
        output: selected.output,
      });
    },

    prepareRequest({ plan, deterministic, sources, redactText }) {
      if (plan.kind === "skip" || !plan.requestProtocol) {
        return deepFreeze({ kind: "deferred" });
      }
      try {
        return preparedProtocolRequest(
          "ready",
          deterministic,
          projectJudgeRequest({
            capability,
            deterministic,
            sources,
            plan,
            redactText,
          }),
        );
      } catch (error) {
        if (!(error instanceof JudgeInputError)) throw error;
        return preparedProtocolRequest("unavailable", deterministic);
      }
    },

    async settle({
      plan,
      deterministic,
      evaluatorStatus,
      sources,
      redactText,
      preparedRequest = null,
      signal = null,
    }) {
      if (plan.kind === "skip") return deterministic;
      const pending = await writer.transition(2, deepFreeze({
        ...deterministic,
        revision: 3,
        judgeStatus: "pending",
        judge: null,
      }));
      const startedMs = Date.now();
      const startedAt = new Date(startedMs).toISOString();
      let input;
      let basis;
      try {
        input = plan.requestProtocol
          ? preparedRequest
            ? protocolInputFromPreparation(preparedRequest, deterministic)
            : projectJudgeRequest({
                capability,
                deterministic,
                sources,
                plan,
                redactText,
              })
          : plan.inputSchemaVersion === 2
            ? buildJudgeInputV2({
                deterministic,
                sources,
                plan,
                redactText,
              })
            : buildJudgeInput({
                deterministic,
                sources,
                rubric: plan.rubric,
                redactText,
              });
        basis = judgeBasis({
          deterministic,
          rubric: plan.rubric,
          input,
          capability,
        });
      } catch (error) {
        if (!(error instanceof JudgeInputError)) throw error;
        basis = unavailableBasis(deterministic, plan.rubric, capability);
        return settleJudgeFailure({
          writer,
          pending,
          basis,
          code: "judge.input-unavailable",
          capability,
          startedAt,
          startedMs,
        });
      }

      const invocation = await invokeJudge(
        capability,
        input,
        signal,
        plan.timeoutMs,
      );
      if (invocation.kind === "result") {
        const decision = validateDecision(
          invocation.value,
          redactText,
          plan.output.maxSummaryBytes,
        );
        if (decision) {
          const judge = {
            schemaVersion: 2,
            kind: "result",
            basis,
            outcome: decision.outcome,
            summary: decision.summary,
            judgeId: capability.id,
            model: capability.model,
            ...timing(startedAt, startedMs),
          };
          const outcome = authoritySettlement(pending, "complete", judge);
          return writer.transition(3, deepFreeze({
            ...pending,
            revision: 4,
            ...outcome,
            judgeStatus: "complete",
            judge,
          }));
        }
      }
      const code = invocation.kind === "result"
        ? "judge.invalid-output"
        : invocation.code;
      return settleJudgeFailure({
        writer,
        pending,
        basis,
        code,
        capability,
        startedAt,
        startedMs,
      });
    },
  });
}
