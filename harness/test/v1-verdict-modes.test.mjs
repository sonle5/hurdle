import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createLocalExecutionEnvironment } from "../lib/execution-environments/local.mjs";
import {
  ANTHROPIC_JSON_JUDGE_ID,
  ANTHROPIC_JSON_JUDGE_MAX_INPUT_BYTES,
  ANTHROPIC_JSON_JUDGE_MAX_OUTPUT_BYTES,
  ANTHROPIC_JSON_JUDGE_MAX_TIMEOUT_MS,
} from "../lib/judges/anthropic-json.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import {
  closePostgresResultStore,
  openPostgresResultStore,
} from "../lib/postgres-result-store.mjs";
import { applyPostgresResultStoreMigrations } from "../lib/postgres-result-store-migrations.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";
import {
  createPostgresTestDatabase,
  postgresTestAdminConnectionString,
} from "./helpers/postgres-test-database.mjs";

const cliPath = fileURLToPath(new URL("../bin/hurdle.mjs", import.meta.url));
const adminConnectionString = postgresTestAdminConnectionString;

function writeTask(root) {
  const taskRoot = join(root, "tasks", "legacy-smoke");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Reply with the exact word hello.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "",
    "export default defineChecks((run) => {",
    '  run.expect.replyIncludes("hello");',
    '  run.judge("Pass only when the Agent directly demonstrates the requested result.");',
    "});",
    "",
  ].join("\n"));
}

function writeJudgeOnlyTask(root) {
  const taskRoot = join(root, "tasks", "legacy-smoke");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Reply with the exact word hello.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "",
    "export default defineChecks((run) => {",
    '  run.judge("Pass only when the Agent directly demonstrates the requested result.");',
    "});",
    "",
  ].join("\n"));
}

function writeSuite(root, verdict) {
  writeFileSync(join(root, `${verdict}.suite.mjs`), [
    'import { defineSuite } from "tae";',
    "",
    "export default defineSuite({",
    '  tasks: ["./tasks/legacy-smoke"],',
    '  agents: [{ runner: "claude-code", model: "opus" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 2,",
    `  verdict: ${JSON.stringify(verdict)},`,
    ...(verdict === "code"
      ? []
      : ['  judge: { model: "claude-opus-4-8" },']),
    "});",
    "",
  ].join("\n"));
}

test("the v1 verdict names compile to the existing closed authority profiles", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-verdicts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTask(root);

  for (const verdict of ["code", "hybrid", "judge"]) {
    writeSuite(root, verdict);
    const result = await resolveV1Suite({
      suitePath: join(root, `${verdict}.suite.mjs`),
    });
    t.after(() => result.dispose());
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.value.definition.schemaVersion, 2);

    const profile = result.value.definition.authorityProfiles[0];
    const task = result.value.definition.tasks["legacy-smoke"];
    assert.equal(profile.schemaVersion, verdict === "hybrid" ? 2 : 1);
    assert.equal(profile.kind, {
      code: "deterministic-primary",
      hybrid: "hybrid",
      judge: "judge-primary",
    }[verdict]);
    assert.equal(profile.checkPolicy.defaultRule, verdict === "judge" ? "advisory" : "authored");
    assert.equal(profile.judge.availability, verdict === "code" ? "disabled" : "required");
    if (verdict !== "code") assert.equal(profile.judge.projection.schemaVersion, 2);
    assert.equal(task.evaluation.authority.defaultProfileId, profile.id);
    assert.equal(
      task.evaluation.authority.bindings[0].rubric,
      verdict === "code"
        ? undefined
        : "Pass only when the Agent directly demonstrates the requested result.",
    );
  }
});

function writeFakeClaude(root) {
  const path = join(root, "controlled-agent.mjs");
  writeFileSync(path, [
    'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "v1-verdict-session" })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: "v1-verdict-session", model: "opus", result: "hello" })}\\n`);',
    "",
  ].join("\n"));
  return path;
}

function controlledAgent(scriptPath) {
  return {
    id: "claude-code",
    capabilities: [],
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
      const frames = stdout.trim().split("\n").map((line) => JSON.parse(line));
      const result = frames.findLast((frame) => frame.type === "result");
      return {
        transcript: `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
        observedModel: result.model,
        sessionId: result.session_id,
        metrics: { common: {}, adapter: {} },
      };
    },
  };
}

function controlledJudge(outcome) {
  return {
    id: ANTHROPIC_JSON_JUDGE_ID,
    model: "claude-opus-4-8",
    inputSchemaVersions: [2],
    maxTimeoutMs: ANTHROPIC_JSON_JUDGE_MAX_TIMEOUT_MS,
    maxInputBytes: ANTHROPIC_JSON_JUDGE_MAX_INPUT_BYTES,
    maxOutputBytes: ANTHROPIC_JSON_JUDGE_MAX_OUTPUT_BYTES,
    async judge() {
      if (outcome === "error") throw new Error("controlled provider failure");
      return { outcome, summary: `The controlled Judge returned ${outcome}.` };
    },
  };
}

test("code, hybrid, and judge settle through one Run Engine authority seam", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-verdict-engine-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTask(root);
  const command = writeFakeClaude(root);

  for (const [verdict, judgeOutcome, expected] of [
    ["code", null, "pass"],
    ["hybrid", "fail", "fail"],
    ["judge", "pass", "pass"],
  ]) {
    writeSuite(root, verdict);
    const resolved = await resolveV1Suite({
      suitePath: join(root, `${verdict}.suite.mjs`),
    });
    t.after(() => resolved.dispose());
    assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
    const store = await openLocalResultStore({ root: join(root, `results-${verdict}`) });
    const result = await createRunEngine({
      resultStore: store,
      agentAdapter: controlledAgent(command),
      executionEnvironment: createLocalExecutionEnvironment(),
      ...(judgeOutcome === null ? {} : { judge: controlledJudge(judgeOutcome) }),
    }).run({
      runPlan: resolved.value,
      taskId: "legacy-smoke",
      conditionId: "default",
      requestedModel: "opus",
      experimentVersion: `v1-${verdict}-test`,
    });

    assert.equal(result.status, "complete");
    const record = await store.getRun(result.runs[0].id);
    assert.equal(result.runs[0].verdict, expected, JSON.stringify(record));
    assert.equal(record.snapshot.agent.requestedModel, "opus");
    assert.equal(record.snapshot.evaluation.authority.kind, {
      code: "deterministic-primary",
      hybrid: "hybrid",
      judge: "judge-primary",
    }[verdict]);
    assert.equal(record.judgeStatus, verdict === "code" ? "not_requested" : "complete");
    assert.equal(
      record.snapshot.evaluation.authority.judge.availability,
      verdict === "code" ? "disabled" : "required",
    );
    if (verdict !== "code") {
      assert.equal(
        record.snapshot.evaluation.authority.judge.capability.model,
        "claude-opus-4-8",
      );
      assert.equal(
        record.snapshot.evaluation.authority.judge.rubric,
        "Pass only when the Agent directly demonstrates the requested result.",
      );
    }
    assert.equal(
      record.checks[0].effectiveAuthority,
      verdict === "judge" ? "advisory" : "required",
    );
  }
});

test("a v1 Judge-only Task omits deterministic evaluation and settles through the Judge", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-judge-only-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgeOnlyTask(root);
  writeSuite(root, "judge");
  const resolved = await resolveV1Suite({
    suitePath: join(root, "judge.suite.mjs"),
  });
  t.after(() => resolved.dispose());

  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  assert.equal(
    resolved.value.definition.tasks["legacy-smoke"].evaluation.deterministicEvaluator,
    undefined,
  );

  const store = await openLocalResultStore({ root: join(root, "results") });
  const result = await createRunEngine({
    resultStore: store,
    agentAdapter: controlledAgent(writeFakeClaude(root)),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge: controlledJudge("pass"),
  }).run({
    runPlan: resolved.value,
    taskId: "legacy-smoke",
    conditionId: "default",
    requestedModel: "opus",
  });

  const record = await store.getRun(result.runs[0].id);
  assert.equal(result.runs[0].verdict, "pass", JSON.stringify(record));
  assert.equal(record.deterministic.evaluatorStatus, "not_configured");
  assert.deepEqual(record.checks, []);
  assert.equal(record.judgeStatus, "complete");
});

test("a judged v1 Suite rejects a missing capability before execution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-verdict-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTask(root);
  writeSuite(root, "judge");
  const resolved = await resolveV1Suite({
    suitePath: join(root, "judge.suite.mjs"),
  });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const store = await openLocalResultStore({ root: join(root, "results") });
  let executions = 0;
  const result = await createRunEngine({
    resultStore: store,
    agentAdapter: controlledAgent(writeFakeClaude(root)),
    executionEnvironment: {
      id: "controlled-local",
      capabilities: [],
      normalizeSettings(settings = {}) { return settings; },
      async execute() {
        executions += 1;
        throw new Error("not reached");
      },
    },
  }).run({
    runPlan: resolved.value,
    taskId: "legacy-smoke",
    conditionId: "default",
    requestedModel: "opus",
  });

  assert.equal(result.status, "rejected");
  assert.equal(executions, 0);
  assert.deepEqual(await store.listRuns(), []);
});

test("Judge provider failure leaves new hybrid incomplete and Judge-only unknown", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-verdict-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTask(root);
  const command = writeFakeClaude(root);

  for (const [verdict, expected] of [
    ["hybrid", "incomplete"],
    ["judge", "unknown"],
  ]) {
    writeSuite(root, verdict);
    const resolved = await resolveV1Suite({
      suitePath: join(root, `${verdict}.suite.mjs`),
    });
    t.after(() => resolved.dispose());
    assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
    const store = await openLocalResultStore({ root: join(root, `provider-${verdict}`) });
    const result = await createRunEngine({
      resultStore: store,
      agentAdapter: controlledAgent(command),
      executionEnvironment: createLocalExecutionEnvironment(),
      judge: controlledJudge("error"),
    }).run({
      runPlan: resolved.value,
      taskId: "legacy-smoke",
      conditionId: "default",
      requestedModel: "claude-opus-4-8",
    });

    assert.equal(result.status, "complete");
    assert.equal(result.runs[0].verdict, expected);
    const record = await store.getRun(result.runs[0].id);
    assert.equal(record.judgeStatus, "failed");
    assert.equal(record.judge.kind, "error");
    assert.equal(record.judge.code, "judge.provider-failed");
    assert.equal(record.deterministic.effective.verdict, verdict === "hybrid" ? "pass" : "unknown");
  }
});

test("the CLI rejects a judged Suite it cannot judge before creating its default Store", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-verdict-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTask(root);
  writeSuite(root, "judge");

  // The default Runtime judges with the Suite's Judge model, which needs a credential.
  const result = spawnSync(process.execPath, [cliPath, "run", "judge.suite.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[runtime\.secret-missing\] .*'ANTHROPIC_API_KEY'/);
  assert.equal(existsSync(join(root, ".hurdle", "results-v1")), false);
});

test("mandatory Run Trust remains outside a v1 judge verdict", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-verdict-trust-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTask(root);
  writeSuite(root, "judge");
  const failedAgent = join(root, "failed-agent.mjs");
  writeFileSync(failedAgent, "process.exit(2);\n");
  const resolved = await resolveV1Suite({
    suitePath: join(root, "judge.suite.mjs"),
  });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const store = await openLocalResultStore({ root: join(root, "results") });
  let judgeCalls = 0;
  const judge = controlledJudge("pass");
  const result = await createRunEngine({
    resultStore: store,
    agentAdapter: controlledAgent(failedAgent),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge: {
      ...judge,
      async judge(...args) {
        judgeCalls += 1;
        return judge.judge(...args);
      },
    },
  }).run({
    runPlan: resolved.value,
    taskId: "legacy-smoke",
    conditionId: "default",
    requestedModel: "opus",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.runs[0].verdict, "incomplete");
  assert.equal(judgeCalls, 1);
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.judgeStatus, "complete");
  assert.equal(record.headline.decidedBy, "mandatory-run-trust");
});

test("judged Suites fail closed on missing or contradictory authoring inputs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-verdict-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTask(root);
  writeSuite(root, "judge");
  writeFileSync(join(root, "tasks", "legacy-smoke", "checks.mjs"), [
    'import { defineChecks } from "tae";',
    'export default defineChecks((run) => { run.expect.replyIncludes("hello"); });',
    "",
  ].join("\n"));
  await assert.rejects(
    resolveV1Suite({
      suitePath: join(root, "judge.suite.mjs"),
    }),
    { code: "task.rubric-missing" },
  );

  writeTask(root);
  writeFileSync(
    join(root, "tasks", "legacy-smoke", "rubric.md"),
    "This removed file must not silently compete with run.judge().\n",
  );
  await assert.rejects(
    resolveV1Suite({
      suitePath: join(root, "judge.suite.mjs"),
    }),
    { code: "task.rubric-unsupported" },
  );
  rmSync(join(root, "tasks", "legacy-smoke", "rubric.md"));

  writeFileSync(join(root, "code.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "export default defineSuite({",
    '  tasks: ["./tasks/legacy-smoke"],',
    '  agents: [{ runner: "claude-code", model: "opus" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    '  judge: { model: "claude-opus-4-8" },',
    "});",
  ].join("\n"));
  await assert.rejects(
    resolveV1Suite({
      suitePath: join(root, "code.suite.mjs"),
    }),
    { code: "suite.judge-unexpected" },
  );
});

test("v1 judged records have equivalent Local and Postgres semantics", {
  skip: !adminConnectionString,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-verdict-postgres-"));
  const database = await createPostgresTestDatabase();
  let postgresStore;
  t.after(async () => {
    await closePostgresResultStore(postgresStore);
    await database.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  writeTask(root);
  writeSuite(root, "judge");
  const command = writeFakeClaude(root);
  const resolved = await resolveV1Suite({
    suitePath: join(root, "judge.suite.mjs"),
  });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  await applyPostgresResultStoreMigrations({ connectionString: database.connectionString });
  const stores = {
    local: await openLocalResultStore({ root: join(root, "local") }),
    postgres: await openPostgresResultStore({
      connectionString: database.connectionString,
      localArtifactRoot: join(root, "postgres-artifacts"),
    }),
  };
  postgresStore = stores.postgres;
  const observed = {};

  for (const [kind, resultStore] of Object.entries(stores)) {
    const result = await createRunEngine({
      resultStore,
      agentAdapter: controlledAgent(command),
      executionEnvironment: createLocalExecutionEnvironment(),
      judge: controlledJudge("pass"),
    }).run({
      runPlan: resolved.value,
      taskId: "legacy-smoke",
      conditionId: "default",
      requestedModel: "opus",
      experimentVersion: "v1-judge-store-parity",
    });
    const record = await resultStore.getRun(result.runs[0].id);
    observed[kind] = {
      snapshotFingerprint: record.snapshotFingerprint,
      snapshot: record.snapshot,
      state: record.state,
      verdict: record.verdict,
      headline: record.headline,
      runTrust: record.runTrust,
      deterministic: record.deterministic,
      checks: record.checks,
      judgeStatus: record.judgeStatus,
      judge: {
        kind: record.judge.kind,
        outcome: record.judge.outcome,
        summary: record.judge.summary,
        judgeId: record.judge.judgeId,
        model: record.judge.model,
      },
    };
  }

  assert.deepEqual(observed.postgres, observed.local);
});
