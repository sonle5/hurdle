import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createFrameworkCli } from "../bin/tae.mjs";
import { createSetupTemplate, inspectSetupTemplate } from "../lib/sandbox-setup.mjs";
import { checkAgentReadiness } from "../lib/agent-readiness.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";
import { evaluateChecks } from "../lib/v1-evaluator-runtime.mjs";
import { promptSetup } from "../lib/setup-prompts.mjs";
import { PassThrough } from "node:stream";

async function fixture(t, example = "copy-message") {
  const root = mkdtempSync(join(tmpdir(), "hurdle-setup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal((await initializeSuite({ destination: join(root, "evals"), example })).ok, true);
  let output = "";
  const io = { cwd: root, stdout: { write(v) { output += v; } }, stderr: { write(v) { output += v; } } };
  const calls = [];
  const env = { E2B_API_KEY: "test-e2b-secret", ANTHROPIC_API_KEY: "test-agent-secret", TOGETHER_API_KEY: "test-target-secret" };
  const dependencies = {
    env,
    processTarget: new EventEmitter(),
    assertRuntimeDependencies() {},
    async checkAgentReadiness(input) { calls.push(["readiness", input]); return { ok: true, checks: [{ status: "pass", message: "Credentials verified." }] }; },
    async loadSetupBackend() { return { async exists() { calls.push(["exists"]); return false; }, async build(...args) { calls.push(["build", ...args]); return { templateId: "built" }; } }; },
    createE2BExecutionEnvironment() { assert.fail("Setup/validation must not allocate execution resources"); },
    async openLocalResultStore() { assert.fail("Setup/validation must not create a Result Store"); },
    promptSetup: async () => null,
  };
  return { root, io, dependencies, calls, output: () => stripVTControlCharacters(output), runtime: () => JSON.parse(readFileSync(join(root, ".hurdle/runtime/default.json"), "utf8")) };
}

test("setup builds once, saves a default, and validate/view discover it without execution", async t => {
  const f = await fixture(t, "together-api");
  let available = false, builds = 0;
  const cli = createFrameworkCli({ ...f.dependencies,
    async loadSetupBackend() { return { exists: async () => available, async build(name, ids, key) {
      assert.deepEqual(ids, ["claude-code"]); assert.equal(key, f.dependencies.env.E2B_API_KEY);
      available = true; builds++; return { templateId: "test-template" };
    } }; },
    async launchViewer({ storeEnvironment }) { assert.equal(storeEnvironment.TAE_RESULT_STORE_ROOT, join(f.root, ".hurdle/e2b-results-v1")); return { kind: "stopped" }; },
  });
  assert.equal(await cli.main(["setup", "--yes"], f.io), 0, f.output());
  assert.equal(builds, 1);
  const config = f.runtime();
  assert.equal(config.environment.kind, "e2b");
  assert.equal(config.environment.settings.maxLifetimeMs, 300_000);
  assert.equal(config.judge, undefined);
  assert.equal(existsSync(join(f.root, ".env.local")), false, "Exported credentials must not be copied");
  assert.equal(await cli.main(["validate"], f.io), 0, f.output());
  const checked = f.calls.at(-1)[1];
  assert.equal(checked.runtimeProfile.environment.kind, "e2b");
  assert.deepEqual(checked.requiredCredentials, ["TOGETHER_API_KEY"]);
  assert.equal(await cli.main(["view"], f.io), 0);
  assert.equal(await cli.main(["setup", "--yes"], f.io), 0);
  assert.equal(builds, 1, "An available template must be reused without build usage");
  assert.equal(readFileSync(join(f.root, ".gitignore"), "utf8"), "/.env.local\n/.hurdle/\n/.tae/\n");
  assert.doesNotMatch(f.output(), /test-e2b-secret|test-agent-secret|test-target-secret/);
});

test("setup, validate, and view reuse an existing .tae Runtime and preserve its store", async t => {
  const f = await fixture(t, "together-api");
  const path = join(f.root, ".tae/runtime/default.json");
  const config = { schemaVersion: 1, environment: { kind: "e2b", apiKeyEnv: "E2B_API_KEY", settings: { workloadTemplate: "existing:v1", cpuCount: 2, memoryMiB: 2048, maxLifetimeMs: 120_000 } }, resultStore: { kind: "local", root: "../e2b-results-v1" }, viewer: { port: 3050 } };
  mkdirSync(join(f.root, ".tae/runtime"), { recursive: true });
  writeFileSync(path, JSON.stringify(config));
  const stores = [];
  const cli = createFrameworkCli({ ...f.dependencies,
    loadSetupBackend: async () => ({ exists: async () => true, build() { assert.fail("Existing template must be reused"); } }),
    async launchViewer({ storeEnvironment }) { stores.push(storeEnvironment.TAE_RESULT_STORE_ROOT); return { kind: "stopped" }; },
  });
  assert.equal(await cli.main(["setup"], f.io), 0, f.output());
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), config);
  assert.equal(existsSync(join(f.root, ".hurdle")), false);
  assert.match(f.output(), /Runtime\s+\.tae\/runtime\/default\.json/);
  assert.equal(await cli.main(["validate"], f.io), 0, f.output());
  assert.equal(f.calls.at(-1)[1].runtimeProfile.environment.kind, "e2b");
  assert.equal(await cli.main(["view"], f.io), 0, f.output());
  assert.deepEqual(stores, [join(f.root, ".tae/e2b-results-v1")]);
  assert.match(readFileSync(join(f.root, ".gitignore"), "utf8"), /\/\.tae\//);
});

test("setup adopts existing template capacity and rejects invalid Runtime limits before provider requests", async t => {
  const f = await fixture(t);
  const cli = createFrameworkCli({ ...f.dependencies, loadSetupBackend: async () => ({ exists: async () => ({ cpuCount: 1, memoryMB: 1024 }) }) });
  assert.equal(await cli.main(["setup", "--template", "my-template:v1"], f.io), 0, f.output());
  const config = f.runtime();
  assert.equal(config.environment.settings.cpuCount, 1);
  assert.equal(config.environment.settings.memoryMiB, 1024);
  config.environment.settings.maxLifetimeMs = -1;
  writeFileSync(join(f.root, ".hurdle/runtime/default.json"), JSON.stringify(config));
  const before = f.calls.length;
  assert.equal(await cli.main(["setup"], f.io), 1);
  assert.equal(f.calls.length, before);
  assert.match(f.output(), /maxLifetimeMs.*integer/);
});

test("the API starter's Local runtime is rejected by validate and run before authentication or store creation", async t => {
  const f = await fixture(t, "together-api");
  const cli = createFrameworkCli(f.dependencies);
  for (const command of ["validate", "run"]) assert.equal(await cli.main([command], f.io), 1);
  assert.equal(f.calls.length, 0);
  assert.match(f.output(), /runtime.capture-required/);
  assert.equal(existsSync(join(f.root, ".hurdle/results-v1")), false);
});

test("missing/rejected credentials, declined builds, and missing custom templates stop before usage", async t => {
  for (const scenario of ["missing", "rejected", "declined", "custom", "cancelled"]) {
    const f = await fixture(t);
    const deps = { ...f.dependencies };
    const args = ["setup"];
    if (scenario === "missing") deps.env = {};
    if (scenario === "rejected") deps.checkAgentReadiness = async () => ({ ok: false, checks: [{ status: "fail", message: "Credential rejected." }] });
    if (scenario === "custom") args.push("--template", "my-agent:v1", "--yes");
    if (scenario === "cancelled") deps.promptSetup = async () => "n";
    assert.equal(await createFrameworkCli(deps).main(args, f.io), 1, `${scenario}: ${f.output()}`);
    assert.equal(f.calls.filter(c => c[0] === "build").length, 0, scenario);
    assert.equal(existsSync(join(f.root, ".hurdle/runtime/default.json")), false, scenario);
    if (["missing", "rejected"].includes(scenario)) assert.equal(f.calls.some(c => c[0] === "exists"), false);
  }
});

test("hidden prompted credentials are saved privately without changing existing project values", async t => {
  const f = await fixture(t, "together-api");
  writeFileSync(join(f.root, ".env.local"), "# existing settings\nKEEP_ME=yes\nANTHROPIC_API_KEY=\n");
  const prompts = [];
  f.io.stdin = { isTTY: true };
  f.io.stdout.isTTY = true;
  const cli = createFrameworkCli({ ...f.dependencies, env: {},
    promptSetup: async options => {
      prompts.push(options);
      if (!options.secret) return "";
      const name = options.message.trim().split(" ")[0];
      return `private-${name}`;
    },
  });
  assert.equal(await cli.main(["setup", "--yes"], f.io), 0, f.output());
  const path = join(f.root, ".env.local");
  const saved = parseEnv(readFileSync(path, "utf8"));
  assert.equal(saved.KEEP_ME, "yes");
  for (const name of ["E2B_API_KEY", "ANTHROPIC_API_KEY", "TOGETHER_API_KEY"]) assert.equal(saved[name], `private-${name}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readFileSync(join(f.root, ".gitignore"), "utf8"), /\/\.env\.local\n\/\.hurdle\//);
  assert.equal(prompts.filter(p => p.secret).length, 3);
  assert.doesNotMatch(f.output(), /private-E2B|private-ANTHROPIC|private-TOGETHER/);
});

test("setup refuses credential symlinks and suppresses provider exception details", async t => {
  const f = await fixture(t);
  const target = join(f.root, "secret-target");
  writeFileSync(target, "KEEP=untouched\n");
  symlinkSync(target, join(f.root, ".env.local"));
  assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--yes"], f.io), 1);
  assert.equal(readFileSync(target, "utf8"), "KEEP=untouched\n");
  assert.equal(f.calls.length, 0);
  const g = await fixture(t);
  const cli = createFrameworkCli({ ...g.dependencies, loadSetupBackend: async () => ({ exists: async () => true }), checkAgentReadiness: async () => { throw Error("private-response test-agent-secret"); } });
  assert.equal(await cli.main(["setup"], g.io), 1);
  assert.doesNotMatch(g.output(), /private-response|test-agent-secret/);
});

test("a failed build cannot change an active runtime, and reruns preserve custom settings", async t => {
  const f = await fixture(t);
  const runtime = { schemaVersion: 1, environment: { kind: "e2b", apiKeyEnv: "E2B_API_KEY", settings: { workloadTemplate: "existing:v1", cpuCount: 2, memoryMiB: 2048, maxLifetimeMs: 120_000 } }, resultStore: { kind: "local", root: "../custom-results" }, viewer: { port: 3050 } };
  mkdirSync(join(f.root, ".hurdle/runtime"), { recursive: true });
  writeFileSync(join(f.root, ".hurdle/runtime/default.json"), JSON.stringify(runtime));
  const failed = createFrameworkCli({ ...f.dependencies, loadSetupBackend: async () => ({ exists: async () => false, build: async () => { throw Error("private-build-error"); } }) });
  assert.equal(await failed.main(["setup", "--yes"], f.io), 1);
  assert.deepEqual(f.runtime(), runtime);
  assert.doesNotMatch(f.output(), /private-build-error/);
  const success = createFrameworkCli({ ...f.dependencies, loadSetupBackend: async () => ({ exists: async () => true }) });
  assert.equal(await success.main(["setup"], f.io), 0);
  assert.deepEqual(f.runtime(), runtime);
});

test("explicit Runtime/topology selections override the saved default and unsupported providers fail early", async t => {
  const f = await fixture(t);
  assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--yes"], f.io), 0);
  const cli = createFrameworkCli(f.dependencies);
  assert.equal(await cli.main(["validate", "--environment", "local"], f.io), 0);
  assert.equal(f.calls.at(-1)[1].runtimeProfile.environment.kind, "local");
  writeFileSync(join(f.root, "local.json"), JSON.stringify({ schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "local", root: "./local-results" } }));
  assert.equal(await cli.main(["validate", "--runtime", "local.json"], f.io), 0);
  assert.equal(f.calls.at(-1)[1].runtimeProfile.environment.kind, "local");
  const before = f.calls.length;
  for (const args of [["--sandbox", "together"], ["--template"], ["--yes", "--yes"]]) assert.equal(await cli.main(["setup", ...args], f.io), 2);
  assert.equal(f.calls.length, before);
});

test("Together credentials are authenticated read-only without inference or provider body disclosure", async () => {
  for (const status of [200, 401]) {
    const checked = await checkAgentReadiness({ agentSelections: [], runtimeProfile: { environment: { kind: "local" }, resultStore: { kind: "local" } }, runtimeEnv: { TOGETHER_API_KEY: "test-target-secret" }, requiredCredentials: ["TOGETHER_API_KEY"] }, { fetch: async (url, options) => {
      assert.equal(url, "https://api.together.ai/v1/models");
      assert.equal(options.method, "GET"); assert.equal(options.body, undefined); assert.equal(options.redirect, "error");
      assert.equal(options.headers.authorization, "Bearer test-target-secret");
      return { status, body: { cancel() {} }, text() { assert.fail("Provider body must not be read"); } };
    } });
    assert.equal(checked.ok, status === 200);
    assert.equal(checked.checks.length, 1);
    assert.doesNotMatch(JSON.stringify(checked), /test-target-secret/);
  }
});

test("Together starter requires trusted traffic and rejects missing evidence and extra inference attempts", async t => {
  const f = await fixture(t, "together-api");
  const suite = await resolveV1Suite({ suitePath: join(f.root, "evals/example.suite.mjs") });
  t.after(() => suite.dispose());
  assert.equal(suite.ok, true);
  const task = suite.value.definition.tasks["together-api"];
  assert.ok(task.executionRequirements.includes("environment.trusted-egress-capture"));
  assert.equal(task.credentialDeliveryOverrides.TOGETHER_API_KEY.kind, "captured-http-header");
  const { default: checks } = await import(join(suite.generatedRoot, "evaluators/together-api-checks.mjs"));
  const completion = { id: "chat-test", choices: [{ message: { content: "It checks agent behavior." } }], usage: { total_tokens: 20 } };
  const artifacts = { "completion.json": JSON.stringify(completion) };
  const request = { method: "POST", host: "api.together.ai", path: "/v1/chat/completions", statusCode: 200, evidenceRef: "request-chat" };
  const input = {
    snapshot: { target: { egress: { relevantHosts: ["api.together.ai"] } } },
    transcript: { jsonl: JSON.stringify({ type: "result", subtype: "success" }), evidenceRef: "transcript" },
    readArtifactText: path => ({ status: "present", text: artifacts[path], evidenceRef: path }),
    egress: [{ status: "captured", provenance: { lifecyclePhase: "execution", trust: "environment-observed" }, requests: [{ ...request, method: "GET", path: "/v1/models" }, request] }],
  };
  assert.ok(evaluateChecks(checks, input).checks.every(c => c.outcome === "pass"));
  assert.equal(evaluateChecks(checks, { ...input, egress: [] }).checks.find(c => c.id === "chat-completion").outcome, "skip");
  assert.equal(evaluateChecks(checks, { ...input, egress: [{ ...input.egress[0], requests: [...input.egress[0].requests, request] }] }).checks.find(c => c.id === "one-completion").outcome, "fail");
  assert.equal(evaluateChecks(checks, { ...input, readArtifactText: () => ({ status: "missing" }) }).checks.find(c => c.id === "completion-shape").outcome, "fail");
  for (const invalid of [{}, { choices: [{ message: { content: "" } }], usage: { total_tokens: 20 } }, { ...completion, usage: { total_tokens: 0 } }]) {
    assert.equal(evaluateChecks(checks, { ...input, readArtifactText: () => ({ status: "present", text: JSON.stringify(invalid) }) }).checks.find(c => c.id === "completion-shape").outcome, "fail");
  }
});

test("template recipe includes requested Agent CLIs and API tools but no credentials", () => {
  const commands = [];
  const recipe = { fromImage(image) { commands.push(image); return this; }, runCmd(command) { commands.push(command); return this; } };
  createSetupTemplate(() => recipe, ["claude-code", "codex"]);
  const source = commands.join("\n");
  assert.match(source, /curl jq git/);
  assert.match(source, /@anthropic-ai\/claude-code@2\.1\.288/);
  assert.match(source, /@openai\/codex@0\.141\.0/);
  assert.doesNotMatch(source, /API_KEY|TOKEN|secret/);
});

test("template inspection is read-only, respects tags, and rejects forbidden or unfinished builds", async () => {
  for (const scenario of ["ready", "forbidden", "building", "tag-missing", "details-missing"]) {
    const calls = [];
    const client = { api: { async GET(route, options) {
      calls.push(route);
      let data;
      if (route.includes("aliases")) { assert.equal(options.params.path.alias, "my-template"); data = { templateID: "id-template" }; }
      else if (route.endsWith("/tags")) data = scenario === "tag-missing" ? [] : [{ tag: "v1", buildID: "build-1" }];
      else data = { builds: scenario === "details-missing" ? [] : [{ buildID: "build-1", status: scenario === "building" ? "building" : "ready", cpuCount: 1, memoryMB: 1024 }] };
      return { data, response: { status: scenario === "forbidden" ? 403 : 200 } };
    } } };
    if (["forbidden", "building", "details-missing"].includes(scenario)) await assert.rejects(inspectSetupTemplate(client, "my-template:v1"), /denied access|still building|will not rebuild/);
    else assert.deepEqual(await inspectSetupTemplate(client, "my-template:v1"), scenario === "tag-missing" ? false : { cpuCount: 1, memoryMB: 1024 });
    if (scenario === "forbidden") assert.equal(calls.length, 1);
  }
});

test("secret terminal prompts do not echo input and restore terminal state after Enter or cancellation", async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough();
    input.isTTY = true; input.isRaw = false;
    input.setRawMode = value => { input.isRaw = value; };
    let output = "";
    const pending = promptSetup({ message: "Key (hidden): ", secret: true }, { stdin: input, stdout: { isTTY: true, write(v) { output += v; } } });
    input.write("private-prompt-key");
    input.write(cancel ? "\u0003" : "\r");
    assert.equal(await pending, cancel ? null : "private-prompt-key");
    assert.equal(output, "Key (hidden): \n");
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount("keypress"), 0);
    input.destroy();
  }
});
