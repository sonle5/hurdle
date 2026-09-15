import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { createCanonicalDashboardProjection } from "../../viewer/lib/canonical-dashboard-projection.mjs";

const cliPath = fileURLToPath(new URL("../bin/tae.mjs", import.meta.url));
const testAgentCredential = "TEST-PLACEHOLDER-CLAUDE-CREDENTIAL";

function runCli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("a code-authored Suite runs two independent Local repeats through the canonical store", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-suite-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "copy-message");
  mkdirSync(join(taskRoot, "fixtures"), { recursive: true });
  writeFileSync(
    join(taskRoot, "prompt.md"),
    "Read `fixtures/message.txt` and reply with its exact contents.\n",
  );
  writeFileSync(join(taskRoot, "fixtures", "message.txt"), "Hello from v1.\n");
  writeFileSync(
    join(taskRoot, "checks.mjs"),
    [
      'import { defineChecks } from "tae";',
      "",
      "export default defineChecks((run) => {",
      "  run.check({",
      '    id: "exact-reply",',
      '    passed: run.agentReply === "Hello from v1.",',
      '    summary: "The Agent replied with the exact fixture contents.",',
      "    evidence: [run.evidence.transcript],",
      "  });",
      '  run.expect.replyIncludes("Hello from v1.");',
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "general.suite.mjs"),
    [
      'import { defineSuite } from "tae";',
      "",
      "export default defineSuite({",
      '  tasks: ["./tasks/copy-message"],',
      "  agents: [{",
      '    runner: "claude-code",',
      '    model: "test-model",',
      "  }],",
      "  conditions: {",
      "    default: { skills: [], mcpServers: [] },",
      "  },",
      "  repeats: 2,",
      '  verdict: "code",',
      "});",
      "",
    ].join("\n"),
  );

  const binRoot = join(root, "bin");
  mkdirSync(binRoot);
  const fakeClaude = join(binRoot, "claude");
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      'const { readFileSync } = require("node:fs");',
      'const reply = readFileSync("fixtures/message.txt", "utf8").trimEnd();',
      'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: `session-${process.pid}` })}\\n`);',
      'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: `session-${process.pid}`, model: "test-model", result: reply })}\\n`);',
      "",
    ].join("\n"),
  );
  chmodSync(fakeClaude, 0o755);

  const validation = runCli(root, ["validate", "general.suite.mjs"]);
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stdout, /^Valid Suite: general\.suite\.mjs$/m);
  assert.match(validation.stdout, /^Tasks: 1  Conditions: 1$/m);

  const storeRoot = join(root, ".tae", "results-v1");
  const result = runCli(
    root,
    ["run", "general.suite.mjs"],
    {
      PATH: `${binRoot}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: testAgentCredential,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^  Plan\s+2 runs · 1 task · 1 condition$/m);
  assert.match(result.stdout, /^  Runs\s+2 passed$/m);

  const store = await openLocalResultStore({ root: storeRoot });
  const records = await store.listRuns();
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map(({ invocation }) => invocation.repeatOrdinal).sort(),
    [1, 2],
  );
  assert.ok(records.every(({ verdict }) => verdict === "pass"));
  assert.ok(records.every(({ snapshot }) => snapshot.task.id === "copy-message"));
  assert.ok(records.every(({ snapshot }) => (
    snapshot.task.prompt === "Read `fixtures/message.txt` and reply with its exact contents.\n"
    && Object.hasOwn(
      snapshot.behavior.deterministicEvaluator.modules,
      "evaluators/copy-message-checks.mjs",
    )
  )));
  assert.equal(new Set(records.map(({ snapshotFingerprint }) => snapshotFingerprint)).size, 1);
  assert.ok(records.every(({ checks }) => (
    checks.length === 2
    && checks[0].id === "exact-reply"
    && checks[0].outcome === "pass"
    && checks[0].evidenceRefs.length === 1
    && checks[1].id === "reply-includes"
    && checks[1].outcome === "pass"
  )));

  const projection = createCanonicalDashboardProjection(store);
  const versions = await projection.listVersions();
  const sessions = await projection.listSessions(versions[0].id);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every(({ passed, result }) => passed === true && result === "pass"));
});

test("a Task workspace preserves legacy fixture paths at the Agent workspace root", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "legacy-message");
  mkdirSync(join(taskRoot, "workspace", "harness", "fixtures"), { recursive: true });
  writeFileSync(
    join(taskRoot, "prompt.md"),
    "Read `harness/fixtures/message.txt` and reply with its exact contents.\n",
  );
  writeFileSync(
    join(taskRoot, "workspace", "harness", "fixtures", "message.txt"),
    "Hello from the legacy path.\n",
  );
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "",
    "export default defineChecks((run) => {",
    '  run.expect.replyIncludes("Hello from the legacy path.");',
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "legacy.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "",
    "export default defineSuite({",
    '  tasks: ["./tasks/legacy-message"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const binRoot = join(root, "bin");
  mkdirSync(binRoot);
  const fakeClaude = join(binRoot, "claude");
  writeFileSync(fakeClaude, [
    "#!/usr/bin/env node",
    'const { readFileSync } = require("node:fs");',
    'const reply = readFileSync("harness/fixtures/message.txt", "utf8").trimEnd();',
    'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: `session-${process.pid}` })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: `session-${process.pid}`, model: "test-model", result: reply })}\\n`);',
    "",
  ].join("\n"));
  chmodSync(fakeClaude, 0o755);

  const result = runCli(root, ["run", "legacy.suite.mjs"], {
    PATH: `${binRoot}:${process.env.PATH}`,
    ANTHROPIC_API_KEY: testAgentCredential,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^  Runs\s+1 passed$/m);
});

test("a Local API Task can require completion while observing unavailable HTTP evidence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-local-api-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "local-api");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Use the configured API, then report completion.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "",
    "export default defineChecks((run) => {",
    "  run.expect.completed();",
    "  run.observe.request({",
    '    id: "chat-completion",',
    '    method: "POST",',
    '    path: "/v1/chat/completions",',
    "    status: 200,",
    "  });",
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "local.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "",
    "export default defineSuite({",
    "  api: {",
    '    authorizationCredential: "TOGETHER_API_KEY",',
    '    hosts: ["api.together.xyz"],',
    "  },",
    '  tasks: ["./tasks/local-api"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const binRoot = join(root, "bin");
  mkdirSync(binRoot);
  const fakeClaude = join(binRoot, "claude");
  writeFileSync(fakeClaude, [
    "#!/usr/bin/env node",
    'const present = process.env.TOGETHER_API_KEY === "TEST-LOCAL-TARGET-CREDENTIAL";',
    'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: `session-${process.pid}` })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: `session-${process.pid}`, model: "test-model", result: present ? "credential-present" : "credential-missing" })}\\n`);',
    "",
  ].join("\n"));
  chmodSync(fakeClaude, 0o755);

  const storeRoot = join(root, "results");
  const result = runCli(
    root,
    ["run", "local.suite.mjs", "--store", storeRoot],
    {
      PATH: `${binRoot}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: testAgentCredential,
      TOGETHER_API_KEY: "TEST-LOCAL-TARGET-CREDENTIAL",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^  Runs\s+1 passed$/m);

  const store = await openLocalResultStore({ root: storeRoot });
  const [record] = await store.listRuns();
  assert.equal(record.verdict, "pass");
  assert.equal(record.snapshot.task.credentialDefinitions[0].delivery.kind, "environment");
  assert.deepEqual(record.snapshot.task.executionRequirements, ["environment.isolated-workspace"]);
  assert.equal(record.snapshot.target.egress.captureMode, "optional");
  assert.deepEqual(
    record.checks.map(({ id, outcome, authoredAuthority }) => ({ id, outcome, authoredAuthority })),
    [
      { id: "completed", outcome: "pass", authoredAuthority: "required" },
      { id: "chat-completion", outcome: "skip", authoredAuthority: "advisory" },
    ],
  );
  const transcript = String(await store.readEvidence(
    record.evidence.transcript,
    { maxBytes: 64 * 1024 },
  ));
  assert.match(transcript, /credential-present/);
  assert.doesNotMatch(transcript, /TEST-LOCAL-TARGET-CREDENTIAL/);
});

test("failed and unavailable checks remain distinct and do not stop later repeats", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-outcomes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [taskId, passed, summary] of [
    ["failing-task", "false", "The deliberate code check failed."],
    ["unavailable-task", "null", "The required evidence was unavailable."],
  ]) {
    const taskRoot = join(root, "tasks", taskId);
    mkdirSync(join(taskRoot, "fixtures"), { recursive: true });
    writeFileSync(join(taskRoot, "prompt.md"), "Reply with `done`.\n");
    writeFileSync(join(taskRoot, "fixtures", "message.txt"), "done\n");
    writeFileSync(join(taskRoot, "checks.mjs"), [
      'import { defineChecks } from "tae";',
      "",
      "export default defineChecks((run) => {",
      "  run.check({",
      `    id: ${JSON.stringify(taskId)},`,
      `    passed: ${passed},`,
      `    summary: ${JSON.stringify(summary)},`,
      "  });",
      "});",
      "",
    ].join("\n"));
  }
  writeFileSync(join(root, "general.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "",
    "export default defineSuite({",
    '  tasks: ["./tasks/failing-task", "./tasks/unavailable-task"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 2,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const binRoot = join(root, "bin");
  mkdirSync(binRoot);
  const fakeClaude = join(binRoot, "claude");
  writeFileSync(fakeClaude, [
    "#!/usr/bin/env node",
    'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: `session-${process.pid}` })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: `session-${process.pid}`, model: "test-model", result: "done" })}\\n`);',
    "",
  ].join("\n"));
  chmodSync(fakeClaude, 0o755);

  const storeRoot = join(root, "results");
  const result = runCli(
    root,
    ["run", "general.suite.mjs", "--store", storeRoot],
    {
      PATH: `${binRoot}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: testAgentCredential,
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^  Plan\s+4 runs · 2 tasks · 1 condition$/m);
  assert.match(result.stdout, /^  Runs\s+2 failed · 2 incomplete$/m);

  const store = await openLocalResultStore({ root: storeRoot });
  const records = await store.listRuns();
  assert.equal(records.length, 4);
  assert.deepEqual(
    records.filter(({ snapshot }) => snapshot.task.id === "failing-task")
      .map(({ invocation }) => invocation.repeatOrdinal).sort(),
    [1, 2],
  );
  assert.deepEqual(
    records.filter(({ snapshot }) => snapshot.task.id === "unavailable-task")
      .map(({ invocation }) => invocation.repeatOrdinal).sort(),
    [1, 2],
  );
  assert.ok(records
    .filter(({ snapshot }) => snapshot.task.id === "failing-task")
    .every(({ verdict, checks }) => verdict === "fail" && checks[0].outcome === "fail"));
  assert.ok(records
    .filter(({ snapshot }) => snapshot.task.id === "unavailable-task")
    .every(({ state, verdict, checks }) => (
      state === "complete" && verdict === "incomplete" && checks[0].outcome === "skip"
    )));

  const projection = createCanonicalDashboardProjection(store);
  const versions = await projection.listVersions();
  const sessions = await projection.listSessions(versions[0].id);
  assert.equal(sessions.filter(({ result }) => result === "fail").length, 2);
  assert.equal(sessions.filter(({ result }) => result === "incomplete").length, 2);
});

test("v1 rejects the removed task.json configuration surface", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-task-json-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "copy-message");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Reply with `done`.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "export default defineChecks((run) => {",
    '  run.check({ id: "done", passed: true, summary: "Done." });',
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(taskRoot, "task.json"), "{}\n");
  writeFileSync(join(root, "general.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "export default defineSuite({",
    '  tasks: ["./tasks/copy-message"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const result = runCli(root, ["validate", "general.suite.mjs"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /task\.json is not supported by the v1 facade/);
});

test("v1 rejects duplicate completion checks during validation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-completed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "duplicate-completion");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Reply with `done`.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "export default defineChecks((run) => {",
    "  run.expect.completed();",
    "  run.expect.completed();",
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "general.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "export default defineSuite({",
    '  tasks: ["./tasks/duplicate-completion"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const result = runCli(root, ["validate", "general.suite.mjs"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[task\.checks-invalid\]/);
});

test("v1 rejects fixture and workspace paths that target the same Agent file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-fixture-collision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "duplicate-input");
  mkdirSync(join(taskRoot, "fixtures"), { recursive: true });
  mkdirSync(join(taskRoot, "workspace", "fixtures"), { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Read `fixtures/message.txt`.\n");
  writeFileSync(join(taskRoot, "fixtures", "message.txt"), "first\n");
  writeFileSync(join(taskRoot, "workspace", "fixtures", "message.txt"), "second\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "export default defineChecks((run) => {",
    '  run.expect.replyIncludes("first");',
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "general.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "export default defineSuite({",
    '  tasks: ["./tasks/duplicate-input"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const result = runCli(root, ["validate", "general.suite.mjs"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[task\.fixture-collision\]/);
});
