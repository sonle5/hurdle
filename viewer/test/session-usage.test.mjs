import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { projectAgentUsage, readSessionTokenUsage, summarizeSessionTokens } from "../lib/session-usage.mjs";

const usageA = { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 15990, cache_creation_input_tokens: 2897 };
const usageB = { input_tokens: 2, output_tokens: 46, cache_read_input_tokens: 18887, cache_creation_input_tokens: 186 };
const reported = { input_tokens: 4, output_tokens: 202, cache_read_input_tokens: 34877, cache_creation_input_tokens: 3083 };
const messages = [
  { role: "assistant", uuid: "block-a", providerMessageId: "msg-a", usage: usageA },
  { role: "assistant", uuid: "block-b", providerMessageId: "msg-a", usage: usageA },
  { role: "assistant", uuid: "block-c", providerMessageId: "msg-b", usage: usageB },
];

test("Codex totals include output once and treat cached input as a subset of input", () => {
  const record = { state: "complete", snapshot: { agent: { adapterId: "codex" } }, metrics: {
    common: { inputTokens: 100, outputTokens: 20, toolCalls: 0 },
    adapters: { codex: { cachedInputTokens: 80, reasoningOutputTokens: 10 } },
  } };
  assert.deepEqual(projectAgentUsage(record), { totalTokens: 120, toolCalls: 0,
    tokenUsage: { input: 20, output: 20, cacheRead: 80, cacheCreate: 0, totalIn: 100 } });
  delete record.metrics.adapters.codex.cachedInputTokens;
  assert.deepEqual(projectAgentUsage(record), { totalTokens: 120, toolCalls: 0, tokenUsage: null });
  record.state = "running";
  assert.deepEqual(projectAgentUsage(record), { totalTokens: null, toolCalls: null, tokenUsage: null });
});

test("final Claude usage replaces partial block usage, including completed output counts", () => {
  assert.deepEqual(summarizeSessionTokens(messages, reported), {
    input: 4, output: 202, cacheRead: 34877, cacheCreate: 3083, totalIn: 37964,
  });
});

test("message fallback deduplicates content blocks and keeps the largest usage snapshot", () => {
  assert.deepEqual(summarizeSessionTokens(messages), {
    input: 4, output: 53, cacheRead: 34877, cacheCreate: 3083, totalIn: 37964,
  });
  const later = { ...messages[0], usage: { ...usageA, output_tokens: 42 } };
  assert.equal(summarizeSessionTokens([...messages, later]).output, 88);
});

test("fallback preserves independent messages without IDs and ignores user usage", () => {
  const values = [
    { role: "assistant", usage: { input_tokens: 3, output_tokens: 8 } },
    { role: "assistant", uuid: "", usage: { input_tokens: 5, output_tokens: 9 } },
    { role: "user", usage: reported },
  ];
  assert.deepEqual(summarizeSessionTokens(values), { input: 8, output: 17, cacheRead: 0, cacheCreate: 0, totalIn: 8 });
});

test("invalid final usage falls back and valid zero totals remain authoritative", () => {
  for (const value of [null, {}, { ...reported, output_tokens: -1 }, { ...reported, input_tokens: "4" }, { ...reported, cache_read_input_tokens: Infinity }]) {
    assert.equal(readSessionTokenUsage(value), null);
    assert.deepEqual(summarizeSessionTokens(messages, value), summarizeSessionTokens(messages));
  }
  assert.deepEqual(summarizeSessionTokens(messages, { input_tokens: 0, output_tokens: 0 }), {
    input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalIn: 0,
  });
});

test("the Viewer session parser consumes final result usage without hiding message blocks", () => {
  const source = new URL("../lib/sessions.ts", import.meta.url).href;
  const frames = messages.map(m => ({
    type: "assistant", uuid: m.uuid,
    message: { role: m.role, id: m.providerMessageId, usage: m.usage, content: [{ type: "text", text: "block" }] },
  }));
  frames.push({ type: "result", usage: reported, total_cost_usd: 0.0264464 });
  const script = `import {parseSessionFromJsonl} from ${JSON.stringify(source)};
    import {readFileSync} from 'node:fs';
    const frames=JSON.parse(readFileSync(0,'utf8'));
    const meta={id:'run-test',version:'test',run:'run1',task:'copy-message',agent:'CC',configId:'baseline',configLabel:'Baseline',configFull:'Baseline',configDir:'baseline',result:'pass',note:null,skills:null};
    const parse=value=>parseSessionFromJsonl(value.map(f=>JSON.stringify(f)).join('\\n'),meta);
    const s=parse(frames);
    const zero=parse([...frames,{type:'result',usage:{input_tokens:0,output_tokens:0},total_cost_usd:0}]);
    const pi=parse([{type:'session',cwd:'/workspace'},{type:'message',id:'pi-one',message:{role:'assistant',content:'ok',usage:{input:9,output:12,cacheRead:15,cacheWrite:3}}}]);
    console.log(JSON.stringify({tokens:s.stats.tokens,cost:s.stats.costUsd,messages:s.messages.length,zero:{tokens:zero.stats.tokens,cost:zero.stats.costUsd},pi:pi.stats.tokens}));`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { input: JSON.stringify(frames), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.tokens, summarizeSessionTokens(messages, reported));
  assert.equal(parsed.cost, 0.0264464);
  assert.equal(parsed.messages, 3);
  assert.equal(parsed.zero.cost, 0);
  assert.equal(parsed.zero.tokens.totalIn, 0);
  assert.deepEqual(parsed.pi, { input: 9, output: 12, cacheRead: 15, cacheCreate: 3, totalIn: 27 });
});
