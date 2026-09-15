import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openLocalResultStoreReader,
} from "../../harness/lib/local-result-store-reader.mjs";
import {
  createCanonicalDashboardProjection,
} from "../lib/canonical-dashboard-projection.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../../harness/test/fixtures/canonical-run-record-v2.json", import.meta.url),
  "utf8",
));
const completeRecord = fixture.history.at(-1);

test("Judge status distinguishes code-only runs from a configured Judge that did not run", async () => {
  for (const [availability, status, expected] of [
    ["disabled", "not_requested", "Not used"],
    ["required", "not_requested", "Not run"],
    ["required", "pending", "Pending"],
    ["required", "failed", "Failed"],
    ["required", "complete", "Complete"],
  ]) {
    const record = structuredClone(completeRecord);
    record.snapshot.evaluation = { authority: { judge: { availability } } };
    record.judgeStatus = status;
    const before = structuredClone(record);
    const projection = createCanonicalDashboardProjection(fixtureReader(record));
    const detail = await projection.findSession(`canonical--${record.id}`);
    assert.equal(detail.judgeStatusLabel, expected);
    assert.equal(detail.result, record.verdict, "Judge display must not change the Decision");
    assert.deepEqual(record, before);
  }
  const old = createCanonicalDashboardProjection(fixtureReader());
  assert.equal((await old.findSession(`canonical--${completeRecord.id}`)).judgeStatusLabel, "Not used");
});

test("the Viewer shows recorded tool versions without inferring versions for old runs", async () => {
  const record = structuredClone(completeRecord);
  const versions = { runner: "2.1.263", node: "22.19.0", python: "3.12.9", pip: null };
  record.metrics.adapters[record.snapshot.agent.adapterId] = { toolVersions: versions };
  const projection = createCanonicalDashboardProjection(fixtureReader(record));
  const [summary] = await projection.listSessions(record.experimentVersion);
  assert.deepEqual(summary.toolVersions, versions);
  const detail = await projection.findSession(summary.id);
  assert.equal(detail.agentVersion, "2.1.263");
  assert.deepEqual(detail.toolVersions, versions);
  const older = createCanonicalDashboardProjection(fixtureReader());
  assert.equal((await older.findSession(`canonical--${completeRecord.id}`)).agentVersion, null);
  assert.equal(completeRecord.metrics.adapters[completeRecord.snapshot.agent.adapterId]?.toolVersions, undefined);
});

test("the Viewer bounds the tool-version metadata projection", async () => {
  for (const value of [null, [], "2.1.263", { runner: { bad: true }, node: "v22.0.0", python: "x".repeat(1_000), pip: "25.1.1", extra: "hidden" }]) {
    const record = structuredClone(completeRecord);
    record.metrics.adapters[record.snapshot.agent.adapterId] = { toolVersions: value };
    const projection = createCanonicalDashboardProjection(fixtureReader(record));
    const [summary] = await projection.listSessions(record.experimentVersion);
    assert.deepEqual(summary.toolVersions, value && !Array.isArray(value) && typeof value === "object"
      ? { runner: null, node: null, python: null, pip: "25.1.1" } : null);
    assert.equal((await projection.findSession(summary.id)).agentVersion, null);
  }
});

test("ordinary unversioned runs have a selectable dashboard bucket without rewriting records", async () => {
  const record = structuredClone(completeRecord);
  record.experimentVersion = null;
  const explicit = structuredClone(record);
  explicit.id = "run_22222222-2222-4222-8222-222222222222";
  explicit.experimentVersion = "__tae_unversioned__";
  const projection = createCanonicalDashboardProjection({
    ...fixtureReader(record), async listRuns() { return [record, explicit]; },
  });
  const versions = await projection.listVersions();
  const unversioned = versions.find(version => version.name === "Unversioned runs");
  assert.ok(unversioned?.id, "Home needs a nonempty selectable version ID");
  const sessions = await projection.listSessions(unversioned.id);
  assert.deepEqual(sessions.map(session => session.canonicalRunId), [record.id]);
  assert.equal(sessions[0].version, unversioned.id);
  assert.equal(sessions[0].result, record.verdict);
  assert.equal(new Set(versions.map(version => version.id)).size, 2);
  assert.equal(record.experimentVersion, null);
});

function fixtureReader(record = completeRecord) {
  return {
    async listRuns() {
      return [record];
    },
    async getRun(id) {
      return id === record.id ? record : null;
    },
    async getRunHistory() {
      throw new Error("dashboard projection must not inspect Run history");
    },
    async readEvidence() {
      throw new Error("dashboard listing must not read evidence bytes");
    },
  };
}

function seedFixtureStore(root) {
  const runRoot = join(root, "runs", completeRecord.id);
  const revisionsRoot = join(runRoot, "revisions");
  const blobsRoot = join(runRoot, "blobs");
  mkdirSync(revisionsRoot, { recursive: true });
  mkdirSync(blobsRoot, { recursive: true });
  fixture.history.forEach((record, revision) => {
    writeFileSync(
      join(revisionsRoot, `${String(revision).padStart(6, "0")}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  });
  for (const [key, base64] of Object.entries(fixture.blobs)) {
    writeFileSync(join(blobsRoot, key), Buffer.from(base64, "base64"));
  }
}

test("canonical local runs list through the mature dashboard without copying or rescoring", async () => {
  const projection = createCanonicalDashboardProjection(fixtureReader());

  assert.deepEqual(await projection.listVersions(), [{
    id: "viewer-fixture-v1",
    name: "viewer-fixture-v1",
    description: "Canonical Run Records",
    kind: "experiment",
    runAt: "2026-08-21T10:00:05.000Z",
    createdAt: "2026-08-21T10:00:05.000Z",
    model: "claude-sonnet-4-5",
    ccVersion: null,
  }]);

  const sessions = await projection.listSessions("viewer-fixture-v1");
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], {
    id: `canonical--${completeRecord.id}`,
    canonicalRunId: completeRecord.id,
    snapshotFingerprint: completeRecord.snapshotFingerprint,
    sourceKind: "canonical",
    createdAt: new Date("2026-08-21T10:00:05.000Z"),
    version: "viewer-fixture-v1",
    run: "run1",
    agent: "CC",
    agentName: "Claude Code",
    configId: "default",
    configLabel: "Default",
    configFull: "default — Default",
    configDir: "default",
    model: "claude-sonnet-4-5",
    modelResolved: "claude-sonnet-4-5-20250929",
    task: "copy-message",
    taskName: "copy-message",
    durationSec: 4,
    corrections: 0,
    passed: true,
    result: "pass",
    rawResult: "pass",
    auditVerdict: null,
    manualOverride: null,
    toolCalls: 7,
    totalTokensIn: 1_234,
    costUsd: 0.42,
    mcpCalls: 0,
    skillInjections: 0,
    injectedSkills: [],
    mcpMethods: [],
    toolVersions: null,
    failureAnalysis: null,
    failureReview: null,
    note: "checks.required-pass: All required checks passed.\n"
      + "style-note fail — An advisory style signal did not pass.",
    prompt: "Copy the fixture into answer.txt.",
    gradingCriteria: null,
    needsFollowup: false,
    followupReason: null,
    docsCandidateCount: 0,
    docsCandidateStatuses: [],
  });
});

test("canonical dashboard detail reads only the selected digest-verified transcript", async () => {
  const calls = [];
  const transcript = Buffer.from(fixture.blobs[completeRecord.evidence.transcript.key], "base64");
  const reader = fixtureReader();
  reader.readEvidence = async (reference, options) => {
    calls.push({ reference, options });
    return transcript;
  };
  const projection = createCanonicalDashboardProjection(reader);

  const detail = await projection.findSession(`canonical--${completeRecord.id}`);

  assert.equal(detail.canonicalRunId, completeRecord.id);
  assert.equal(detail.sourceKind, "canonical");
  assert.equal(detail.readOnly, true);
  assert.equal("canonicalDetailHref" in detail, false);
  assert.equal(detail.sessionJsonl, transcript.toString("utf8"));
  assert.equal(detail.claudeSessionId, "session_viewer_fixture");
  assert.equal(detail.deepAudit, null);
  assert.deepEqual(detail.storedChecks, completeRecord.checks);
  assert.deepEqual(detail.evaluatorSources, []);
  assert.deepEqual(calls, [{
    reference: completeRecord.evidence.transcript,
    options: { maxBytes: 32 * 1024 * 1024 },
  }]);
});

test("canonical dashboard explains Run Trust failures before downstream check symptoms", async () => {
  const record = structuredClone(completeRecord);
  record.headline = {
    verdict: "incomplete",
    decidedBy: "effective-deterministic",
    verdictReasons: [{ code: "check.artifact", summary: "answer.txt was unavailable." }],
  };
  record.verdict = "incomplete";
  record.verdictReasons = record.headline.verdictReasons;
  record.runTrust = {
    schemaVersion: 1,
    status: "incomplete",
    reasons: [{
      code: "environment.nonzero-exit",
      summary: "Claude Code could not run because the Anthropic credit balance is too low.",
    }],
  };
  record.checks = [{ id: "artifact", outcome: "skip", summary: "answer.txt was unavailable." }];
  const [projected] = await createCanonicalDashboardProjection(fixtureReader(record))
    .listSessions(record.experimentVersion);

  assert.equal(projected.note.split("\n")[0],
    "environment.nonzero-exit: Claude Code could not run because the Anthropic credit balance is too low.");
  assert.match(projected.note, /check\.artifact: answer\.txt was unavailable/);
});

test("canonical dashboard exposes snapshot-matched evaluator source metadata without reading its bytes", async () => {
  const record = structuredClone(completeRecord);
  const [path, sha256] = Object.entries(record.snapshot.behavior.deterministicEvaluator.modules)[0];
  record.evidence.structured = [{
    runId: record.id,
    key: sha256.slice("sha256:".length),
    mediaType: "text/javascript; charset=utf-8",
    sizeBytes: 96,
    sha256,
    provenance: `run_definition_behavior_source:${encodeURIComponent(path)}`,
    authority: "controller",
    producer: "run-engine",
    lifecyclePhase: "definition",
    capturedAt: record.createdAt,
    trust: "controller_verified",
    availability: "available",
  }];
  const reads = [];
  const transcriptBytes = Buffer.from(fixture.blobs[record.evidence.transcript.key], "base64");
  const reader = fixtureReader(record);
  reader.readEvidence = async (reference) => {
    reads.push(reference.sha256);
    return transcriptBytes;
  };

  const detail = await createCanonicalDashboardProjection(reader)
    .findSession(`canonical--${record.id}`);

  assert.deepEqual(detail.evaluatorSources, [{
    path,
    sha256,
    sizeBytes: 96,
    entry: true,
  }]);
  assert.deepEqual(reads, [record.evidence.transcript.sha256]);
});

test("canonical dashboard keeps Judge truth separate and drops unreadable evidence", async () => {
  const judged = structuredClone(completeRecord);
  judged.judgeStatus = "complete";
  judged.judge = {
    kind: "result",
    outcome: "fail",
    summary: "The stored Judge rejected the answer.",
    judgeId: "legacy-score-judge-v1",
    model: "claude-opus-4-8",
    basis: { sourceRevision: 2 },
  };
  const reader = fixtureReader(judged);
  reader.readEvidence = async () => {
    throw new Error("Stored evidence does not match its manifest");
  };
  const projection = createCanonicalDashboardProjection(reader);

  const detail = await projection.findSession(`canonical--${judged.id}`);

  assert.equal(detail.sessionJsonl, null);
  assert.deepEqual(detail.deepAudit, {
    verdict: "fail",
    summary: "The stored Judge rejected the answer.",
    judgeId: "legacy-score-judge-v1",
    model: "claude-opus-4-8",
    basis: { sourceRevision: 2 },
  });
  assert.equal(await projection.findSession("canonical--../../secret"), null);
  assert.equal(await projection.findSession("canonical--run_not-a-canonical-id"), null);
});

test("canonical dashboard projects the stored deterministic result for the session review", async () => {
  const evaluated = structuredClone(completeRecord);
  evaluated.deterministic = {
    baseline: { verdict: "pass", verdictReasons: [] },
    effective: { verdict: "pass", verdictReasons: [] },
  };
  const reader = fixtureReader(evaluated);
  reader.readEvidence = async () => Buffer.from("", "utf8");
  const projection = createCanonicalDashboardProjection(reader);

  const detail = await projection.findSession(`canonical--${evaluated.id}`);

  assert.equal(detail.deterministicEffectiveVerdict, "pass");
});

test("canonical dashboard keeps absent headline unknown and never reads oversized transcript", async () => {
  const unknown = structuredClone(completeRecord);
  delete unknown.verdict;
  delete unknown.verdictReasons;
  delete unknown.headline;
  unknown.evidence.transcript.sizeBytes = 32 * 1024 * 1024 + 1;
  let evidenceReads = 0;
  const reader = fixtureReader(unknown);
  reader.readEvidence = async () => {
    evidenceReads += 1;
    return Buffer.alloc(0);
  };
  const projection = createCanonicalDashboardProjection(reader);

  const [summary] = await projection.listSessions("viewer-fixture-v1");
  const detail = await projection.findSession(summary.id);

  assert.equal(summary.result, "unknown");
  assert.equal(summary.passed, null);
  assert.equal(detail.sessionJsonl, null);
  assert.equal(evidenceReads, 0);
});

test("canonical dashboard projects a real read-only Local Result Store", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-canonical-dashboard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedFixtureStore(root);

  const reader = await openLocalResultStoreReader({ root });
  const projection = createCanonicalDashboardProjection(reader);
  const sessions = await projection.listSessions("viewer-fixture-v1");
  const detail = await projection.findSession(sessions[0].id);

  assert.equal(sessions.length, 1);
  assert.equal(detail.canonicalRunId, completeRecord.id);
  assert.match(detail.sessionJsonl, /misleading transcript/);
  assert.equal("transition" in reader, false);
  assert.equal("putEvidence" in reader, false);
});
