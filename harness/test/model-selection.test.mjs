import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectSuiteAgents } from '../lib/suite-agent-selection.mjs';
import { createFrameworkCli, main } from '../bin/hurdle.mjs';
import { initializeSuite } from '../lib/starter-suite.mjs';
import { resolveV1Suite } from '../lib/v1-authoring.mjs';
const agent = (runner, model, effort = 'medium') => ({ adapterId: runner, requestedModel: model, settings: { effort } });
function fixture(t) {
 const root = mkdtempSync(join(tmpdir(), 'hurdle-model-selection-'));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 let stdout = '', stderr = '';
 return { root, io: { cwd: root, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } }, output: () => stdout, error: () => stderr };
}
const forbidden = () => assert.fail('model selection/help must not contact providers or execute an Agent');
test('model overrides accept old, future and opaque IDs without mutating Suite defaults', () => {
 const agents = [agent('codex', 'suite-model')];
 const before = structuredClone(agents);
 for (const model of ['older-model', 'new-model-2099', 'provider/model:revision', 'opus']) {
  assert.deepEqual(selectSuiteAgents(agents, { model }), [agent('codex', model)]);
 }
 assert.deepEqual(agents, before);
 assert.deepEqual(selectSuiteAgents(agents), agents);
 for (const model of ['', ' ', null]) assert.throws(() => selectSuiteAgents(agents, { model }), /nonblank/);
});
test('mixed runners require an explicit Agent for model overrides', () => {
 const agents = [agent('claude-code', 'claude-old'), agent('codex', 'codex-old')];
 assert.throws(() => selectSuiteAgents(agents, { model: 'new' }), /Use --agent/);
 assert.deepEqual(selectSuiteAgents(agents, { agent: 'codex', model: 'new' }), [agent('codex', 'new')]);
 assert.throws(() => selectSuiteAgents([agents[0]], { agent: 'codex' }), /No Suite Agent/);
 assert.deepEqual(selectSuiteAgents(agents, { agent: 'codex' }), [agents[1]]);
});
test('overrides preserve effort variants and collapse only identical resulting cells', () => {
 const agents = [agent('codex', 'a'), agent('codex', 'b'), agent('codex', 'b', 'high')];
 assert.deepEqual(selectSuiteAgents(agents, { model: 'new' }), [agent('codex', 'new'), agent('codex', 'new', 'high')]);
 assert.equal(selectSuiteAgents(agents).length, 3);
});
test('ordinary run help is brief and uses the explicitly selected Suite without importing it', async t => {
 const f = fixture(t);
 for (const path of ['evals/example.suite.mjs', 'api-evals/example.suite.mjs']) {
  mkdirSync(join(f.root, path, '..'), { recursive: true });
  writeFileSync(join(f.root, path), 'throw new Error("general help must not import me")');
 }
 mkdirSync(join(f.root, '.env.local'));
 assert.equal(await main(['run', 'api-evals', '-h'], f.io), 0);
 assert.match(f.output(), /Run a Suite by name or path\. Omit it to use the project default\./);
 assert.doesNotMatch(f.output(), /With no selection, use evals\/example/);
 assert.match(f.output(), /Examples using api-evals:/);
 assert.match(f.output(), /run api-evals --view/);
 assert.equal(f.error(), '');
});
test('model help describes pass-through IDs, lists selected Suite defaults and cleans generated files', async t => {
 for (const command of ['run', 'validate']) {
  for (const help of ['-h', '--help']) {
   const f = fixture(t);
   assert.equal((await initializeSuite({ destination: join(f.root, 'evals'), agent: 'codex' })).ok, true);
   assert.equal((await initializeSuite({ destination: join(f.root, 'my api'), example: 'together-api' })).ok, true);
   mkdirSync(join(f.root, '.env.local'));
   let generated;
   const cli = createFrameworkCli({
    env: new Proxy({}, { get: forbidden }), checkAgentReadiness: forbidden, openLocalResultStore: forbidden,
    openPostgresResultStore: forbidden, loadTogetherSetupBackend: forbidden, loadSetupBackend: forbidden,
    async resolveV1Suite(options) { const resolved = await resolveV1Suite(options); generated = resolved.generatedRoot; return resolved; },
   });
   assert.equal(await cli.main([command, 'my api', '--model', help], f.io), 0, f.error());
   assert.match(f.output(), /Use any model ID or alias supported by the selected runner/);
   assert.match(f.output(), /Suite defaults \(my api\)/);
   assert.match(f.output(), /claude-opus-5-5/);
   assert.doesNotMatch(f.output(), /gpt-6\.1-sol/);
   assert.ok(f.output().includes(`${command} 'my api' --model claude-opus-5-5`));
   assert.equal(f.error(), '');
   assert.equal(existsSync(generated), false);
   assert.equal(existsSync(join(f.root, '.hurdle')), false);
  }
 }
});
test('offline validation applies unknown model overrides and preserves the original Suite', async t => {
 const f = fixture(t);
 assert.equal((await initializeSuite({ destination: join(f.root, 'evals'), agent: 'codex' })).ok, true);
 const suitePath = join(f.root, 'evals/example.suite.mjs');
 const before = readFileSync(suitePath, 'utf8');
 const cli = createFrameworkCli({ env: {}, checkAgentReadiness: forbidden, openLocalResultStore: forbidden });
 assert.equal(await cli.main(['validate', '--offline', '--model', 'future-codex-2099'], f.io), 0, f.error());
 assert.match(f.output(), /future-codex-2099 · medium effort/);
 assert.equal(readFileSync(suitePath, 'utf8'), before);
 assert.equal(existsSync(join(f.root, '.hurdle')), false);
});
test('ambiguous overrides fail before readiness and dispose the Suite', async t => {
 const f = fixture(t);
 assert.equal((await initializeSuite({ destination: join(f.root, 'evals') })).ok, true);
 const suitePath = join(f.root, 'evals/example.suite.mjs');
 const source = readFileSync(suitePath, 'utf8').replace(/agents: \[[^\n]+\],/, 'agents: [{ runner: "claude-code", model: "old" }, { runner: "codex", model: "old" }],');
 writeFileSync(suitePath, source);
 let generated;
 const cli = createFrameworkCli({ env: {}, checkAgentReadiness: forbidden, openLocalResultStore: forbidden,
  async resolveV1Suite(options) { const resolved = await resolveV1Suite(options); generated = resolved.generatedRoot; return resolved; },
 });
 assert.equal(await cli.main(['run', '--model', 'new'], f.io), 2);
 assert.match(f.error(), /Use --agent/);
 assert.equal(existsSync(generated), false);
});

test('model help works without a Suite and uses a runnable example for default mixed-runner Suites', async t => {
 for (const state of ['empty', 'codex', 'mixed']) {
  const f = fixture(t);
  if (state !== 'empty') {
   assert.equal((await initializeSuite({ destination: join(f.root, 'evals'), agent: 'codex' })).ok, true);
   if (state === 'mixed') {
    const path = join(f.root, 'evals/example.suite.mjs');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/agents: \[[^\n]+\],/, 'agents: [{ runner: "claude-code", model: "claude-old" }, { runner: "codex", model: "codex-old" }],'));
   }
  }
  mkdirSync(join(f.root, '.env.local'));
  const cli = createFrameworkCli({ env: new Proxy({}, { get: forbidden }), discoverModels: forbidden, checkAgentReadiness: forbidden });
  assert.equal(await cli.main(['run', '--model', '-h'], f.io), 0, f.error());
  assert.match(f.output(), /Use any model ID or alias/);
  if (state === 'empty') {
   assert.match(f.output(), /models --agent claude-code/); assert.match(f.output(), /models --agent codex/);
  } else if (state === 'mixed') {
   assert.match(f.output(), /run evals\/example\.suite\.mjs --agent claude-code --model claude-old/);
   assert.match(f.output(), /models --agent claude-code/); assert.match(f.output(), /models --agent codex/);
  } else assert.match(f.output(), /gpt-6\.1-sol/);
  assert.equal(existsSync(join(f.root, '.hurdle')), false);
 }
});
