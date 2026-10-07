import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkAgentReadiness, probeAgentCli } from "../lib/agent-readiness.mjs";
import { createFrameworkCli } from "../bin/hurdle.mjs";
import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

const profile = { environment: { kind: "local" }, resultStore: { kind: "local" } };
const input = (runtimeEnv, adapterId = "claude-code") => ({
  runtimeProfile: profile, runtimeEnv, agentSelections: [{ adapterId }],
});
const success = () => new Response('{"data":[]}', { status: 200 });

test("invalid Claude key wins over OAuth and yields a safe actionable diagnosis", async () => {
  let probes = 0, bodiesRead = 0;
  const checked = await checkAgentReadiness(input({
    ANTHROPIC_API_KEY: "private-bad-key", CLAUDE_CODE_OAUTH_TOKEN: "private-token",
    ANTHROPIC_BASE_URL: "https://untrusted.example",
  }), {
    probeCli: async command => { assert.equal(command, "claude"); return true; },
    fetch: async (url, options) => {
      probes++;
      assert.equal(url, "https://api.anthropic.com/v1/models?limit=1");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.body, undefined);
      assert.equal(options.headers["x-api-key"], "private-bad-key");
      assert.equal(options.headers.authorization, undefined);
      return { status: 401, body: { cancel() {} }, text() { bodiesRead++; throw Error("private-response"); } };
    },
  });
  assert.equal(checked.ok, false);
  assert.equal(probes, 1);
  assert.equal(bodiesRead, 0);
  const text = JSON.stringify(checked);
  assert.match(text, /takes precedence/);
  assert.match(text, /HTTP 401/);
  assert.match(text, /claude setup-token/);
  assert.doesNotMatch(text, /private-bad-key|private-token|private-response|untrusted/);
});

test("an agent and Judge sharing a key get one authentication check and one status line", async () => {
  let requests = 0;
  const checked = await checkAgentReadiness({
    ...input({ ANTHROPIC_API_KEY: "test-only-key" }),
    judgeCredentialName: "ANTHROPIC_API_KEY",
  }, {
    probeCli: async () => true,
    fetch: async () => { requests++; return success(); },
  });
  assert.equal(checked.ok, true);
  assert.equal(requests, 1);
  assert.equal(checked.checks.filter(value => value.code.startsWith("auth.")).length, 1);
});

test("OpenAI key probes follow the Codex adapter's precedence and never infer", async () => {
  const checked = await checkAgentReadiness(input({ CODEX_API_KEY: "selected", OPENAI_API_KEY: "ignored" }, "codex"), {
    probeCli: async command => command === "codex",
    fetch: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/models");
      assert.equal(options.headers.authorization, "Bearer selected");
      return success();
    },
  });
  assert.equal(checked.ok, true);
  assert.match(JSON.stringify(checked), /OpenAI · CODEX_API_KEY verified/);
  assert.equal(checked.checks.filter(value => value.code.startsWith("auth.")).length, 1);
});

test("subscription credentials report presence without claiming live verification", async () => {
  for (const [adapter, name] of [["claude-code", "CLAUDE_CODE_OAUTH_TOKEN"], ["codex", "CODEX_ACCESS_TOKEN"]]) {
    const checked = await checkAgentReadiness(input({ [name]: "configured-token", OPENAI_API_KEY: "ignored" }, adapter), {
      probeCli: async () => true,
      fetch() { throw new Error("Subscription tokens must not be sent to API-key endpoints"); },
    });
    assert.equal(checked.ok, true);
    assert.ok(checked.checks.some(value => value.code === "auth.token-unverified" && value.status === "warning"));
    assert.equal(checked.checks.some(value => value.code === "auth.verified"), false);
  }
});

test("missing executable, isolated authentication, and task credentials are diagnosed", async () => {
  const checked = await checkAgentReadiness({ ...input({}), requiredCredentials: ["TASK_KEY"] }, {
    probeCli: async () => false,
    fetch() { assert.fail("No credential to probe"); },
  });
  assert.equal(checked.ok, false);
  assert.equal(checked.checks.filter(value => value.status === "fail").length, 3);
  assert.match(JSON.stringify(checked), /interactive login/);
});

test("network failures, forbidden checks, and provider errors are not called invalid credentials", async () => {
  for (const status of [403, 429, 500, 302]) {
    const checked = await checkAgentReadiness(input({ ANTHROPIC_API_KEY: "secret" }), {
      probeCli: async () => true,
      fetch: async () => new Response("secret-provider-body", { status }),
    });
    assert.equal(checked.ok, false);
    assert.equal(checked.checks.some(value => value.code === "auth.rejected"), false);
    assert.doesNotMatch(JSON.stringify(checked), /secret-provider-body/);
  }
  let signal;
  const checked = await checkAgentReadiness(input({ ANTHROPIC_API_KEY: "secret" }), {
    probeCli: async () => true,
    fetch: async (_, options) => { signal = options.signal; throw new Error("secret-error"); },
  });
  assert.ok(signal instanceof AbortSignal);
  assert.equal(checked.ok, false);
  assert.match(JSON.stringify(checked), /within 5 seconds/);
  assert.doesNotMatch(JSON.stringify(checked), /secret-error/);
});

test("remote runtimes check account access without checking the host CLI or allocating resources", async () => {
  const checked = await checkAgentReadiness({
    ...input({ CLAUDE_CODE_OAUTH_TOKEN: "token", REMOTE_KEY: "e2b", DATABASE_URL: "postgres-secret" }),
    runtimeProfile: { environment: { kind: "e2b", apiKeyEnv: "REMOTE_KEY" }, resultStore: { kind: "postgres", databaseUrlEnv: "DATABASE_URL" } },
  }, {
    probeCli() { assert.fail("Local executable does not establish remote readiness"); },
    checkE2b: async key => { assert.equal(key, "e2b"); return { status: "pass", message: "account accessible" }; },
    checkPostgres: async value => { assert.equal(value, "postgres-secret"); return { status: "fail", message: "connection unavailable" }; },
  });
  assert.equal(checked.ok, false);
  assert.ok(checked.checks.some(value => value.code === "agent.remote-unverified"));
  assert.doesNotMatch(JSON.stringify(checked), /postgres-secret/);
});

test("CLI validate and run reject bad authentication before a store, agent, Judge, or Viewer starts", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-onboarding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = () => {
    let text = "";
    return { cwd: root, stdout: { write(v) { text += v; } }, stderr: { write(v) { text += v; } }, read: () => text };
  };
  let effects = 0, checks = 0;
  const forbidden = () => { effects++; throw Error("must not start"); };
  const cli = createFrameworkCli({
    env: { ANTHROPIC_API_KEY: "bad-secret" }, environmentSource: ".env.local", processTarget: new EventEmitter(),
    checkAgentReadiness: async args => {
      checks++;
      return checkAgentReadiness(args, { probeCli: async () => true, fetch: async () => new Response("private", { status: 401 }) });
    },
    openLocalResultStore: forbidden, openPostgresResultStore: forbidden,
    createAgentAdapter: forbidden, createRunEngine: forbidden,
    createAnthropicJsonJudge: forbidden, launchViewer: forbidden,
  });
  assert.equal(await cli.main(["init"], io()), 0);
  for (const command of [["validate"], ["run", "--view"]]) {
    const output = io();
    assert.equal(await cli.main(command, output), 1);
    assert.match(output.read(), /Readiness \(.env.local\)/);
    assert.match(output.read(), /rejected ANTHROPIC_API_KEY/);
    assert.match(output.read(), /No evaluation started/);
    assert.doesNotMatch(output.read(), /bad-secret|private/);
  }
  assert.equal(checks, 2);
  assert.equal(effects, 0);
  assert.equal(existsSync(join(root, ".hurdle/results-v1")), false);
  const offline = io();
  assert.equal(await cli.main(["validate", "--offline"], offline), 0);
  assert.equal(checks, 2);
  assert.match(offline.read(), /Readiness not checked/);
  assert.equal(await cli.main(["run", "--offline"], io()), 2, "Run cannot bypass readiness");
});

test("a real executable version probe receives no credentials and an isolated HOME", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-probe-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "probe");
  const receipt = join(root, "receipt.json");
  writeFileSync(command, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,realHome:fs.realpathSync(process.env.HOME),hasCredential:Boolean(process.env.ANTHROPIC_API_KEY),hasOptions:Boolean(process.env.NODE_OPTIONS)}));\n`);
  chmodSync(command, 0o755);
  assert.equal(await probeAgentCli(command, { PATH: process.env.PATH, HOME: root, ANTHROPIC_API_KEY: "private", NODE_OPTIONS: "private-options" }), true);
  const observed = JSON.parse(readFileSync(receipt, "utf8"));
  assert.deepEqual(observed.args, ["--version"]);
  assert.equal(observed.hasCredential, false);
  assert.equal(observed.hasOptions, false);
  assert.notEqual(observed.home, root);
  assert.equal(observed.cwd, observed.realHome);
  assert.equal(existsSync(observed.home), false, "probe workspace is disposed");
  assert.equal(await probeAgentCli("hurdle-no-such-executable", { PATH: "" }), false);
});

test("Claude's actual terminal 401 frame yields a safe operator reason without terminal_reason", () => {
  const decoded = createClaudeCodeAdapter({ runtimeEnv: { ANTHROPIC_API_KEY: "private" } }).decodeControllerEvidence({
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 401,
      result: "Failed to authenticate. API Error: 401 API key is invalid. private" }) + "\n", exitCode: 1,
  });
  assert.match(decoded.operatorReason, /Claude Code authentication failed/);
  assert.match(decoded.operatorReason, /npx hurdle validate/);
  assert.doesNotMatch(decoded.operatorReason, /private/);
});

test("init --agent codex creates a valid Codex starter and gives the right credential guidance", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-codex-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let text = "";
  const io = { cwd: root, stdout: { write(v) { text += v; } }, stderr: { write(v) { text += v; } } };
  const cli = createFrameworkCli();
  assert.equal(await cli.main(["init", "--agent", "codex"], io), 0);
  assert.match(text, /Agent     Codex/);
  assert.match(text, /Auth      .env.local or shell/);
  let guidance = "";
  await cli.main(["help", "init"], { ...io, stdout: { write(v) { guidance += v; } } });
  assert.match(guidance, /Codex uses CODEX_ACCESS_TOKEN/);
  const suite = await resolveV1Suite({ suitePath: join(root, "evals/example.suite.mjs") });
  t.after(() => suite.dispose());
  assert.equal(suite.ok, true);
  assert.equal(suite.defaults.agentSelections[0].adapterId, "codex");
  assert.equal(await cli.main(["init", "another", "--agent", "unknown"], io), 2);
  assert.equal(existsSync(join(root, "another")), false);
});

test("readiness symbols use run colors and respect NO_COLOR and redirected output", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-readiness-colors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = createFrameworkCli({
    env: {},
    checkAgentReadiness: async () => ({ ok: false, checks: [
      { status: "pass", message: "installed" },
      { status: "warning", message: "unverified" },
      { status: "fail", message: "rejected" },
    ] }),
  });
  let text = "";
  const output = { cwd: root, stdout: { isTTY: true, write(v) { text += v; } }, stderr: { write(v) { text += v; } } };
  assert.equal(await cli.main(["init"], output), 0);
  const original = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    text = "";
    assert.equal(await cli.main(["validate"], output), 1);
    assert.match(text, /\u001b\[32m✓\u001b\[0m installed/);
    assert.match(text, /\u001b\[33m!\u001b\[0m unverified/);
    assert.match(text, /\u001b\[31m✗\u001b\[0m rejected/);
    process.env.NO_COLOR = "1";
    text = "";
    await cli.main(["validate"], output);
    assert.doesNotMatch(text, /\u001b/);
    delete process.env.NO_COLOR;
    output.stdout.isTTY = false;
    output.stderr.isTTY = false;
    text = "";
    await cli.main(["validate"], output);
    assert.doesNotMatch(text, /\u001b/);
  } finally {
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  }
});
