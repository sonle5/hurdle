import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { launchViewer } from "../launcher.mjs";

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

test("Viewer launcher starts the source Viewer on loopback with only canonical local Store selection", async () => {
  const child = childProcess();
  let invocation = null;
  const ready = [];
  const completed = launchViewer({
    cwd: "/workspace/eval-framework",
    port: 3100,
    env: {
      DATABASE_URL: "legacy-database-secret",
      HURDLE_RESULT_STORE_MODE: "postgres",
      HURDLE_RESULT_STORE_ROOT: "/unrelated/writer-store",
      HURDLE_RESULT_STORE_DATABASE_URL: "unrelated-database-secret",
      HURDLE_RESULT_STORE_SIDECAR: "/unrelated/sidecar",
      ANTHROPIC_API_KEY: "must-not-reach-viewer",
      OPENAI_API_KEY: "must-not-reach-viewer",
      TOGETHER_API_KEY: "must-not-reach-viewer",
      HOME: "/Users/operator",
      HURDLE_VIEWER_ONBOARDING: "unrelated-context-must-not-reach-viewer",
      PATH: "/bin",
    },
    storeEnvironment: {
      HURDLE_RESULT_STORE_MODE: "local",
      HURDLE_RESULT_STORE_ROOT: "/canonical/results-v1",
    },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
    onReady(url) {
      ready.push(url);
    },
  });

  assert.deepEqual(invocation, {
    command: "npm",
    args: ["--prefix", "viewer", "run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3100"],
    options: {
      cwd: "/workspace/eval-framework",
      detached: process.platform !== "win32",
      env: {
        PATH: "/bin",
        HURDLE_VIEWER_READ_ONLY: "1",
        HURDLE_RESULT_STORE_MODE: "local",
        HURDLE_RESULT_STORE_ROOT: "/canonical/results-v1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });

  child.stdout.emit("data", Buffer.from(" ▲ Next.js\n ✓ Ready in 123ms\n"));
  child.emit("close", 0, null);

  assert.deepEqual(ready, ["http://127.0.0.1:3100"]);
  assert.deepEqual(await completed, {
    kind: "stopped",
    exitCode: 0,
    url: "http://127.0.0.1:3100",
  });
});

test("Viewer forwards only explicit display context while filtering provider secrets", async () => {
  const child = childProcess();
  let environment;
  const onboarding = { projectDirectory: "/project", commands: "hurdle validate\nhurdle run", setupCommand: "hurdle setup", runtimeLabel: "E2B sandbox" };
  const completed = launchViewer({
    cwd: "/workspace/source", onboarding,
    env: { E2B_API_KEY: "secret", TOGETHER_API_KEY: "secret", HURDLE_VIEWER_ONBOARDING: "inherited-context" },
    storeEnvironment: { HURDLE_RESULT_STORE_MODE: "local", HURDLE_RESULT_STORE_ROOT: "/results" },
    spawn(command, args, options) { environment = options.env; return child; },
  });
  assert.deepEqual(JSON.parse(environment.HURDLE_VIEWER_ONBOARDING), onboarding);
  assert.equal(environment.E2B_API_KEY, undefined);
  assert.equal(environment.TOGETHER_API_KEY, undefined);
  child.emit("close", 0, null);
  await completed;
});

test("Viewer launcher starts the packaged Viewer without npm or source dependencies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-packaged-viewer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "viewer-runtime");
  const server = join(runtimeRoot, "server.js");
  mkdirSync(join(runtimeRoot, "runtime_modules"), { recursive: true });
  writeFileSync(server, "// packaged Viewer fixture\n");
  const child = childProcess();
  let invocation = null;
  const completed = launchViewer({
    cwd: root,
    port: 3101,
    env: { PATH: "/bin", NODE_PATH: "/must-not-leak" },
    storeEnvironment: {
      HURDLE_RESULT_STORE_MODE: "local",
      HURDLE_RESULT_STORE_ROOT: "/canonical/results-v1",
    },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  });

  assert.deepEqual(invocation, {
    command: process.execPath,
    args: [server],
    options: {
      cwd: runtimeRoot,
      detached: process.platform !== "win32",
      env: {
        PATH: "/bin",
        HURDLE_VIEWER_READ_ONLY: "1",
        HURDLE_RESULT_STORE_MODE: "local",
        HURDLE_RESULT_STORE_ROOT: "/canonical/results-v1",
        HOSTNAME: "127.0.0.1",
        NODE_PATH: join(runtimeRoot, "runtime_modules"),
        PORT: "3101",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });

  child.stdout.emit("data", Buffer.from("Ready in 1ms\n"));
  child.emit("close", 0, null);
  assert.equal((await completed).kind, "stopped");
});

test("Viewer launcher terminates a Viewer that never becomes ready", async () => {
  const child = childProcess();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  const completed = launchViewer({
    cwd: "/workspace/eval-framework",
    storeEnvironment: {
      HURDLE_RESULT_STORE_MODE: "local",
      HURDLE_RESULT_STORE_ROOT: "/canonical/results-v1",
    },
    spawn: () => child,
    readinessTimeoutMs: 1,
  });

  assert.deepEqual(await completed, { kind: "failed", exitCode: 1 });
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("Viewer launcher classifies an occupied port without returning raw process output", async () => {
  const child = childProcess();
  const completed = launchViewer({
    cwd: "/workspace/eval-framework",
    storeEnvironment: {
      HURDLE_RESULT_STORE_MODE: "local",
      HURDLE_RESULT_STORE_ROOT: "/canonical/results-v1",
    },
    spawn: () => child,
  });

  child.stderr.emit("data", Buffer.from(
    "Error: listen EADDRINUSE: address already in use 127.0.0.1:3000\nsecret-output\n",
  ));
  child.emit("close", 1, null);

  assert.deepEqual(await completed, {
    kind: "failed",
    exitCode: 1,
    reason: "port-in-use",
  });
});

test("Viewer launcher clears the startup deadline once the server is ready", async () => {
  const child = childProcess();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const completed = launchViewer({
    cwd: "/workspace/eval-framework",
    storeEnvironment: {
      HURDLE_RESULT_STORE_MODE: "local",
      HURDLE_RESULT_STORE_ROOT: "/canonical/results-v1",
    },
    spawn: () => child,
    readinessTimeoutMs: 1,
  });

  child.stdout.emit("data", Buffer.from("Ready in 1ms\n"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(signals, []);
  child.emit("close", 0, null);
  assert.equal((await completed).kind, "stopped");
});

test("Viewer launcher continuously drains output without retaining post-ready logs", async () => {
  const child = childProcess();
  child.stdout = new PassThrough({ highWaterMark: 1_024 });
  child.stderr = new PassThrough({ highWaterMark: 1_024 });
  const completed = launchViewer({
    cwd: "/workspace/eval-framework",
    storeEnvironment: {
      HURDLE_RESULT_STORE_MODE: "local",
      HURDLE_RESULT_STORE_ROOT: "/canonical/results-v1",
    },
    spawn: () => child,
  });

  child.stdout.write("Ready in 1ms\n");
  for (let index = 0; index < 20_000; index += 1) {
    assert.equal(child.stderr.write(Buffer.alloc(512, 0x65)), true);
    assert.equal(child.stdout.write(Buffer.alloc(512, 0x6f)), true);
  }
  child.emit("close", 0, null);

  assert.equal((await completed).kind, "stopped");
});

test("Viewer launcher maps controller termination to a typed foreground interruption", async () => {
  const child = childProcess();
  const processTarget = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const completed = launchViewer({
    cwd: "/workspace/eval-framework",
    storeEnvironment: {
      HURDLE_RESULT_STORE_MODE: "postgres",
      HURDLE_RESULT_STORE_DATABASE_URL: "postgresql://canonical-reader",
    },
    spawn: () => child,
    processTarget,
  });

  processTarget.emit("SIGTERM");
  child.emit("close", 0, null);

  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(await completed, {
    kind: "interrupted",
    signal: "SIGTERM",
    exitCode: 143,
  });
  assert.equal(processTarget.listenerCount("SIGINT"), 0);
  assert.equal(processTarget.listenerCount("SIGTERM"), 0);
});

test("Viewer launcher rejects a Store selection that carries a writer-side sidecar", () => {
  assert.throws(
    () => launchViewer({
      cwd: "/workspace/eval-framework",
      storeEnvironment: {
        HURDLE_RESULT_STORE_MODE: "local",
        HURDLE_RESULT_STORE_ROOT: "/canonical/results-v1",
        HURDLE_RESULT_STORE_SIDECAR: "/canonical/sidecar",
      },
      spawn: () => childProcess(),
    }),
    /Viewer Store selection is invalid/,
  );
});

test("Viewer startup timeout escalates when the process ignores SIGTERM", { timeout: 500 }, async () => {
  const child = childProcess();
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  const outcome = await launchViewer({
    cwd: "/workspace/eval-framework",
    storeEnvironment: { HURDLE_RESULT_STORE_MODE: "local", HURDLE_RESULT_STORE_ROOT: "/results" },
    spawn: () => child, readinessTimeoutMs: 1, shutdownGraceMs: 5, shutdownTimeoutMs: 30,
  });
  assert.equal(outcome.kind, "failed");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("Viewer interruption is bounded even when no close event arrives", { timeout: 500 }, async () => {
  const child = childProcess();
  const processTarget = new EventEmitter();
  const completed = launchViewer({
    cwd: "/workspace/eval-framework",
    storeEnvironment: { HURDLE_RESULT_STORE_MODE: "local", HURDLE_RESULT_STORE_ROOT: "/results" },
    spawn: () => child, processTarget, shutdownGraceMs: 5, shutdownTimeoutMs: 30,
  });
  processTarget.emit("SIGINT");
  const outcome = await completed;
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.reason, "disposal-unconfirmed");
  assert.equal(processTarget.listenerCount("SIGINT"), 0);
  assert.equal(processTarget.listenerCount("SIGTERM"), 0);
});

for (const wrapperExits of [false, true]) {
  test(`Viewer disposes a real TERM-resistant descendant when ${wrapperExits ? "its wrapper exits" : "interrupted"}`, {
    skip: process.platform === "win32", timeout: 10_000,
  }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "hurdle-viewer-process-tree-"));
    const heartbeat = join(root, "heartbeat");
    const controller = new EventEmitter();
    let child;
    t.after(() => {
      if (child?.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      rmSync(root, { recursive: true, force: true });
    });
    const descendantSource = `
      const { writeFileSync } = require("node:fs");
      process.on("SIGTERM", () => {});
      process.on("SIGINT", () => {});
      let count = 0;
      const tick = () => writeFileSync(${JSON.stringify(heartbeat)}, String(++count));
      tick();
      setInterval(tick, 20);
      process.send("ready");
    `;
    const wrapperSource = `
      process.on("SIGTERM", () => {});
      process.on("SIGINT", () => {});
      const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      child.once("message", () => {
        process.stdout.write("Ready in 1ms\\n");
        if (${wrapperExits}) process.exit(0);
      });
    `;
    const outcome = await launchViewer({
      cwd: root,
      storeEnvironment: { HURDLE_RESULT_STORE_MODE: "local", HURDLE_RESULT_STORE_ROOT: join(root, "results") },
      processTarget: controller, readinessTimeoutMs: 3000, shutdownGraceMs: 50, shutdownTimeoutMs: 1500,
      spawn(_command, _args, options) {
        child = nodeSpawn(process.execPath, ["-e", wrapperSource], options);
        return child;
      },
      onReady() { if (!wrapperExits) controller.emit("SIGINT"); },
    });
    // Some CI init processes retain killed orphans as zombies: remain fail-closed
    // if group disappearance cannot be confirmed, but never leave a live writer.
    assert.ok(outcome.kind === (wrapperExits ? "stopped" : "interrupted")
      || (outcome.kind === "failed" && outcome.reason === "disposal-unconfirmed"), JSON.stringify(outcome));
    await new Promise(resolve => setTimeout(resolve, 100));
    const finalHeartbeat = readFileSync(heartbeat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(readFileSync(heartbeat, "utf8"), finalHeartbeat, "owned descendant must stop");
    assert.equal(controller.listenerCount("SIGINT"), 0);
    assert.equal(controller.listenerCount("SIGTERM"), 0);
  });
}
