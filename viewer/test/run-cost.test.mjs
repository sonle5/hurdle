import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRunCost, formatRunCost } from '../lib/run-cost.mjs';
import { createCanonicalDashboardProjection } from '../lib/canonical-dashboard-projection.mjs';
import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(new URL('../../harness/test/fixtures/canonical-run-record-v2.json', import.meta.url), 'utf8'));
function record() {
  const r = structuredClone(fixture.history.at(-1));
  r.snapshot.agent = { adapterId: 'codex', requestedModel: 'gpt-6.1-sol', settings: { effort: 'medium' } };
  r.execution.adapterId = 'codex';
  r.execution.observedModel = null;
  r.metrics = { common: { inputTokens: 55773, outputTokens: 209, reportedCostUsd: null }, adapters: { codex: { cachedInputTokens: 41643, reasoningOutputTokens: 11 } } };
  r.evidence.transcript = null;
  r.evidence.egress = [];
  return r;
}
test('GPT-6.1 Sol estimate subtracts cached input and counts reasoning only once', () => {
  const r = record();
  const before = structuredClone(r);
  const cost = projectRunCost(r);
  assert.ok(Math.abs(cost.costUsd - 0.0345143) < 1e-12);
  assert.equal(cost.costSource, 'estimated');
  r.metrics.adapters.codex.reasoningOutputTokens = 209;
  assert.deepEqual(projectRunCost(r), cost, 'reasoning is already part of total output');
  r.metrics.adapters.codex.reasoningOutputTokens = 11;
  assert.deepEqual(r, before, 'projection must not alter immutable evidence');
  assert.equal(formatRunCost(cost.costUsd, cost.costSource), '≈$0.03');
});
test('reported costs including zero take precedence over token estimates', () => {
  for (const value of [0, 0.42]) {
    const r = record();
    r.metrics.common.reportedCostUsd = value;
    r.metrics.common.costUsd = 10;
    assert.deepEqual(projectRunCost(r), { costUsd: value, costSource: 'reported' });
  }
  const r = record();
  r.metrics.common.costUsd = 0;
  assert.deepEqual(projectRunCost(r), { costUsd: 0, costSource: 'reported' });
});
test('unknown models, context tiers, incomplete runs and invalid counts stay unavailable', () => {
  const cases = [
    r => { r.snapshot.agent.requestedModel = 'unknown'; },
    r => { r.execution.observedModel = 'different-model'; },
    r => { r.snapshot.agent.adapterId = 'claude-code'; },
    r => { r.state = 'running'; },
    r => { r.metrics.adapters.codex.cachedInputTokens = null; },
    r => { r.metrics.adapters.codex.cachedInputTokens = 60000; },
    r => { r.metrics.common.inputTokens = 272001; },
    r => { r.metrics.common.outputTokens = -1; },
    r => { r.metrics.common.inputTokens = '55773'; },
  ];
  for (const mutate of cases) {
    const r = record(); mutate(r);
    assert.deepEqual(projectRunCost(r), { costUsd: null, costSource: 'unavailable' });
  }
  assert.equal(formatRunCost(null), '—');
  assert.equal(formatRunCost(0, 'reported'), '$0.00');
  assert.equal(formatRunCost(0.001, 'estimated'), '≈<$0.01');
});
test('summary and detail project the same estimate without a transcript', async () => {
  const r = record();
  const projection = createCanonicalDashboardProjection({ listRuns: async () => [r], getRun: async () => r, readEvidence: async () => assert.fail('cost must not need transcript evidence') });
  const [summary] = await projection.listSessions(r.experimentVersion);
  const detail = await projection.findSession(summary.id);
  assert.ok(Math.abs(summary.costUsd - 0.0345143) < 1e-12);
  assert.equal(detail.costUsd, summary.costUsd);
  assert.equal(detail.costSource, 'estimated');
});
