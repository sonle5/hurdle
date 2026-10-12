import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalExecutionEnvironment } from "../lib/execution-environments/local.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";
import { initializeStarterRunPlan, resolveStarterRunPlan } from "./helpers/run-plan-starter.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for evaluation progress");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, { judge = false, example } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hurdle-concurrency-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "plan");
  let runPlan;
  if (example) {
    const initialized = await initializeSuite({ destination: sourceRoot, example });
    assert.equal(initialized.ok, true, JSON.stringify(initialized.diagnostics));
    const resolved = await resolveV1Suite({ suitePath: initialized.value.suitePath });
    t.after(() => resolved.dispose());
    assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
    assert.equal(resolved.defaults.concurrency, 3);
    runPlan = resolved.value;
  } else {
    const initialized = await initializeStarterRunPlan({ destination: sourceRoot });
    const definition = structuredClone(initialized.value.definition);
    if (judge) {
      definition.tasks["copy-message"].evaluation.judge = { rubric: "Check the copy." };
      writeFileSync(join(sourceRoot, "run-plan.json"), JSON.stringify(definition));
    }
    runPlan = await resolveStarterRunPlan({ sourceRoot });
  }
  const script = join(root, "agent.mjs");
  const completion = example ? 'console.log(JSON.stringify({type:"result", subtype:"success", result:"copied"}));' : 'console.log("copied");';
  writeFileSync(script, 'import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync("answer.txt", readFileSync("fixtures/message.txt"));\n' + completion + "\n");
  const adapter = {
    id: "controlled-agent", capabilities: [],
    normalizeSettings({ requestedModel, settings }) { return { requestedModel: requestedModel ?? null, settings: settings ?? {} }; },
    createLaunchPlan() { return { command: process.execPath, args: [script], env: {}, timeoutMs: 5_000 }; },
    decodeControllerEvidence({ stdout }) {
      return { transcript: stdout, observedModel: null, sessionId: null, metrics: { common: {}, adapter: {} } };
    },
  };
  const store = await openLocalResultStore({ root: join(root, "results") });
  return { root, runPlan, adapter, store, local: createLocalExecutionEnvironment() };
}

for (const concurrency of [undefined, 2, 1]) {
  test(`Run Engine limits whole cells to ${concurrency ?? "the default three"} and preserves matrix order`, async t => {
    const { runPlan, adapter, store, local } = await fixture(t);
    const limit = concurrency ?? 3;
    const gates = new Map();
    const started = [];
    const completed = [];
    const attempts = new Map();
    let active = 0;
    let peak = 0;
    t.after(() => { for (const gate of gates.values()) gate.resolve(); });
    const engine = createRunEngine({
      resultStore: store, agentAdapter: adapter,
      progressObserver: { observe(event) {
        if (event.kind === "cell-started") {
          started.push(event.cell.ordinal);
          active += 1;
          peak = Math.max(peak, active);
        }
        if (event.kind === "cell-attempt-started") attempts.set(event.executionId, event.cell.ordinal);
        if (event.kind === "cell-completed") { completed.push(event.cell.ordinal); active -= 1; }
      } },
      executionEnvironment: { ...local, async execute(envelope) {
        const ordinal = attempts.get(envelope.executionId);
        const gate = deferred();
        gates.set(ordinal, gate);
        await gate.promise;
        return local.execute(envelope);
      } },
    });
    const pending = engine.run({ runPlan, repeat: 7, ...(concurrency === undefined ? {} : { concurrency }) });
    await waitFor(() => gates.size === limit);
    assert.equal(started.length, limit);
    // Finish the last admitted cell first. Its sealed/disposed result must free
    // exactly one slot, while returned and persisted identities retain order.
    gates.get(limit).resolve();
    await waitFor(() => completed.length === 1 && gates.size === limit + 1);
    assert.equal(completed[0], limit);
    assert.equal(started.length, limit + 1);
    for (let next = 1; next <= 7; next += 1) {
      await waitFor(() => gates.has(next));
      gates.get(next).resolve();
    }
    const result = await pending;
    assert.equal(result.status, "complete");
    assert.equal(peak, limit);
    assert.equal(active, 0);
    assert.deepEqual(result.runs.map(run => run.invocation.ordinal), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(result.runs.map(run => run.invocation.repeatOrdinal), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(result.summary.terminalVerdicts.pass, 7);
    assert.equal(new Set(result.runs.map(run => run.id)).size, 7);
    for (const reference of result.runs) {
      const history = await store.getRunHistory(reference.id);
      assert.deepEqual(history.map(record => record.state), ["queued", "running", "complete"]);
      assert.equal(history.at(-1).evidence.artifacts.length, 1);
      assert.equal(history.at(-1).invocation.rootRunId, reference.id);
      assert.equal(history.at(-1).invocation.groupId, result.groupId);
    }
  });
}

for (const wrongOutput of [false, true]) {
  test(`three-task smoke starts three independent cells and ${wrongOutput ? "rejects another Task’s output" : "passes exact copies"}`, async t => {
    const { root, runPlan, adapter, store, local } = await fixture(t, { example: "concurrency-smoke" });
    assert.deepEqual(Object.keys(runPlan.definition.tasks), ["copy-alpha", "copy-beta", "copy-gamma"]);
    if (wrongOutput) writeFileSync(join(root, "agent.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("answer.txt", "Alpha task.\\n"); console.log(JSON.stringify({type:"result", subtype:"success", result:"copied"}));');
    const gates = [];
    let active = 0, peak = 0;
    t.after(() => { for (const gate of gates) gate.resolve(); });
    const engine = createRunEngine({
      resultStore: store, agentAdapter: adapter,
      progressObserver: { observe(event) {
        if (event.kind === "cell-started") { active += 1; peak = Math.max(peak, active); }
        if (event.kind === "cell-completed") active -= 1;
      } },
      executionEnvironment: { ...local, async execute(envelope) {
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        return local.execute(envelope);
      } },
    });
    const pending = engine.run({ runPlan });
    await waitFor(() => gates.length === 3);
    assert.equal(peak, 3);
    for (const gate of gates) gate.resolve();
    const result = await pending;
    assert.equal(result.status, "complete");
    assert.equal(result.runs.length, 3);
    assert.equal(active, 0);
    assert.equal(result.summary.terminalVerdicts.pass, wrongOutput ? 1 : 3, JSON.stringify(result.summary));
    assert.equal(result.summary.terminalVerdicts.fail, wrongOutput ? 2 : 0);
  });
}

test("parallel retries retain their cell links and occupy slots through Judge settlement", async t => {
  const { runPlan, adapter, store, local } = await fixture(t, { judge: true });
  const attempts = new Map();
  const counts = new Map();
  const started = [];
  const judgeGates = [];
  let executions = 0;
  t.after(() => { for (const gate of judgeGates) gate.resolve(); });
  const engine = createRunEngine({
    resultStore: store, agentAdapter: adapter,
    progressObserver: { observe(event) {
      if (event.kind === "cell-started") started.push(event.cell.ordinal);
      if (event.kind === "cell-attempt-started") {
        const count = (counts.get(event.cell.ordinal) ?? 0) + 1;
        counts.set(event.cell.ordinal, count);
        attempts.set(event.executionId, count);
      }
    } },
    executionEnvironment: { ...local, async execute(envelope) {
      executions += 1;
      const observed = await local.execute(envelope);
      if (attempts.get(envelope.executionId) === 1) return {
        ...observed, process: { ...observed.process, exitCode: 7 },
        integrityIssues: [...observed.integrityIssues, { code: "environment.nonzero-exit", phase: "execution", effect: "incomplete", message: "Controlled first-attempt failure." }],
      };
      return observed;
    } },
    judge: { id: "controlled-judge", model: null, timeoutMs: 15_000, async judge() {
      const gate = deferred();
      judgeGates.push(gate);
      await gate.promise;
      return { outcome: "pass", summary: "The copy satisfies the rubric." };
    } },
  });
  const pending = engine.run({ runPlan, repeat: 3, retries: 1, concurrency: 2 });
  await waitFor(() => judgeGates.length === 2);
  assert.deepEqual(started, [1, 2]);
  assert.equal(executions, 4);
  judgeGates[1].resolve();
  await waitFor(() => judgeGates.length === 3);
  assert.deepEqual(started, [1, 2, 3]);
  for (const gate of judgeGates) gate.resolve();
  const result = await pending;
  assert.equal(result.summary.retriesPerformed, 3);
  assert.equal(result.summary.terminalVerdicts.pass, 3);
  assert.deepEqual(result.runs.map(run => run.invocation.ordinal), [1, 1, 2, 2, 3, 3]);
  for (let index = 0; index < result.runs.length; index += 2) {
    const [first, second] = result.runs.slice(index, index + 2);
    assert.equal(first.invocation.rootRunId, first.id);
    assert.equal(second.invocation.rootRunId, first.id);
    assert.equal(second.invocation.retryOf, first.id);
    assert.equal(second.invocation.attemptOrdinal, 2);
    assert.equal(second.judgeStatus, "complete");
    assert.equal(first.judgeStatus, "not_requested");
  }
});

test("cancellation drains active executions, records queued cells, and starts no further Agents or retries", async t => {
  const { runPlan, adapter, store, local } = await fixture(t);
  const controller = new AbortController();
  const cleanup = deferred();
  let launched = 0;
  let executing = 0;
  let aborted = 0;
  t.after(() => cleanup.resolve());
  const engine = createRunEngine({
    resultStore: store, agentAdapter: { ...adapter, createLaunchPlan(input) { launched += 1; return adapter.createLaunchPlan(input); } },
    executionEnvironment: { ...local, async execute({ signal }) {
      executing += 1;
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      aborted += 1;
      await cleanup.promise;
      throw new Error("Controlled cancelled execution after cleanup");
    } },
  });
  let settled = false;
  const pending = engine.run({ runPlan, repeat: 7, retries: 2, concurrency: 2, signal: controller.signal });
  pending.finally(() => { settled = true; });
  await waitFor(() => executing === 2);
  controller.abort();
  await waitFor(() => aborted === 2);
  assert.equal(settled, false);
  cleanup.resolve();
  const result = await pending;
  assert.equal(launched, 2);
  assert.equal(executing, 2);
  assert.equal(result.runs.length, 7);
  assert.equal(result.summary.retriesPerformed, 0);
  assert.equal(result.summary.terminalVerdicts.incomplete, 7);
  for (const run of result.runs) assert.equal((await store.getRun(run.id)).state, "complete");

  const preAborted = await engine.run({ runPlan, repeat: 2, signal: controller.signal });
  assert.equal(preAborted.summary.terminalVerdicts.incomplete, 2);
  assert.equal(launched, 2);
  assert.equal(executing, 2);
});

test("an unexpected cell failure aborts peers and drains their cleanup before releasing pinned files", async t => {
  const { runPlan, adapter, store, local } = await fixture(t);
  const fail = deferred();
  const cleanup = deferred();
  let executions = 0;
  let peerAborted = false;
  let settled = false;
  let pinnedPath;
  t.after(() => { fail.resolve(); cleanup.resolve(); });
  const engine = createRunEngine({
    resultStore: store, agentAdapter: adapter,
    executionEnvironment: { ...local, async execute(envelope) {
      executions += 1;
      if (executions === 1) { await fail.promise; return {}; }
      pinnedPath = envelope.fixtures[0].pinnedPath;
      await new Promise(resolve => envelope.signal.addEventListener("abort", resolve, { once: true }));
      peerAborted = true;
      await cleanup.promise;
      assert.equal(existsSync(pinnedPath), true);
      throw new Error("Cancelled peer cleaned up");
    } },
  });
  const pending = engine.run({ runPlan, repeat: 7, concurrency: 2 });
  const rejected = assert.rejects(pending, /no process observation/);
  pending.then(() => { settled = true; }, () => { settled = true; });
  await waitFor(() => executions === 2);
  fail.resolve();
  await waitFor(() => peerAborted);
  assert.equal(settled, false);
  assert.equal(existsSync(pinnedPath), true);
  assert.equal(executions, 2);
  cleanup.resolve();
  await rejected;
  assert.equal(existsSync(pinnedPath), false);
});

test("invalid concurrency rejects before plan preparation, Agent launch, or environment allocation", async t => {
  const { adapter, store, local } = await fixture(t);
  const engine = createRunEngine({ resultStore: store, agentAdapter: adapter, executionEnvironment: local });
  for (const concurrency of [0, -1, 101, 1.5, "5", null, NaN, Infinity]) {
    const result = await engine.run({ runPlan: null, concurrency });
    assert.equal(result.status, "rejected");
    assert.match(result.diagnostics[0].message, /concurrency must be an integer between 1 and 100/);
  }
  assert.deepEqual(await store.listRuns(), []);
});
