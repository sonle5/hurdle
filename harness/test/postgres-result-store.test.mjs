import assert from "node:assert/strict";
import {
  initializeStarterRunPlan,
  resolveStarterRunPlan,
} from "./helpers/run-plan-starter.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  closePostgresResultStore,
  openPostgresResultStore,
  openPostgresResultStoreReader,
  transitionPostgresRun,
} from "../lib/postgres-result-store.mjs";
import { applyPostgresResultStoreMigrations } from "../lib/postgres-result-store-migrations.mjs";
import { createLocalExecutionEnvironment } from "../lib/execution-environments/local.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { openLocalResultStoreReader } from "../lib/local-result-store-reader.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import {
  createPostgresTestDatabase,
  postgresTestAdminConnectionString,
} from "./helpers/postgres-test-database.mjs";
import { canonicalRunRecordV3Fixture } from "./helpers/canonical-run-record-v3.mjs";

const { Pool } = pg;
const adminConnectionString = postgresTestAdminConnectionString;
const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/canonical-run-record-v2.json", import.meta.url),
  "utf8",
));

function remoteHistory() {
  const history = structuredClone(fixture.history);
  const complete = history.at(-1);
  for (const artifact of complete.evidence.artifacts) {
    if (artifact.content) artifact.content.availability = "unavailable";
  }
  return history;
}

function canonicalReferences(record) {
  if (record.state !== "complete") return [];
  return [
    record.evidence.transcript,
    record.evidence.stderr,
    ...record.evidence.structured,
    ...record.evidence.egress.map(({ content }) => content),
    ...Object.values(record.evidence.lifecycle ?? {}).flat(),
  ].filter(Boolean);
}

async function seedFixture(pool, history) {
  const head = history.at(-1);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO tae.runs (id, current_revision, schema_version, state, target_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        head.id,
        head.revision,
        head.schemaVersion,
        head.state,
        head.snapshot.target.id,
        head.createdAt,
      ],
    );
    for (const record of history) {
      await client.query(
        "INSERT INTO tae.run_revisions (run_id, revision, record) VALUES ($1, $2, $3::jsonb)",
        [record.id, record.revision, JSON.stringify(record)],
      );
    }
    for (const reference of canonicalReferences(head)) {
      const bytes = Buffer.from(fixture.blobs[reference.key], "base64");
      await client.query(
        `INSERT INTO tae.evidence_objects
           (run_id, key, kind, size_bytes, sha256, chunk_count)
         VALUES ($1, $2, 'canonical-evidence', $3, $4, 1)`,
        [reference.runId, reference.key, bytes.byteLength, reference.sha256],
      );
      await client.query(
        `INSERT INTO tae.evidence_chunks (run_id, key, kind, ordinal, bytes)
         VALUES ($1, $2, 'canonical-evidence', 0, $3)`,
        [reference.runId, reference.key, bytes],
      );
    }
    for (const artifact of head.state === "complete" ? head.evidence.artifacts : []) {
      if (!artifact.content) continue;
      await client.query(
        `INSERT INTO tae.evidence_objects
           (run_id, key, kind, size_bytes, sha256, chunk_count)
         VALUES ($1, $2, 'output-artifact', $3, $4, 0)`,
        [
          artifact.content.runId,
          artifact.content.key,
          artifact.content.sizeBytes,
          artifact.content.sha256,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function seedLocalHistory(root, history) {
  const revisionsRoot = join(root, "runs", history[0].id, "revisions");
  mkdirSync(revisionsRoot, { recursive: true });
  history.forEach((record, revision) => {
    writeFileSync(
      join(revisionsRoot, `${String(revision).padStart(6, "0")}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  });
}

function createHermeticAdapter(scriptPath) {
  return {
    id: "postgres-hermetic",
    capabilities: ["agent.selected-context"],
    normalizeSettings({ requestedModel, settings }) {
      return { requestedModel: requestedModel ?? null, settings: settings ?? {} };
    },
    createLaunchPlan({ prompt }) {
      return {
        command: process.execPath,
        args: [scriptPath],
        env: {},
        stdin: prompt,
        timeoutMs: 5_000,
      };
    },
    decodeControllerEvidence({ stdout }) {
      return {
        transcript: stdout,
        observedModel: "test-model",
        sessionId: "postgres-test-session",
        metrics: { common: {}, adapter: {} },
      };
    },
  };
}

async function createStarterRunPlan(root, { mutateDefinition } = {}) {
  const sourceRoot = join(root, "run-plan-fixture");
  assert.equal((await initializeStarterRunPlan({ destination: sourceRoot })).ok, true);
  if (mutateDefinition) {
    const definitionPath = join(sourceRoot, "run-plan.json");
    const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
    mutateDefinition(definition);
    writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  }
  return resolveStarterRunPlan({ sourceRoot });
}

test("the Postgres migration is additive and the reader returns canonical fixture truth", {
  skip: !adminConnectionString,
}, async (t) => {
  const database = await createPostgresTestDatabase();
  const { connectionString } = database;
  const pool = new Pool({ connectionString, max: 2 });
  let store;
  t.after(async () => {
    await closePostgresResultStore(store);
    await pool.end();
    await database.cleanup();
  });
  await pool.query("CREATE TABLE sessions (id text PRIMARY KEY, result text)");
  await pool.query("INSERT INTO sessions (id, result) VALUES ('legacy-sentinel', 'pass')");

  await applyPostgresResultStoreMigrations({ connectionString });
  await applyPostgresResultStoreMigrations({ connectionString });
  assert.deepEqual(
    (await pool.query("SELECT id, result FROM sessions")).rows,
    [{ id: "legacy-sentinel", result: "pass" }],
  );

  const history = remoteHistory();
  const storedPreJudgeHistory = structuredClone(history);
  for (const record of storedPreJudgeHistory) delete record.judge;
  await seedFixture(pool, storedPreJudgeHistory);
  store = await openPostgresResultStoreReader({ connectionString });
  const complete = history.at(-1);

  assert.deepEqual(await store.getRun(complete.id), complete);
  assert.deepEqual(await store.getRunHistory(complete.id), history);
  assert.deepEqual(await store.listRuns({ targetId: "starter-target" }), [complete]);
  assert.deepEqual(await store.listRuns({ limit: 0 }), []);
  assert.deepEqual(await store.listRuns({ targetId: "another-target" }), []);

  const transcript = await store.readEvidence(
    complete.evidence.transcript,
    { maxBytes: 1024 },
  );
  assert.match(transcript.toString("utf8"), /misleading transcript/);
  await assert.rejects(
    store.readEvidence(complete.evidence.artifacts[0].content, { maxBytes: 1024 }),
    /readable Evidence Reference/,
  );
});

test("Local and Postgres readers return identical Run Record v3 history without translation", {
  skip: !adminConnectionString,
}, async (t) => {
  const database = await createPostgresTestDatabase();
  const { connectionString } = database;
  const pool = new Pool({ connectionString, max: 2 });
  const root = mkdtempSync(join(tmpdir(), "tae-v3-reader-parity-"));
  let postgresStore;
  t.after(async () => {
    await closePostgresResultStore(postgresStore);
    await pool.end();
    await database.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  await applyPostgresResultStoreMigrations({ connectionString });
  const v3 = canonicalRunRecordV3Fixture();
  for (const artifact of v3.history.at(-1).evidence.artifacts) {
    if (artifact.content) artifact.content.availability = "unavailable";
  }
  seedLocalHistory(root, v3.history);
  await seedFixture(pool, v3.history);

  const localStore = await openLocalResultStoreReader({ root });
  postgresStore = await openPostgresResultStoreReader({ connectionString });
  const id = v3.history[0].id;

  assert.deepEqual(await postgresStore.getRun(id), await localStore.getRun(id));
  assert.deepEqual(
    await postgresStore.getRunHistory(id),
    await localStore.getRunHistory(id),
  );
  assert.deepEqual(await postgresStore.listRuns(), await localStore.listRuns());
});

test("the Postgres reader performs no migration when canonical tables are absent", {
  skip: !adminConnectionString,
}, async (t) => {
  const database = await createPostgresTestDatabase();
  const { connectionString } = database;
  const pool = new Pool({ connectionString, max: 1 });
  t.after(async () => {
    await pool.end();
    await database.cleanup();
  });
  await assert.rejects(
    openPostgresResultStoreReader({ connectionString }),
    /migration|schema/i,
  );
  const result = await pool.query("SELECT to_regnamespace('tae') AS schema");
  assert.equal(result.rows[0].schema, null);
});

test("the Run Engine writes canonical evidence to Postgres and Output Artifact bytes only to the sidecar", {
  skip: !adminConnectionString,
}, async (t) => {
  const database = await createPostgresTestDatabase();
  const { connectionString } = database;
  const root = mkdtempSync(join(tmpdir(), "tae-postgres-run-"));
  const artifactRoot = join(root, "nested", "sidecar", "artifacts-v1");
  const pool = new Pool({ connectionString, max: 2 });
  let store;
  t.after(async () => {
    await closePostgresResultStore(store);
    await pool.end();
    await database.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  await applyPostgresResultStoreMigrations({ connectionString });

  const runPlan = await createStarterRunPlan(root, {
    mutateDefinition(definition) {
      definition.schemaVersion = 2;
      definition.authorityProfiles = [{
        schemaVersion: 1,
        id: "hybrid-v1",
        kind: "hybrid",
        checkPolicy: { defaultRule: "authored" },
        judge: {
          availability: "required",
          capability: {
            judgeId: "postgres-engine-judge",
            model: "judge-test-model",
            inputSchemaVersion: 2,
          },
          timeoutMs: 1_000,
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
              advisoryChecks: false,
            },
            limits: {
              maxEvidenceItems: 8,
              maxEvidenceItemBytes: 4_096,
              maxEvidenceTextBytes: 16_384,
              maxChecks: 8,
              maxRunTrustIssues: 8,
              maxInputBytes: 65_536,
            },
          },
          output: { maxSummaryBytes: 1_024 },
        },
      }];
      definition.tasks["copy-message"].evaluation.authority = {
        defaultProfileId: "hybrid-v1",
        bindings: [{
          profileId: "hybrid-v1",
          rubric: "The response must copy the fixture exactly.",
          checkRules: [{ checkId: "exact-copy", rule: "required" }],
        }],
      };
    },
  });
  const scriptPath = join(root, `agent-${randomUUID()}.mjs`);
  writeFileSync(scriptPath, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\\n`);',
    "",
  ].join("\n"));

  store = await openPostgresResultStore({ connectionString, localArtifactRoot: artifactRoot });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticAdapter(scriptPath),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge: {
      id: "postgres-engine-judge",
      model: "judge-test-model",
      inputSchemaVersions: [2],
      maxTimeoutMs: 2_000,
      maxInputBytes: 65_536,
      maxOutputBytes: 1_024,
      async judge() {
        return {
          outcome: "pass",
          summary: "The response satisfies the rubric.",
        };
      },
    },
  });
  const result = await engine.run({
    runPlan,
    taskId: "copy-message",
    conditionId: "default",
    requestedModel: "test-model",
    experimentVersion: "postgres-store-test",
  });
  assert.equal(result.status, "complete");
  assert.equal(result.runs[0].revision, 4);
  assert.equal(result.runs[0].judgeStatus, "complete");
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.verdict, "pass");
  assert.equal(record.revision, 4);
  assert.equal(record.judgeStatus, "complete");
  assert.deepEqual(
    (await store.getRunHistory(record.id)).map(({ revision, judgeStatus }) => ({
      revision,
      judgeStatus,
    })),
    [
      { revision: 0, judgeStatus: "not_requested" },
      { revision: 1, judgeStatus: "not_requested" },
      { revision: 2, judgeStatus: "not_requested" },
      { revision: 3, judgeStatus: "pending" },
      { revision: 4, judgeStatus: "complete" },
    ],
  );
  assert.equal(record.evidence.transcript.availability, "available");
  assert.equal(record.evidence.artifacts[0].status, "captured");
  assert.equal(record.evidence.artifacts[0].content.availability, "unavailable");

  const artifact = record.evidence.artifacts[0].content;
  assert.equal(
    existsSync(join(artifactRoot, "runs", record.id, "artifacts", artifact.key)),
    true,
  );
  assert.equal(
    Number((await pool.query(
      "SELECT count(*) AS count FROM tae.evidence_chunks WHERE run_id = $1 AND key = $2",
      [record.id, artifact.key],
    )).rows[0].count),
    0,
  );
  assert.ok(Number((await pool.query(
    "SELECT count(*) AS count FROM tae.evidence_chunks WHERE run_id = $1",
    [record.id],
  )).rows[0].count) > 0);
  assert.equal(
    (await store.readEvidence(record.evidence.transcript, { maxBytes: 4096 }))
      .toString("utf8"),
    '{"type":"result","subtype":"success"}\n',
  );
  await assert.rejects(
    store.readEvidence(artifact, { maxBytes: 4096 }),
    /readable Evidence Reference/,
  );
  assert.equal("transition" in store, false);
  assert.equal("putEvidence" in store, false);
});

test("binary artifact records keep Local and Postgres semantics while artifact bytes stay local", {
  skip: !adminConnectionString,
}, async (t) => {
  const database = await createPostgresTestDatabase();
  const { connectionString } = database;
  const root = mkdtempSync(join(tmpdir(), "tae-postgres-artifact-parity-"));
  const artifactRoot = join(root, "postgres-artifacts");
  const pool = new Pool({ connectionString, max: 2 });
  let postgresStore;
  t.after(async () => {
    await closePostgresResultStore(postgresStore);
    await pool.end();
    await database.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  await applyPostgresResultStoreMigrations({ connectionString });
  const runPlan = await createStarterRunPlan(root, {
    mutateDefinition(definition) {
      definition.tasks["copy-message"].outputArtifacts.push(
        ...["image.bin", "first.json", "second.json"].map(path => ({
          path, kind: "binary", maxBytes: 4096, required: false,
        })),
      );
    },
  });
  const scriptPath = join(root, "artifact-agent.mjs");
  // Deliberately omit the required answer: both stores must retain incomplete,
  // and keep these arbitrary output bytes out of the database.
  writeFileSync(scriptPath, [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync("image.bin", Buffer.from("89504e470d0a1a0a00000000", "hex"));',
    'writeFileSync("first.json", JSON.stringify({ first: true }));',
    'writeFileSync("second.json", JSON.stringify({ second: true }));',
    'process.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\\n");',
    "",
  ].join("\n"));

  const localStore = await openLocalResultStore({ root: join(root, "local-results") });
  postgresStore = await openPostgresResultStore({
    connectionString,
    localArtifactRoot: artifactRoot,
  });
  const run = async (resultStore) => createRunEngine({
    resultStore,
    agentAdapter: createHermeticAdapter(scriptPath),
    executionEnvironment: createLocalExecutionEnvironment(),
  }).run({
    runPlan,
    taskId: "copy-message",
    conditionId: "default",
    requestedModel: "test-model",
  });
  const localResult = await run(localStore);
  const postgresResult = await run(postgresStore);
  assert.equal(localResult.status, "complete", JSON.stringify(localResult));
  assert.equal(postgresResult.status, "complete", JSON.stringify(postgresResult));
  const localRecord = await localStore.getRun(localResult.runs[0].id);
  const postgresRecord = await postgresStore.getRun(postgresResult.runs[0].id);
  const semanticRecord = (record) => ({
    snapshotFingerprint: record.snapshotFingerprint,
    state: record.state,
    verdict: record.verdict,
    judgeStatus: record.judgeStatus,
    checks: record.checks.map(({ id, required, outcome, summary }) => ({
      id,
      required,
      outcome,
      summary,
    })),
    artifacts: record.evidence.artifacts.map((artifact) => ({
      path: artifact.path,
      kind: artifact.kind,
      status: artifact.status,
      sizeBytes: artifact.sizeBytes ?? null,
      sha256: artifact.sha256 ?? null,
    })),
  });
  assert.deepEqual(semanticRecord(postgresRecord), semanticRecord(localRecord));
  assert.equal(postgresRecord.verdict, "incomplete");
  const captured = postgresRecord.evidence.artifacts.filter(
    ({ status }) => status === "captured",
  );
  assert.equal(captured.length, 3);
  assert.ok(captured.every(({ content }) => content.availability === "unavailable"));
  for (const artifact of captured) {
    assert.equal(
      Number((await pool.query(
        "SELECT count(*) AS count FROM tae.evidence_chunks WHERE run_id = $1 AND key = $2",
        [postgresRecord.id, artifact.content.key],
      )).rows[0].count),
      0,
    );
  }
});

test("concurrent Postgres transitions allow exactly one expected-revision winner", {
  skip: !adminConnectionString,
}, async (t) => {
  const database = await createPostgresTestDatabase();
  const { connectionString } = database;
  const pool = new Pool({ connectionString, max: 4 });
  t.after(async () => {
    await pool.end();
    await database.cleanup();
  });
  await applyPostgresResultStoreMigrations({ connectionString });
  const history = structuredClone(fixture.history.slice(0, 2));
  await seedFixture(pool, history);
  const terminal = structuredClone(fixture.history.at(-1));
  terminal.evidence = {
    transcript: null,
    stderr: null,
    structured: [],
    artifacts: [],
    egress: [],
  };
  terminal.checks = [];
  terminal.verdict = "incomplete";
  terminal.verdictReasons = [{
    code: "test.incomplete",
    summary: "No evidence is needed for the concurrency contract.",
    evidenceRefs: [],
  }];

  const settled = await Promise.allSettled([
    transitionPostgresRun(pool, 1, terminal),
    transitionPostgresRun(pool, 1, terminal),
  ]);
  assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
  const [rejected] = settled.filter(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "RUN_REVISION_CONFLICT", rejected.reason.message);
  assert.deepEqual(
    (await pool.query(
      "SELECT revision FROM tae.run_revisions WHERE run_id = $1 ORDER BY revision",
      [terminal.id],
    )).rows.map(({ revision }) => revision),
    [0, 1, 2],
  );
  assert.equal(
    (await pool.query("SELECT current_revision FROM tae.runs WHERE id = $1", [terminal.id]))
      .rows[0].current_revision,
    2,
  );
});

test("a Postgres transition waiting on a concurrent advance reports a revision conflict", {
  skip: !adminConnectionString,
}, async (t) => {
  const database = await createPostgresTestDatabase();
  const pool = new Pool({ connectionString: database.connectionString, max: 4 });
  t.after(async () => {
    await pool.end();
    await database.cleanup();
  });
  await applyPostgresResultStoreMigrations({ connectionString: database.connectionString });
  const [queued, running] = structuredClone(fixture.history);
  await seedFixture(pool, [queued]);
  const owner = await pool.connect();
  let pending;
  try {
    await owner.query("BEGIN");
    await owner.query("SELECT id FROM tae.runs WHERE id = $1 FOR UPDATE", [queued.id]);
    pending = transitionPostgresRun(pool, 0, running).then(
      () => ({ succeeded: true }),
      error => ({ error }),
    );
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (result.rowCount > 0) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "the contender must be blocked on the owned row lock");
    await owner.query(
      "INSERT INTO tae.run_revisions (run_id, revision, record) VALUES ($1, $2, $3::jsonb)",
      [running.id, running.revision, JSON.stringify(running)],
    );
    await owner.query("UPDATE tae.runs SET current_revision = $2, state = $3 WHERE id = $1",
      [running.id, running.revision, running.state]);
    await owner.query("COMMIT");
    const outcome = await pending;
    assert.equal(outcome.error?.code, "RUN_REVISION_CONFLICT", outcome.error?.message);
  } finally {
    await owner.query("ROLLBACK");
    owner.release();
    await pending;
  }
});

test("Postgres stores a monotonic post-complete Judge result", {
  skip: !adminConnectionString,
}, async (t) => {
  const database = await createPostgresTestDatabase();
  const { connectionString } = database;
  const pool = new Pool({ connectionString, max: 2 });
  let store;
  t.after(async () => {
    await closePostgresResultStore(store);
    await pool.end();
    await database.cleanup();
  });
  await applyPostgresResultStoreMigrations({ connectionString });
  const history = remoteHistory();
  await seedFixture(pool, history);
  const complete = history.at(-1);
  const pending = {
    ...complete,
    revision: 3,
    judgeStatus: "pending",
    judge: null,
  };
  const judged = {
    ...pending,
    revision: 4,
    judgeStatus: "complete",
    judge: {
      schemaVersion: 1,
      kind: "result",
      basis: {
        sourceRevision: 2,
        snapshotFingerprint: complete.snapshotFingerprint,
        rubricSha256: `sha256:${"a".repeat(64)}`,
        inputSha256: `sha256:${"b".repeat(64)}`,
      },
      outcome: "fail",
      summary: "The response missed the rubric.",
      judgeId: "postgres-contract-judge",
      model: "judge-test-model",
      startedAt: "2026-08-22T10:00:00.000Z",
      completedAt: "2026-08-22T10:00:00.010Z",
      durationMs: 10,
    },
    verdict: "fail",
    verdictReasons: [{
      code: "judge.rubric-fail",
      summary: "The optional Judge returned fail.",
      evidenceRefs: [],
    }],
  };

  await transitionPostgresRun(pool, 2, pending);
  await transitionPostgresRun(pool, 3, judged);
  store = await openPostgresResultStoreReader({ connectionString });
  assert.deepEqual(await store.getRun(complete.id), judged);
  assert.deepEqual(
    (await store.getRunHistory(complete.id)).map(({ revision }) => revision),
    [0, 1, 2, 3, 4],
  );
});

test("Postgres refuses a terminal record whose evidence chunks have a gap", {
  skip: !adminConnectionString,
}, async (t) => {
  const database = await createPostgresTestDatabase();
  const { connectionString } = database;
  const pool = new Pool({ connectionString, max: 2 });
  t.after(async () => {
    await pool.end();
    await database.cleanup();
  });
  await applyPostgresResultStoreMigrations({ connectionString });
  const history = structuredClone(fixture.history.slice(0, 2));
  await seedFixture(pool, history);
  const terminal = structuredClone(fixture.history.at(-1));
  terminal.evidence = {
    transcript: null,
    stderr: null,
    structured: [],
    artifacts: [],
    egress: [],
  };
  terminal.checks = [];
  terminal.verdict = "incomplete";
  terminal.verdictReasons = [{
    code: "test.incomplete",
    summary: "The transcript is present only to exercise chunk validation.",
    evidenceRefs: [],
  }];
  const bytes = Buffer.from("controller transcript");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const key = digest.slice("sha256:".length);
  terminal.evidence.transcript = {
    runId: terminal.id,
    key,
    mediaType: "text/plain",
    sizeBytes: bytes.byteLength,
    sha256: digest,
    provenance: "test",
    authority: "controller",
    producer: "agent",
    lifecyclePhase: "execute",
    capturedAt: terminal.completedAt,
    trust: "controller_observed",
    availability: "available",
  };
  await pool.query(
    `INSERT INTO tae.evidence_objects
       (run_id, key, kind, size_bytes, sha256, chunk_count)
     VALUES ($1, $2, 'canonical-evidence', $3, $4, 1)`,
    [terminal.id, key, bytes.byteLength, digest],
  );
  await pool.query(
    `INSERT INTO tae.evidence_chunks (run_id, key, kind, ordinal, bytes)
     VALUES ($1, $2, 'canonical-evidence', 1, $3)`,
    [terminal.id, key, bytes],
  );

  await assert.rejects(
    transitionPostgresRun(pool, 1, terminal),
    /evidence is incomplete/,
  );
  assert.equal(
    (await pool.query("SELECT current_revision FROM tae.runs WHERE id = $1", [terminal.id]))
      .rows[0].current_revision,
    1,
  );
});
