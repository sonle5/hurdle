import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createDshAdapter, readDshProviders, resolveDshModel } from "../lib/agent-adapters/dsh.mjs";

const line = (frame) => JSON.stringify(frame);
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("dsh redacts its DeepSeek key in controller output and artifacts", () => {
  const fakeValue = ["fake", "deepseek", "redaction-check"].join("-");
  const adapter = createDshAdapter({ runtimeEnv: { DEEPSEEK_API_KEY: fakeValue } });
  const frame = line({ type: "tool_result", callId: "c1", status: "ok", result: `key=${fakeValue}` });
  assert.doesNotMatch(adapter.redactControllerText(frame), /redaction-check/);
  assert.doesNotMatch(adapter.redactEvidenceBytes(Buffer.from(fakeValue)).toString(), /redaction-check/);
});

test("dsh Adapter creates a bounded launch plan with a generated model patch", () => {
  const adapter = createDshAdapter({
    runtimeEnv: {
      PATH: "/test/bin",
      HOME: "/test/home",
      DSH_HOME: "/test/dsh-home",
      DEEPSEEK_API_KEY: "selected-deepseek-key",
      OPENAI_API_KEY: "must-not-reach-dsh",
    },
    command: "/test/bin/dsh",
    timeoutMs: 5_000,
  });

  assert.equal(adapter.id, "dsh");
  assert.deepEqual(
    adapter.normalizeSettings({ requestedModel: "  deepseek-flash  ", settings: {} }),
    { requestedModel: "deepseek-flash", settings: {} },
  );
  assert.throws(
    () => adapter.normalizeSettings({ requestedModel: null, settings: { provider: "other" } }),
    /does not support Agent Adapter settings/,
  );
  assert.throws(
    () => adapter.normalizeSettings({ requestedModel: null, settings: { effort: "extreme" } }),
    /effort must be/,
  );

  const plan = adapter.createLaunchPlan({
    prompt: "Copy the fixture.",
    requestedModel: "deepseek-v4-pro",
    settings: { effort: "xhigh" },
    resources: {
      skills: [{ name: "copy", files: [{ relativePath: "SKILL.md", handle: "h1", sha256: "a".repeat(64) }] }],
      mcpServers: [],
    },
  });
  const patch = Buffer.from(`${JSON.stringify([{
    id: "agent-default-model",
    config: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" },
  }], null, 2)}\n`);

  assert.deepEqual(plan, {
    command: "/test/bin/dsh",
    versionProbe: true,
    args: [
      "--profile",
      "headless",
      "--patch",
      ".hurdle/dsh-patch.json",
      "--json",
      "--permission-mode",
      "workspace-write",
      "--approval-policy",
      "never",
      "-",
    ],
    env: {
      PATH: "/test/bin",
      HOME: "/test/home",
      DEEPSEEK_API_KEY: "selected-deepseek-key",
      DSH_TELEMETRY_DISABLED: "1",
    },
    credentialRoutes: [{
      environmentName: "DEEPSEEK_API_KEY",
      hosts: ["api.deepseek.com"],
      headerNames: ["x-api-key", "authorization"],
    }],
    stdin: "Copy the fixture.",
    timeoutMs: 5_000,
    workspaceFiles: [
      {
        path: ".agents/skills/copy/SKILL.md",
        source: { kind: "selected-resource", handle: "h1", sha256: "a".repeat(64) },
      },
      {
        path: ".hurdle/dsh-patch.json",
        source: { kind: "generated", bytes: patch, sha256: sha(patch) },
      },
    ],
  });
  assert.ok(Object.isFrozen(plan.args));
});

test("dsh Adapter maps effort to dsh reasoning levels and omits unset fields", () => {
  const adapter = createDshAdapter({ runtimeEnv: {} });
  const config = (requestedModel, settings) => JSON.parse(
    adapter.createLaunchPlan({ prompt: "", requestedModel, settings })
      .workspaceFiles.at(-1).source.bytes.toString(),
  )[0].config;
  assert.deepEqual(config(null, {}), { provider: "deepseek-official", model: "deepseek-flash" });
  assert.equal(config(null, { effort: "low" }).reasoningEffort, "low");
  assert.equal(config(null, { effort: "medium" }).reasoningEffort, "high");
  assert.equal(config(null, { effort: "high" }).reasoningEffort, "high");
  assert.equal(config(null, { effort: "max" }).reasoningEffort, "max");
  const plan = adapter.createLaunchPlan({ prompt: "", requestedModel: null, settings: {} });
  assert.deepEqual(plan.credentialRoutes, []);
  assert.equal(plan.env.DEEPSEEK_API_KEY, undefined);
});

test("dsh Adapter refuses selected MCP servers", () => {
  const adapter = createDshAdapter({ runtimeEnv: {} });
  assert.throws(() => adapter.createLaunchPlan({
    prompt: "",
    requestedModel: null,
    settings: {},
    resources: { skills: [], mcpServers: [{ id: "x", transport: { kind: "http", url: "https://example.test" } }] },
  }), /does not support selected MCP servers/);
});

test("dsh Adapter decodes session, usage, turns, and tool calls from --json events", () => {
  const adapter = createDshAdapter({ runtimeEnv: {} });
  const decoded = adapter.decodeControllerEvidence({
    stdout: [
      line({ type: "session", sessionId: "sess-1", cwd: "/work" }),
      line({ type: "status", phase: "turn_start" }),
      line({ type: "status", phase: "step_start" }),
      line({ type: "thinking", text: "plan" }),
      line({ type: "tool_call", callId: "c1", tool: "bash", input: { command: "ls" } }),
      line({ type: "tool_result", callId: "c1", status: "ok", result: "a.txt" }),
      line({ type: "status", phase: "step_end", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 64, reasoningTokens: 5 } }),
      line({ type: "status", phase: "step_start" }),
      line({ type: "tool_call", callId: "c2", tool: "write", input: {} }),
      line({ type: "tool_result", callId: "c2", status: "error", result: null, error: "denied" }),
      line({ type: "status", phase: "step_end", usage: { inputTokens: 150, outputTokens: 30, totalTokens: 180 } }),
      line({ type: "text", text: "Done." }),
      line({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } }),
      line({ type: "final", sessionId: "sess-1", reason: { kind: "completed" }, text: "Done." }),
      "",
    ].join("\n"),
  });

  assert.equal(decoded.sessionId, "sess-1");
  assert.equal(decoded.observedModel, null);
  assert.equal(decoded.operatorReason, undefined);
  assert.deepEqual(decoded.metrics, {
    common: { inputTokens: 250, outputTokens: 50, reportedCostUsd: null, turns: 1, toolCalls: 2 },
    adapter: {
      cacheReadTokens: 64,
      cacheWriteTokens: null,
      reasoningTokens: 5,
      toolErrors: 1,
      finalReason: "completed",
    },
  });
});

test("dsh Adapter names authentication, quota, and model failures with fixed text", () => {
  const adapter = createDshAdapter({ runtimeEnv: {} });
  const failedWith = (error) => adapter.decodeControllerEvidence({
    stdout: `${[
      line({ type: "session", sessionId: "s" }),
      line({ type: "final", sessionId: "s", reason: { kind: "error", error }, text: "" }),
    ].join("\n")}\n`,
  }).operatorReason;
  assert.match(failedWith({ code: "INVALID_CREDENTIAL", message: "provider detail" }), /^dsh authentication failed\..*DEEPSEEK_API_KEY/);
  assert.match(failedWith({ code: "MISSING_CREDENTIAL", message: "provider detail" }), /^dsh authentication failed\./);
  assert.match(failedWith({ code: "ACCOUNT_QUOTA", message: "provider detail" }), /insufficient quota or balance/);
  assert.match(failedWith({ code: "UNKNOWN", message: "Model Not Exist: model deepseek-typo does not exist" }), /could not use the requested model/);
  assert.equal(failedWith({ code: "UNKNOWN", message: "provider-supplied detail must not become an operator reason" }), undefined);

  const topLevel = adapter.decodeControllerEvidence({
    stdout: `${line({ type: "error", message: "HTTP 401 Unauthorized" })}\n`,
  });
  assert.match(topLevel.operatorReason, /^dsh authentication failed\./);
  assert.equal(topLevel.sessionId, null);
});

test("dsh Adapter fails closed on non-JSON controller output", () => {
  const adapter = createDshAdapter({ runtimeEnv: {} });
  assert.throws(() => adapter.decodeControllerEvidence({ stdout: "dsh: not json\n" }));
});

const PROVIDERS = {
  providers: {
    "one-nexus": {
      api: "openai-completions",
      baseURL: "https://gw.example.test/v1",
      apiKeyEnv: "ONE_NEXUS_API_KEY",
      models: [{ id: "dsv41f", reasoningEfforts: { low: "low", high: "high", max: "max" } }, { id: "shared" }],
    },
    nexus13: {
      api: "anthropic-messages",
      baseURL: "http://127.0.0.1:8317/v1",
      apiKeyEnv: "CLIPROXY_API_KEY",
      models: [{ id: "nexus13/claude-opus-5-5" }, { id: "shared" }],
    },
  },
};
const fileReader = (value) => () => JSON.stringify(value);
const envWith = (extra = {}) => ({ HURDLE_DSH_PROVIDERS: "/test/providers.json", ...extra });

test("dsh resolves models to configured providers or deepseek-official", () => {
  const providers = readDshProviders(envWith(), fileReader(PROVIDERS));
  assert.equal(resolveDshModel(providers, "dsv41f").provider, "one-nexus");
  assert.equal(resolveDshModel(providers, "nexus13/claude-opus-5-5").provider, "nexus13");
  assert.deepEqual(
    (({ provider, model }) => ({ provider, model }))(resolveDshModel(providers, "nexus13/shared")),
    { provider: "nexus13", model: "shared" },
  );
  assert.throws(() => resolveDshModel(providers, "shared"), /listed by several providers/);
  assert.throws(() => resolveDshModel(providers, "one-nexus/missing"), /does not list model 'missing'/);
  assert.equal(resolveDshModel(providers, "deepseek-pro").provider, "deepseek-official");
  assert.equal(resolveDshModel(providers, "deepseek-official/deepseek-pro").model, "deepseek-pro");
  assert.equal(resolveDshModel(providers, null).model, "deepseek-flash");
  assert.throws(() => resolveDshModel(providers, "one-nexsu/dsv41f"), /names no configured provider/);
  assert.throws(() => resolveDshModel(providers, "one-nexus/"), /names no configured provider/);
  assert.throws(() => resolveDshModel(providers, "deepseek-official/"), /names no configured provider/);
  assert.deepEqual(readDshProviders({}, () => assert.fail("no file read")), {});
});

test("dsh refuses unsafe or malformed provider files", () => {
  const refused = (providers, pattern) => assert.throws(
    () => readDshProviders(envWith(), fileReader({ providers })),
    pattern,
  );
  const base = PROVIDERS.providers["one-nexus"];
  refused({ "deepseek-official": base }, /provider name/);
  refused({ "deepseek-account": base }, /provider name/);
  refused({ p: { ...base, baseURL: "https://user@gw.example.test/v1" } }, /must not contain credentials/);
  refused({ p: { ...base, baseURL: "https://gw.example.test/v1?key=abc" } }, /must not contain credentials/);
  refused({ p: { ...base, token: "x" } }, /unsupported fields: token/);
  refused({ Bad: base }, /provider name/);
  refused({ p: { ...base, headers: { authorization: "Bearer x" } } }, /must not set headers/);
  refused({ p: { ...base, api: "other" } }, /api must be one of/);
  refused({ p: { ...base, apiKeyEnv: "PATH" } }, /apiKeyEnv/);
  refused({ p: { ...base, baseURL: "http://gw.example.test/v1" } }, /https, or http on a loopback/);
  refused({ p: { ...base, baseURL: "http://localhost:8317/v1" } }, /127\.0\.0\.1/);
  refused({ p: { ...base, models: [] } }, /models must list/);
  assert.throws(() => readDshProviders(envWith(), () => "not json"), /HURDLE_DSH_PROVIDERS: could not read/);
  assert.throws(() => readDshProviders(envWith(), fileReader({ providers: {}, extra: 1 })), /exactly/);
});

test("dsh baseURL rules: https, or http on 127.0.0.1 only; no credentials, query or fragment", () => {
  const base = PROVIDERS.providers["one-nexus"];
  const read = (baseURL) => readDshProviders(envWith(), fileReader({ providers: { p: { ...base, baseURL } } }));
  for (const baseURL of ["https://gw.example.test/v1", "http://127.0.0.1:8317/v1"])
    assert.equal(read(baseURL).p.baseURL, baseURL);
  for (const [baseURL, pattern] of [
    ["https://user@gw.example.test/v1", /must not contain credentials, a query, or a fragment/],
    [Object.assign(new URL("https://gw.example.test/v1"), { username: "u", password: "p" }).href, /must not contain credentials, a query, or a fragment/],
    ["https://gw.example.test/v1?key=abc", /must not contain credentials, a query, or a fragment/],
    ["https://gw.example.test/v1#frag", /must not contain credentials, a query, or a fragment/],
    ["http://gw.example.test/v1", /must use https, or http on a loopback address/],
    ["http://localhost:8317/v1", /must use 127\.0\.0\.1 rather than localhost/],
    ["https://localhost:8317/v1", /must use 127\.0\.0\.1 rather than localhost/],
    ["http://[::1]:8317/v1", /must use 127\.0\.0\.1 rather than \[::1\]/],
    ["gw.example.test/v1", /must be an absolute URL/],
  ]) assert.throws(() => read(baseURL), pattern, baseURL);
});

test("dsh routes only the selected provider's key and writes only its definition", () => {
  const adapter = createDshAdapter({
    runtimeEnv: envWith({ ONE_NEXUS_API_KEY: "one-nexus-secret-value", CLIPROXY_API_KEY: "cliproxy-secret-value", DEEPSEEK_API_KEY: "deepseek-secret-value" }),
    readFile: fileReader(PROVIDERS),
  });
  const plan = adapter.createLaunchPlan({ prompt: "", requestedModel: "dsv41f", settings: { effort: "medium" } });
  assert.equal(plan.env.ONE_NEXUS_API_KEY, "one-nexus-secret-value");
  assert.equal(plan.env.CLIPROXY_API_KEY, undefined);
  assert.equal(plan.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(plan.env.HURDLE_DSH_PROVIDERS, undefined);
  assert.deepEqual(plan.credentialRoutes, [{ environmentName: "ONE_NEXUS_API_KEY", hosts: ["gw.example.test"], headerNames: ["authorization"] }]);
  const patch = JSON.parse(plan.workspaceFiles.at(-1).source.bytes.toString());
  assert.deepEqual(patch, [
    { id: "llm-pi-ai", config: { providers: { "one-nexus": PROVIDERS.providers["one-nexus"] } } },
    { id: "agent-default-model", config: { provider: "one-nexus", model: "dsv41f", reasoningEffort: "high" } },
  ]);

  const loopback = adapter.createLaunchPlan({ prompt: "", requestedModel: "nexus13/claude-opus-5-5", settings: {} });
  assert.deepEqual(loopback.credentialRoutes, [{ environmentName: "CLIPROXY_API_KEY", hosts: ["127.0.0.1"], headerNames: ["x-api-key", "authorization"] }]);
  assert.throws(
    () => adapter.createLaunchPlan({ prompt: "", requestedModel: "nexus13/claude-opus-5-5", settings: { effort: "high" } }),
    /does not offer effort 'high'/,
  );
  for (const secret of ["one-nexus-secret-value", "cliproxy-secret-value", "deepseek-secret-value"]) {
    assert.doesNotMatch(adapter.redactControllerText(`x ${secret} y`), new RegExp(secret));
  }
});
