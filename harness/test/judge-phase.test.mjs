import assert from "node:assert/strict";
import test from "node:test";

import { createJudgePhase } from "../lib/judge-phase.mjs";
import { canonicalRunRecordV3Fixture } from "./helpers/canonical-run-record-v3.mjs";

function requiredAuthority(kind = "hybrid") {
  return {
    schemaVersion: 1,
    id: `${kind}-v1`,
    kind,
    checkPolicy: {
      defaultRule: "authored",
      rules: [],
      unmatchedRule: "invalidate-evaluator-output",
    },
    judge: {
      availability: "required",
      capability: {
        judgeId: "controlled-judge",
        model: null,
        inputSchemaVersion: 2,
      },
      timeoutMs: 1_000,
      rubric: "Apply the rubric.",
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
    },
  };
}

function controlledJudge(judge) {
  return {
    id: "controlled-judge",
    model: null,
    inputSchemaVersions: [2],
    maxTimeoutMs: 1_000,
    maxInputBytes: 1024 * 1024,
    maxOutputBytes: 4 * 1024,
    judge,
  };
}

function noisyTranscript() {
  return [
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "docs-before", content: "Docs before " + "d".repeat(150_000) }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "run-demo", name: "Bash", input: { command: "python3 demo.py" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "run-demo", is_error: false, content: "Chat response: Paris. Image saved: 55269 bytes. Whisper: you. EXECUTION-PROOF" }] } },
    { type: "system", subtype: "task_notification", message: "Docs after " + "d".repeat(80_000) },
  ].map(frame => JSON.stringify(frame)).join("\n") + "\n";
}

async function captureProjectedTranscript(transcript, version, { maxBytes = 65_536, maxItems = 64, maxTextBytes = 524288, redactText = String } = {}) {
  const deterministic = canonicalRunRecordV3Fixture().history.at(-1);
  deterministic.snapshot.evaluation.authority = requiredAuthority("judge-primary");
  deterministic.snapshot.evaluation.authority.judge.projection.schemaVersion = version;
  deterministic.snapshot.evaluation.authority.judge.projection.limits.maxEvidenceItemBytes = maxBytes;
  deterministic.snapshot.evaluation.authority.judge.projection.limits.maxEvidenceItems = maxItems;
  deterministic.snapshot.evaluation.authority.judge.projection.limits.maxEvidenceTextBytes = maxTextBytes;
  deterministic.deterministic = { evaluatorStatus: "not_configured", baseline: null, effective: null };
  deterministic.checks = [];
  deterministic.evidence.artifacts = [];
  let providerInput = null;
  const phase = createJudgePhase({
    writer: { async transition(_revision, next) { return next; } },
    judge: controlledJudge(async input => {
      providerInput = input;
      return { outcome: "pass", summary: "Controlled result, no provider call." };
    }),
  });
  const result = await phase.settle({
    plan: phase.select(deterministic.snapshot), deterministic,
    evaluatorStatus: "not_configured",
    sources: { transcript, stderr: null, artifacts: [], egress: [], lifecycle: {} },
    redactText,
  });
  const parts = providerInput?.evidence.filter(e => e.kind === "transcript").map(e => e.content);
  return { providerInput, result, parts, transcript: parts && {
    content: parts.map(p => p.content).join(""),
    includedSizeBytes: parts.reduce((sum, p) => sum + p.includedSizeBytes, 0),
    originalSizeBytes: parts.reduce((sum, p) => sum + p.originalSizeBytes, 0),
    truncated: parts.some(p => p.truncated),
  } };
}

test("projection v2 keeps execution pairs between oversized documentation payloads", async () => {
  const raw = noisyTranscript();
  const projected = await captureProjectedTranscript(raw, 2);
  assert.equal(projected.result.judgeStatus, "complete");
  assert.match(projected.transcript.content, /EXECUTION-PROOF/);
  const frames = projected.transcript.content.trim().split("\n").map(JSON.parse);
  assert.equal(frames.length, 4);
  assert.equal(frames[1].message.content[0].id, "run-demo");
  assert.equal(frames[2].message.content[0].tool_use_id, "run-demo");
  assert.equal(frames[2].message.content[0].is_error, false);
  assert.match(frames[0].message.content[0].content, /truncated/);
  assert.match(frames[3].message, /truncated/);
  assert.equal(projected.transcript.originalSizeBytes, Buffer.byteLength(raw));
  assert.equal(projected.transcript.includedSizeBytes, Buffer.byteLength(projected.transcript.content));
  assert.ok(projected.transcript.includedSizeBytes <= 65_536);
  assert.equal(projected.transcript.truncated, true);
});

test("projection v1 retains its original byte-sliced input", async () => {
  const projected = await captureProjectedTranscript(noisyTranscript(), 1);
  assert.doesNotMatch(projected.transcript.content, /EXECUTION-PROOF/);
  assert.equal(projected.transcript.includedSizeBytes, 65_536);
  assert.equal(projected.transcript.truncated, true);
});

test("projection v2 preserves small transcripts byte-for-byte", async () => {
  const raw = ' { "type": "user", "message": "hello 🌍" }\n';
  const projected = await captureProjectedTranscript(raw, 2);
  assert.equal(projected.transcript.content, raw);
  assert.equal(projected.transcript.truncated, false);
});

test("projection v2 uses the total evidence budget for lossless ordered transcript chunks", async () => {
  const raw = Array.from({ length: 6 }, (_, i) => JSON.stringify({
    type: "user", message: { content: [{ type: "tool_result", tool_use_id: `docs-${i}`, content: "x".repeat(50_000) }] },
  })).join("\n") + "\n";
  const projected = await captureProjectedTranscript(raw, 2);
  assert.equal(projected.transcript.content, raw);
  assert.equal(projected.transcript.truncated, false);
  assert.equal(projected.parts.length, 6);
  assert.ok(projected.parts.every(p => p.includedSizeBytes <= 65_536));
  assert.ok(projected.transcript.includedSizeBytes <= 524_288);
  const entries = projected.providerInput.evidence.filter(e => e.kind === "transcript");
  assert.deepEqual(entries.map(e => e.name), Array.from({ length: 6 }, (_, i) => `Transcript (part ${i + 1} of 6)`));
  assert.ok(entries.every(e => e.sha256 === entries[0].sha256));
});

test("projection v2 respects aggregate byte and item limits without partial transcript delivery", async () => {
  const raw = Array.from({ length: 4 }, (_, i) => JSON.stringify({
    type: "user", message: { content: [{ type: "tool_result", tool_use_id: `call-${i}`, content: "x".repeat(700) }] },
  })).join("\n");
  for (const limits of [{ maxBytes: 1024, maxItems: 2 }, { maxBytes: 1024, maxTextBytes: 2000 }]) {
    const projected = await captureProjectedTranscript(raw, 2, limits);
    assert.equal(projected.providerInput, null);
    assert.equal(projected.result.judge.code, "judge.input-unavailable");
  }
});

test("projection v2 never alters failure flags or unsafe numeric metadata while compacting", async () => {
  const frame = {
    type: "user", message: { content: [{ type: "tool_result", tool_use_id: "failed-call", is_error: true, content: "Failed. " + "x".repeat(80_000) }] },
    exit_code: 7,
  };
  const projected = await captureProjectedTranscript(JSON.stringify(frame), 2);
  const result = JSON.parse(projected.transcript.content);
  assert.equal(result.message.content[0].is_error, true);
  assert.equal(result.message.content[0].tool_use_id, "failed-call");
  assert.equal(result.exit_code, 7);
  for (const unsafe of ["9007199254740993", "1e400", "-0"]) {
    const raw = JSON.stringify(frame).replace('"exit_code":7', `"exit_code":${unsafe}`);
    const blocked = await captureProjectedTranscript(raw, 2);
    assert.equal(blocked.providerInput, null);
    assert.equal(blocked.result.judge.code, "judge.input-unavailable");
  }
});

test("projection v2 redacts before compacting and stays valid with escaped Unicode", async () => {
  const raw = noisyTranscript().replaceAll("d".repeat(50), '\\uD83C\\uDF0D'.repeat(25)).replace("EXECUTION-PROOF", "SECRET EXECUTION-PROOF");
  const projected = await captureProjectedTranscript(raw, 2, {
    maxBytes: 4096, redactText: text => String(text).replaceAll("SECRET", "<REDACTED>"),
  });
  assert.doesNotMatch(JSON.stringify(projected.providerInput), /SECRET/);
  assert.match(projected.transcript.content, /<REDACTED> EXECUTION-PROOF/);
  for (const frame of projected.transcript.content.trim().split("\n")) JSON.parse(frame);
  assert.ok(projected.parts.every(part => Buffer.byteLength(part.content) <= 4096));
});

test("projection v2 fails closed instead of dropping frames or cutting malformed JSONL", async () => {
  for (const raw of [
    "not json " + "x".repeat(10_000),
    Array.from({ length: 100 }, (_, i) => JSON.stringify({ type: "tool_use", id: `call-${i}`, name: "Bash" })).join("\n"),
    JSON.stringify({ type: "tool_result", tool_use_id: "x".repeat(10_000), content: "identity must not be shortened" }),
    " ".repeat(10_000),
  ]) {
    const projected = await captureProjectedTranscript(raw, 2, { maxBytes: 1024, maxTextBytes: 1024 });
    assert.equal(projected.providerInput, null);
    assert.equal(projected.result.judgeStatus, "failed");
    assert.equal(projected.result.verdict, "unknown");
    assert.equal(projected.result.judge.code, "judge.input-unavailable");
  }
});

test("Judge input redacts deterministic verdict reasons before provider delivery", async () => {
  const secret = "deterministic-summary-secret";
  const deterministic = canonicalRunRecordV3Fixture().history.at(-1);
  deterministic.snapshot.evaluation.authority = requiredAuthority();
  deterministic.checks[0].summary = `Required check passed with ${secret}.`;
  deterministic.deterministic.baseline.verdictReasons[0].summary = `All checks passed with ${secret}.`;
  deterministic.deterministic.effective.verdictReasons[0].summary = `All checks passed with ${secret}.`;
  deterministic.evidence.transcript = null;
  deterministic.evidence.stderr = null;
  deterministic.evidence.artifacts.push({
    path: "rejected.txt",
    kind: "text",
    required: false,
    status: "rejected",
    reason: "unsafe-path",
    provenance: "controller_sealed_workspace_file",
    authority: "controller",
    producer: "agent",
    lifecyclePhase: "seal",
    capturedAt: "2026-08-22T10:00:00.000Z",
    trust: "controller_sealed",
    content: null,
  });
  deterministic.evidence.artifacts.push(...Array.from({ length: 65 }, (_, index) => ({
    path: `extra-${index}.txt`,
    kind: "text",
    required: false,
    status: "missing",
    reason: "not-produced",
    provenance: "controller_sealed_workspace_file",
    authority: "controller",
    producer: "agent",
    lifecyclePhase: "seal",
    capturedAt: "2026-08-22T10:00:00.000Z",
    trust: "controller_sealed",
    content: null,
  })));
  let providerInput = null;
  const phase = createJudgePhase({
    writer: {
      async transition(_expectedRevision, next) {
        return next;
      },
    },
    judge: controlledJudge(async (input) => {
        providerInput = input;
        return { outcome: "pass", summary: "The rubric passed." };
      }),
  });

  await phase.settle({
    plan: phase.select(deterministic.snapshot),
    deterministic,
    evaluatorStatus: "complete",
    sources: {
      transcript: null,
      stderr: null,
      artifacts: [],
      egress: [],
      lifecycle: {},
    },
    redactText(value) {
      return String(value).replaceAll(secret, "<REDACTED>");
    },
  });

  assert.doesNotMatch(JSON.stringify(providerInput), new RegExp(secret));
  assert.equal(
    providerInput.deterministic.effective.verdictReasons[0].summary,
    "All checks passed with <REDACTED>.",
  );
  assert.equal(providerInput.evidence[0].kind, "transcript");
  assert.equal(providerInput.evidence[0].omission, "not_captured");
  assert.equal(providerInput.evidence[1].kind, "stderr");
  assert.equal(providerInput.evidence[1].omission, "not_captured");
  assert.equal(
    providerInput.evidence.find(({ name }) => name === "missing.txt").omission,
    "missing",
  );
  assert.equal(
    providerInput.evidence.find(({ name }) => name === "rejected.txt").omission,
    "rejected",
  );
  assert.equal(providerInput.evidence.length, 64);
  assert.deepEqual(providerInput.omissions.textArtifacts, {
    omittedCount: 7,
    reasons: ["binary", "budget-exhausted"],
  });
});

test("Judge Input v2 represents a Judge-primary Task without deterministic outcomes", async () => {
  const deterministic = canonicalRunRecordV3Fixture().history.at(-1);
  deterministic.snapshot.evaluation.authority = requiredAuthority("judge-primary");
  deterministic.deterministic = {
    evaluatorStatus: "not_configured",
    baseline: null,
    effective: null,
  };
  deterministic.checks = [];
  let providerInput = null;
  const phase = createJudgePhase({
    writer: {
      async transition(_expectedRevision, next) {
        return next;
      },
    },
    judge: controlledJudge(async (input) => {
      providerInput = input;
      return { outcome: "pass", summary: "The rubric passed." };
    }),
  });

  const result = await phase.settle({
    plan: phase.select(deterministic.snapshot),
    deterministic,
    evaluatorStatus: "not_configured",
    sources: {
      transcript: null,
      stderr: null,
      artifacts: [],
      egress: [],
      lifecycle: {},
    },
    redactText: String,
  });

  assert.equal(providerInput.deterministic.baseline, null);
  assert.equal(providerInput.deterministic.effective, null);
  assert.equal(result.headline.verdict, "pass");
  assert.equal(result.headline.decidedBy, "judge");
});

test("a snapshotted request protocol projects exact Judge bytes and fails on redaction drift", async () => {
  const protocol = {
    schemaVersion: 1,
    id: "legacy-audit-v1",
    fingerprint: `sha256:${"a".repeat(64)}`,
    requirements: [
      "controller-transcript",
      "execution-summary",
      "workspace-artifact-metadata",
    ],
    maxRequestBytes: 1_048_576,
  };
  const deterministic = canonicalRunRecordV3Fixture().history.at(-1);
  deterministic.snapshot.evaluation.authority = requiredAuthority("judge-primary");
  deterministic.snapshot.evaluation.authority.judge.capability.requestProtocol = protocol;
  deterministic.deterministic = {
    evaluatorStatus: "not_configured",
    baseline: null,
    effective: null,
  };
  deterministic.checks = [];
  let providerInput = null;
  let projectionContext = null;
  const phase = createJudgePhase({
    writer: {
      async transition(_expectedRevision, next) {
        return next;
      },
    },
    judge: {
      ...controlledJudge(async (input) => {
        providerInput = input;
        return { outcome: "pass", summary: "Exact legacy verdict." };
      }),
      requestProtocols: [{
        ...protocol,
        project(context) {
          projectionContext = context;
          return {
            schemaVersion: 1,
            protocolId: protocol.id,
            protocolFingerprint: protocol.fingerprint,
            systemPrompt: "exact system prompt",
            userPrompt: `exact user prompt\n${context.sources.transcript}`,
          };
        },
      }],
    },
  });

  const result = await phase.settle({
    plan: phase.select(deterministic.snapshot),
    deterministic,
    evaluatorStatus: "not_configured",
    sources: {
      transcript: "controller transcript",
      stderr: null,
      artifacts: [],
      workspaceArtifacts: [{ path: "app.py", bytes: 12 }],
      egress: [],
      lifecycle: {},
      executionSummary: { reportedResult: "pass", durationSeconds: 42 },
    },
    redactText: String,
  });

  assert.equal(result.headline.verdict, "pass");
  assert.deepEqual(projectionContext.identity, {
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
  assert.deepEqual(Object.keys(projectionContext.sources).sort(), [
    "executionSummary",
    "transcript",
    "workspaceArtifacts",
  ]);
  assert.equal(Object.hasOwn(projectionContext.sources, "stderr"), false);
  assert.equal(Object.hasOwn(projectionContext.sources, "artifacts"), false);
  assert.deepEqual(projectionContext.sources.workspaceArtifacts, [
    { path: "app.py", bytes: 12 },
  ]);
  assert.deepEqual(providerInput, {
    schemaVersion: 1,
    protocolId: protocol.id,
    protocolFingerprint: protocol.fingerprint,
    systemPrompt: "exact system prompt",
    userPrompt: "exact user prompt\ncontroller transcript",
  });

  let invoked = false;
  const blockedPhase = createJudgePhase({
    writer: {
      async transition(_expectedRevision, next) {
        return next;
      },
    },
    judge: {
      ...controlledJudge(async () => {
        invoked = true;
        return { outcome: "pass", summary: "must not run" };
      }),
      requestProtocols: [{
        ...protocol,
        project() {
          return {
            schemaVersion: 1,
            protocolId: protocol.id,
            protocolFingerprint: protocol.fingerprint,
            systemPrompt: "exact system prompt",
            userPrompt: "contains SECRET",
          };
        },
      }],
    },
  });
  const blocked = await blockedPhase.settle({
    plan: blockedPhase.select(deterministic.snapshot),
    deterministic,
    evaluatorStatus: "not_configured",
    sources: {
      transcript: "controller transcript",
      stderr: null,
      artifacts: [],
      workspaceArtifacts: [],
      egress: [],
      lifecycle: {},
      executionSummary: { reportedResult: "pass", durationSeconds: 42 },
    },
    redactText(value) {
      return String(value).replaceAll("SECRET", "<REDACTED>");
    },
  });
  assert.equal(invoked, false);
  assert.equal(blocked.judgeStatus, "failed");
  assert.equal(blocked.judge.code, "judge.input-unavailable");
});
