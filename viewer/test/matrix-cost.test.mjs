import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../components/leaderboard/MatrixTable.tsx', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function aggregateRow('), source.indexOf('function fmtTime('));
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const aggregate = runInNewContext(`${compiled}\n({aggregateRow,aggregateCol,aggregateAll})`);
test('matrix cost averages exclude unknown runs and include a reported zero', () => {
  const data = {
    configs: [{ id: 'a' }, { id: 'b' }], tasks: [{ slug: 'task' }],
    grid: new Map([
      ['task|a', { pass: 3, total: 3, avgDurationSec: 1, avgCostUsd: 0.08, costCount: 1 }],
      ['task|b', { pass: 1, total: 1, avgDurationSec: 1, avgCostUsd: 0, costCount: 1 }],
    ]),
  };
  for (const value of [aggregate.aggregateRow(data, 'task'), aggregate.aggregateAll(data)]) {
    assert.equal(value.avgCostUsd, 0.04);
    assert.equal(value.costCount, 2);
    assert.equal(value.total, 4, 'cost availability must not change scoring');
  }
  assert.equal(aggregate.aggregateCol(data, 'a').avgCostUsd, 0.08);
});
