import assert from "node:assert/strict";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { rootCertificates } from "node:tls";

import {
  createEngineBridge,
  createTarEndScanner,
  resolveEngineArgv,
  normalizeEngineBridgeConfig,
} from "../lib/execution-environments/engine-bridge.mjs";
import { connectEngineShim } from "../lib/execution-environments/engine-shim.mjs";
import { createSandboxServer } from "../lib/execution-environments/sandbox-server.mjs";
import { createTogetherSocketProvider } from "../lib/execution-environments/together-socket-provider.mjs";

const FAKE = join(import.meta.dirname, "fixtures", "fake-nexus-compiler.mjs");
const ROOT = "/data/sc-run/R";
const LOOP_PINS = { root: ROOT, engineId: "e1" };
const SETUP_PINS = { root: ROOT, task: "/rows/t/task.json", startRoot: "/rows/t", modelDir: "/models/m", runtime: "kubernetes" };
const EMPTY_SHA = createHash("sha256").digest("hex");

function bridge(profile = "loop", options = {}, dependencies = {}) {
  const { env, ...rest } = options;
  return createEngineBridge({
    profile,
    command: [process.execPath, FAKE],
    env: { PATH: process.env.PATH, ...env },
    pins: profile === "loop" ? LOOP_PINS : SETUP_PINS,
    statusMinIntervalMs: 0,
    ...rest,
  }, dependencies);
}

function config(profile, extra = {}) {
  return normalizeEngineBridgeConfig({
    profile, command: ["python3", "-m", "nexus_compiler"],
    pins: profile === "loop" ? LOOP_PINS : SETUP_PINS, ...extra,
  });
}

function entries(engine) {
  return engine.log().toString("utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function collect(engine, argv, stdin = Buffer.alloc(0)) {
  const stdout = [];
  const stderr = [];
  const result = await engine.call({ argv, stdin }, {
    onStdout: (chunk) => stdout.push(chunk), onStderr: (chunk) => stderr.push(chunk),
  });
  return { ...result, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

test("each profile allows only its own verbs and flags", () => {
  const loop = config("loop");
  assert.deepEqual(resolveEngineArgv(loop, ["engine", "submit", "--tier", "slow", "--forward", "-"]).argv,
    ["engine", "submit", "--engine-id", "e1", "--tier", "slow", "--forward", "-", "--root", ROOT]);
  assert.deepEqual(resolveEngineArgv(loop, ["engine", "status"]).argv, ["engine", "status", "--root", ROOT]);
  for (const argv of [
    ["lock", "--task", SETUP_PINS.task],
    ["check", "--lock", "/rows/t/lock.json"],
    ["engine", "up"],
    ["engine", "stop"],
    ["engine", "serve"],
    ["serve"],
    [],
    ["python3", "-m", "nexus_compiler"],
  ]) assert.equal(resolveEngineArgv(loop, argv).refused, "verb-not-allowed", argv.join(" "));
  for (const argv of [
    ["engine", "submit", "--back-to-back", "3"],
    ["engine", "submit", "--forward", "/etc/passwd"],
    ["engine", "submit", "--tier", "medium"],
    ["engine", "submit", "--tier"],
    ["engine", "status", "--hold"],
    ["engine", "records", "--hold=1"],
  ]) assert.equal(resolveEngineArgv(loop, argv).refused, "flag-not-allowed", argv.join(" "));

  const setup = config("setup");
  assert.deepEqual(
    resolveEngineArgv(setup, ["lock", "--reproduce", "--repeats", "3", "--hours=2.5", "--depths", "4,8"]).argv,
    ["lock", "--task", SETUP_PINS.task, "--start-root", SETUP_PINS.startRoot, "--model-dir", SETUP_PINS.modelDir,
      "--runtime", "kubernetes", "--reproduce", "--repeats", "3", "--hours", "2.5", "--depths", "4,8"],
  );
  assert.deepEqual(resolveEngineArgv(setup, ["check", "--lock", "/rows/t/lock.json"]).argv,
    ["check", "--lock", "/rows/t/lock.json", "--model-dir", SETUP_PINS.modelDir, "--runtime", "kubernetes"]);
  assert.deepEqual(resolveEngineArgv(setup, ["engine", "records"]).argv, ["engine", "records", "--root", ROOT, "--hold"]);
  assert.equal(resolveEngineArgv(setup, ["engine", "submit", "--forward", "-"]).refused, "verb-not-allowed");
  for (const argv of [
    ["lock", "--hand-fix", "anything"],
    ["lock", "--inferencex", "/x"],
    ["lock", "--agentx", "/x"],
    ["lock", "--traces", "/x"],
    ["lock", "--steps"],
    ["lock", "--repeats", "-1"],
    ["lock", "--reproduce", "--reproduce"],
  ]) assert.equal(resolveEngineArgv(setup, argv).refused, "flag-not-allowed", argv.join(" "));
});

test("pinned flags are refused when the sandbox repeats or changes them, in either form", () => {
  const loop = config("loop");
  for (const argv of [
    ["engine", "status", "--root", "/elsewhere"],
    ["engine", "status", "--root=/elsewhere"],
    ["engine", "status", "--root", ROOT, "--root", ROOT],
    ["engine", "status", `--root=${ROOT}`, "--root", ROOT],
    ["engine", "submit", "--engine-id", "e2"],
    ["engine", "submit", "--engine-id=e2"],
    ["engine", "submit", "--engine-id", "e1", "--engine-id=e1"],
  ]) assert.equal(resolveEngineArgv(loop, argv).refused, "pinned-flag", argv.join(" "));
  // The pinned value itself, once, is accepted and run as pinned.
  assert.deepEqual(resolveEngineArgv(loop, ["engine", "status", `--root=${ROOT}`]).argv, ["engine", "status", "--root", ROOT]);
  assert.deepEqual(resolveEngineArgv(loop, ["engine", "submit", "--engine-id", "e1"]).argv,
    ["engine", "submit", "--engine-id", "e1", "--root", ROOT]);

  const setup = config("setup");
  for (const argv of [
    ["lock", "--task", "/rows/other/task.json"],
    ["lock", "--start-root=/rows/other"],
    ["lock", "--model-dir", "/models/other"],
    ["lock", "--runtime", "docker"],
    ["check", "--lock", "/l", "--model-dir=/models/other"],
    ["check", "--lock", "/l", "--runtime", "kubernetes", "--runtime", "kubernetes"],
  ]) assert.equal(resolveEngineArgv(setup, argv).refused, "pinned-flag", argv.join(" "));
});

test("the operator's settings are checked when the bridge is configured", () => {
  assert.throws(() => normalizeEngineBridgeConfig({ profile: "admin", command: ["x"], pins: LOOP_PINS }), /loop or setup/);
  assert.throws(() => normalizeEngineBridgeConfig({ profile: "loop", command: [], pins: LOOP_PINS }), /argv prefix/);
  assert.throws(() => normalizeEngineBridgeConfig({ profile: "loop", command: ["x"], pins: { root: ROOT } }), /engineId/);
  assert.throws(() => normalizeEngineBridgeConfig({ profile: "setup", command: ["x"], pins: LOOP_PINS }), /task/);
  assert.throws(() => normalizeEngineBridgeConfig({ profile: "loop", command: ["x"], pins: LOOP_PINS, shell: true }), /Unknown/);
});

test("a call runs the command prefix with the pinned argv and no shell, and its line follows the contract", async () => {
  const engine = bridge("loop", { env: { ENGINE_SECRET: "controller-only" } });
  const stdin = Buffer.from("def forward(): pass\n");
  const result = await collect(engine, ["engine", "submit", "--tier", "fast", "--forward", "-"], stdin);
  assert.equal(result.exitCode, 0);
  assert.equal(result.refused, null);
  const ran = JSON.parse(result.stdout.toString("utf8"));
  assert.deepEqual(ran.argv, ["engine", "submit", "--engine-id", "e1", "--tier", "fast", "--forward", "-", "--root", ROOT]);
  assert.equal(ran.stdin, stdin.toString("utf8"));
  // The prefix's environment is the operator's; the sandbox sees only output.
  assert.equal(ran.secret, "controller-only");
  assert.equal(result.stderr.toString("utf8"), "fake engine stderr\n");

  const [line] = entries(engine);
  assert.deepEqual(Object.keys(line), [
    "v", "seq", "profile", "verb", "argv", "started_at", "ended_at", "exit_code", "refused",
    "stdin_bytes", "stdin_sha256", "stdout_bytes", "stdout_sha256", "stderr_bytes", "truncated",
  ]);
  assert.deepEqual({ ...line, started_at: null, ended_at: null }, {
    v: 1, seq: 1, profile: "loop", verb: "submit", argv: ran.argv,
    started_at: null, ended_at: null, exit_code: 0, refused: null,
    stdin_bytes: stdin.length, stdin_sha256: createHash("sha256").update(stdin).digest("hex"),
    stdout_bytes: result.stdout.length, stdout_sha256: createHash("sha256").update(result.stdout).digest("hex"),
    stderr_bytes: result.stderr.length, truncated: false,
  });
  assert.match(line.started_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(line.ended_at) >= Date.parse(line.started_at));

  // A shell would expand this; the argv reaches the command as given.
  const check = bridge("setup");
  const quoted = await collect(check, ["check", "--lock", "$(touch /tmp/hurdle-pwned);x"]);
  assert.deepEqual(JSON.parse(quoted.stdout.toString("utf8")).argv.slice(0, 3), ["check", "--lock", "$(touch /tmp/hurdle-pwned);x"]);

  const failing = bridge("loop", { env: { FAKE_ENGINE_EXIT: "3" } });
  assert.equal((await collect(failing, ["engine", "status"])).exitCode, 3);
  assert.equal(entries(failing)[0].exit_code, 3);
});

test("refusals are logged with a null exit code and run nothing", async () => {
  let spawned = 0;
  const engine = bridge("loop", {}, { spawnProcess: () => { spawned += 1; throw new Error("must not run"); } });
  const refused = [
    [["engine", "up"], "verb-not-allowed"],
    [["engine", "submit", "--back-to-back", "2"], "flag-not-allowed"],
    [["engine", "status", "--root=/x"], "pinned-flag"],
  ];
  for (const [argv, code] of refused) {
    const result = await collect(engine, argv);
    assert.deepEqual([result.exitCode, result.refused], [null, code]);
  }
  assert.equal(spawned, 0);
  const lines = entries(engine);
  assert.deepEqual(lines.map(({ seq, verb, refused: code }) => [seq, verb, code]),
    [[1, null, "verb-not-allowed"], [2, "submit", "flag-not-allowed"], [3, "status", "pinned-flag"]]);
  for (const line of lines) {
    assert.equal(line.exit_code, null);
    assert.equal(line.stdout_bytes, 0);
    assert.equal(line.stdout_sha256, EMPTY_SHA);
    assert.equal(line.truncated, false);
  }
});

test("records always runs with --hold and must end its tar stream", async () => {
  const engine = bridge("loop");
  const result = await collect(engine, ["engine", "records"]);
  assert.deepEqual([result.exitCode, result.refused], [0, null]);
  // The archive holds a zero-filled body; the scanner did not stop inside it.
  assert.equal(result.stdout.length, 512 + 2048 + 1024);
  assert.deepEqual(entries(engine)[0].argv, ["engine", "records", "--root", ROOT, "--hold"]);
  assert.equal(entries(engine)[0].stdout_bytes, result.stdout.length);

  const cut = bridge("loop", { env: { FAKE_ENGINE_MODE: "unterminated" } });
  const unterminated = await collect(cut, ["engine", "records"]);
  assert.deepEqual([unterminated.exitCode, unterminated.refused], [null, "unterminated-tar"]);
  assert.equal(entries(cut)[0].refused, "unterminated-tar");
  assert.equal(entries(cut)[0].truncated, false);
});

test("the tar scanner finds the end marker only on a block boundary after the last entry", () => {
  const scanner = createTarEndScanner();
  const header = Buffer.alloc(512);
  header.write("a", 0);
  header.write("00000002000\0", 124);
  assert.equal(scanner.push(header), false);
  assert.equal(scanner.push(Buffer.alloc(1024)), false);
  assert.equal(scanner.push(Buffer.alloc(511)), false);
  assert.equal(scanner.push(Buffer.alloc(513)), true);
});

test("records output past the cap is cut, the process stopped, and the call refused as output-cap", async () => {
  const engine = bridge("loop", { outputMaxBytes: 1000, env: { FAKE_ENGINE_MODE: "big" } });
  const result = await collect(engine, ["engine", "records"]);
  assert.deepEqual([result.exitCode, result.refused], [null, "output-cap"]);
  assert.equal(result.stdout.length, 1000);
  const [line] = entries(engine);
  assert.equal(line.stdout_bytes, 1000);
  assert.equal(line.truncated, true);
  assert.equal(line.stdout_sha256, createHash("sha256").update(Buffer.alloc(1000, 1)).digest("hex"));
});

test("stdin is bounded, one call runs per verb, and status is rate limited", async () => {
  const engine = bridge("loop", { stdinMaxBytes: 8 });
  const big = await engine.call({ argv: ["engine", "submit", "--forward", "-"], stdin: null, stdinBytes: 9 });
  assert.equal(big.refused, "stdin-too-large");
  assert.equal(entries(engine)[0].stdin_bytes, 9);

  const marker = join(await mkdtemp(join(tmpdir(), "hurdle-engine-")), "marker");
  const busy = bridge("loop", { env: { FAKE_ENGINE_MODE: "hang", FAKE_ENGINE_MARKER: marker } });
  const first = busy.call({ argv: ["engine", "submit"], stdin: Buffer.alloc(0) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await busy.call({ argv: ["engine", "submit"], stdin: Buffer.alloc(0) })).refused, "in-flight");
  // Another verb is not held back by a submit in flight.
  assert.equal((await busy.call({ argv: ["engine", "status", "--root", ROOT, "--root", ROOT], stdin: Buffer.alloc(0) })).refused, "pinned-flag");
  await busy.close();
  await first;

  let clock = 0;
  const limited = bridge("loop", { statusMinIntervalMs: 5000 }, { now: () => new Date(clock) });
  assert.equal((await collect(limited, ["engine", "status"])).refused, null);
  clock = 4999;
  assert.equal((await collect(limited, ["engine", "status"])).refused, "rate-limited");
  clock = 5000;
  assert.equal((await collect(limited, ["engine", "status"])).refused, null);
});

test("setup lock --hours must fit the remaining budget", async () => {
  const engine = bridge("setup", { budgetHours: 3 });
  assert.equal((await collect(engine, ["lock", "--measure", "--hours", "2"])).refused, null);
  assert.equal(engine.remainingHours, 1);
  assert.equal((await collect(engine, ["lock", "--measure", "--hours=1.5"])).refused, "budget");
  assert.equal(entries(engine)[1].exit_code, null);
  assert.equal((await collect(engine, ["lock", "--measure", "--hours", "1"])).refused, null);
  assert.equal(engine.remainingHours, 0);
});

test("closing the bridge sends SIGTERM to the call in flight", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), "hurdle-engine-")), "marker");
  const engine = bridge("loop", { env: { FAKE_ENGINE_MODE: "hang", FAKE_ENGINE_MARKER: marker } });
  let call;
  await new Promise((resolve) => {
    call = engine.call({ argv: ["engine", "status"], stdin: Buffer.alloc(0) }, { onStdout: resolve });
  });
  await engine.close();
  assert.equal(await readFile(marker, "utf8"), "SIGTERM");
  assert.deepEqual(await call, { exitCode: 143, refused: null });
  assert.equal(entries(engine)[0].exit_code, 143);
  // A closed bridge runs nothing more.
  assert.equal((await engine.call({ argv: ["engine", "status"], stdin: Buffer.alloc(0) })).exitCode, null);
});

const CA = new X509Certificate(rootCertificates[0]).toString();
const controlToken = randomBytes(32).toString("base64url");

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "hurdle-engine-socket-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskRoot = join(root, "task");
  await mkdir(join(root, "sealed"));
  const server = createSandboxServer({
    controlToken, runTask: async () => ({}), port: 0, flowPort: 0, enginePort: 0,
    caPath: join(taskRoot, "guardian-ca.pem"), writeRoots: [taskRoot], readRoots: [join(root, "sealed")],
  });
  const { port, enginePort } = await server.listen({ host: "127.0.0.1" });
  t.after(() => server.close());
  const provider = createTogetherSocketProvider({ runUrl: () => `ws://127.0.0.1:${port}/`, taskRoot, artifactRoot: join(root, "sealed") });
  const resource = await provider.acquire({ apiKey: controlToken, caCertificate: CA });
  t.after(() => resource.close());
  return { resource, enginePort };
}

function shim(enginePort, argv, input = "", out = []) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const err = [];
  stdout.on("data", (chunk) => out.push(chunk));
  stderr.on("data", (chunk) => err.push(chunk));
  stdin.end(input);
  return connectEngineShim({ argv, stdin, stdout, stderr, port: enginePort })
    .then((code) => ({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
}

test("the shim's call crosses the sandbox socket to the bridge and back", async (t) => {
  const { resource, enginePort } = await sandbox(t);
  const engine = bridge("loop", { env: { FAKE_ENGINE_EXIT: "4" } });
  resource.attachEngine(engine);

  const forward = "def forward(x):\n    return x\n";
  const submitted = await shim(enginePort, ["engine", "submit", "--forward", "-"], forward);
  assert.equal(submitted.code, 4);
  const ran = JSON.parse(submitted.stdout.toString("utf8"));
  assert.deepEqual(ran.argv, ["engine", "submit", "--engine-id", "e1", "--forward", "-", "--root", ROOT]);
  assert.equal(ran.stdin, forward);
  assert.equal(submitted.stderr, "fake engine stderr\n");

  const records = await shim(enginePort, ["engine", "records"]);
  assert.equal(records.code, 0);
  assert.equal(records.stdout.length, 512 + 2048 + 1024);

  const refused = await shim(enginePort, ["engine", "up"]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /refused this call \(verb-not-allowed\)/);

  assert.deepEqual(entries(engine).map(({ verb, refused: code }) => [verb, code]),
    [["submit", null], ["records", null], [null, "verb-not-allowed"]]);
});

test("without a bridge the shim's call is refused, and the socket closing stops a call", async (t) => {
  const { resource, enginePort } = await sandbox(t);
  const unbridged = await shim(enginePort, ["engine", "status"]);
  assert.equal(unbridged.code, 2);
  assert.match(unbridged.stderr, /closed before the call ended|unavailable/);

  const marker = join(await mkdtemp(join(tmpdir(), "hurdle-engine-")), "marker");
  const engine = bridge("loop", { env: { FAKE_ENGINE_MODE: "hang", FAKE_ENGINE_MARKER: marker } });
  resource.attachEngine(engine);
  const out = [];
  const call = shim(enginePort, ["engine", "status"], "", out);
  for (let attempt = 0; attempt < 200 && !out.length; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(Buffer.concat(out).toString("utf8"), "started\n");
  resource.close();
  assert.equal((await call).code, 2);
  for (let attempt = 0; attempt < 200 && !entries(engine).length; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await readFile(marker, "utf8"), "SIGTERM");
  assert.equal(entries(engine)[0].exit_code, 143);
});
