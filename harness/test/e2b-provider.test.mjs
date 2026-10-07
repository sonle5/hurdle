import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createE2BProvider } from "../lib/execution-environments/e2b-provider.mjs";
import { sha256 } from "../lib/run-model.mjs";

test("E2B capture acquisition requires restricted public traffic", async () => {
  const calls = [];
  const result = { sandboxId: "capture-fixture" };
  const provider = createE2BProvider({
    async loadSdk() {
      return {
        Sandbox: {
          async create(template, options) {
            calls.push({ template, options });
            return result;
          },
        },
      };
    },
  });

  assert.equal(await provider.acquire({
    role: "capture",
    template: "base",
    maxLifetimeMs: 180_000,
    apiKey: "fixture-key",
  }), result);
  assert.deepEqual(calls, [{
    template: "base",
    options: {
      apiKey: "fixture-key",
      timeoutMs: 180_000,
      secure: true,
      network: { allowPublicTraffic: false },
      metadata: { "hurdle-role": "capture" },
    },
  }]);
});

test("E2B stages controller files as root and inputs as the isolated agent", async () => {
  const commandUsers = [];
  const commands = [];
  const writeUsers = [];
  const workload = {
    commands: {
      async run(command, options = {}) {
        commands.push(command);
        commandUsers.push(options.user);
        return { exitCode: 0, stdout: "" };
      },
    },
    files: {
      async write(_pathOrEntries, _dataOrOptions, maybeOptions) {
        const options = maybeOptions ?? _dataOrOptions ?? {};
        writeUsers.push(options.user);
      },
    },
  };

  await createE2BProvider().stage(workload, {
    fixtures: [],
    workspaceFiles: [{
      path: "input.txt",
      source: {
        kind: "generated",
        bytes: Buffer.from("hello"),
        sha256: "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
    }],
  });

  assert.ok(commandUsers.every((user) => user === "root"));
  assert.deepEqual(writeUsers, ["root", "tae-agent", "root"]);
  const ownershipSeal = commands.find((command) => (
    command.includes("staged input ownership")
  ));
  assert.ok(ownershipSeal, "expected an explicit staged-input ownership seal");
  assert.match(ownershipSeal, /os\.O_NOFOLLOW/);
  assert.match(ownershipSeal, /dir_fd=parent_fd/);
  assert.match(ownershipSeal, /os\.fchown\(descriptor, identity\.pw_uid, identity\.pw_gid\)/);
  assert.match(ownershipSeal, /os\.fchmod\(descriptor, 0o600\)/);
  assert.doesNotMatch(ownershipSeal, /os\.chown\(path/);
  assert.ok(
    commands.some((command) => command.includes("/tmp/tae-e2b/workspace")),
    "the isolated workspace must live below a traversable parent",
  );
  assert.ok(
    commands.some((command) => (
      command.includes("install -d -o root -g root -m 0711 /tmp/tae-e2b")
      && command.includes("/tmp/tae-e2b/workspace")
    )),
    "the agent-owned workspace must be nested below a root-owned parent",
  );
  assert.ok(
    commands.every((command) => !command.includes("/home/user/tae-workspace")),
    "the isolated principal cannot traverse the template user's private home",
  );
});

test("E2B rechecks a pinned fixture byte limit before sandbox writes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-e2b-fixture-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pinnedPath = join(root, "fixture.bin");
  const bytes = Buffer.from([1, 2]);
  writeFileSync(pinnedPath, bytes);
  let sandboxCalls = 0;
  const workload = {
    commands: { async run() { sandboxCalls += 1; } },
    files: { async write() { sandboxCalls += 1; } },
  };

  await assert.rejects(
    createE2BProvider().stage(workload, {
      fixtures: [{
        source: "fixture.bin",
        workspacePath: "fixture.bin",
        pinnedPath,
        sha256: sha256(bytes),
        maxBytes: 1,
      }],
      workspaceFiles: [],
    }),
    /exceeds its 1-byte limit/,
  );
  assert.equal(sandboxCalls, 0);
});

test("E2B artifact collection cannot follow a workload-supplied sealed path", async () => {
  const declaration = {
    path: "outputs/allowed.txt",
    kind: "text",
    maxBytes: 1024,
    required: true,
  };
  let helperSource = "";
  let helperCommand = "";
  const workload = {
    commands: {
      async run(command, options) {
        helperCommand = command;
        assert.equal(options.user, "root");
        return { exitCode: 0 };
      },
    },
    files: {
      async write(path, data, options) {
        assert.equal(options.user, "root");
        if (path.endsWith("collect-artifacts.py")) helperSource = data;
      },
      async read(path) {
        if (path.endsWith("artifact-manifest.json")) {
          return JSON.stringify([{
            ...declaration,
            status: "captured",
            sealedPath: "/tmp/tae-e2b/workspace/undeclared/private.txt",
            sizeBytes: 6,
            sha256: `sha256:${"0".repeat(64)}`,
            textEncoding: "utf8",
          }]);
        }
        return Buffer.from("secret");
      },
    },
  };

  await assert.rejects(
    createE2BProvider().collectArtifacts(workload, [declaration]),
    /escaped its sealed path/,
  );
  assert.match(helperSource, /os\.seteuid\(identity\.pw_uid\)/);
  assert.match(helperSource, /os\.seteuid\(0\)/);
  assert.match(helperSource, /descriptor = os\.open/);
  assert.match(helperCommand, /artifact helper hash mismatch/);
});

test("E2B artifact collection rejects an absolute declaration before sandbox work", async () => {
  let calls = 0;
  const workload = {
    commands: { async run() { calls += 1; } },
    files: {
      async write() { calls += 1; },
      async read() { calls += 1; },
    },
  };

  await assert.rejects(
    createE2BProvider().collectArtifacts(workload, [{
      path: "/etc/passwd",
      kind: "text",
      maxBytes: 1024,
      required: true,
    }]),
    /must stay inside the workspace/,
  );
  assert.equal(calls, 0);
});

test("E2B process facts fail closed when a baseline PID is reused", async () => {
  let runnerSource = "";
  const workload = {
    files: {
      async write(path, data, options) {
        if (path.endsWith("/run.mjs")) {
          runnerSource = data;
          assert.equal(options.user, "root");
        }
      },
    },
    commands: {
      async run(command, options = {}) {
        if (command.startsWith("id -u")) {
          assert.equal(options.user, "root");
          return { exitCode: 0, stdout: "1001\n1001\n" };
        }
        if (command.includes("TAE_PROCESS_CENSUS_SNAPSHOT")) {
          assert.equal(options.user, "root");
          return {
            exitCode: 0,
            stdout: 'TAE_PROCESS_CENSUS_SNAPSHOT=[[2,"100"],[10,"200"]]\n',
          };
        }
        if (command.includes("TAE_PROCESS_CENSUS_CLEANUP")) {
          assert.equal(options.user, "root");
          assert.match(command, /baseline\.get\(pid\) != started/);
          return {
            exitCode: 0,
            stdout: 'TAE_PROCESS_CENSUS_CLEANUP={"remaining":[10]}\n',
          };
        }
        if (command.includes("/run.mjs")) {
          assert.equal(options.user, "root");
          return { exitCode: 0 };
        }
        return { exitCode: 0 };
      },
    },
  };

  const facts = await createE2BProvider().run(workload, {
    launchPlan: {
      command: "agent",
      args: [],
      env: {},
      stdin: "",
      timeoutMs: 1_000,
    },
    environment: {},
    onStdout() {},
    onStderr() {},
  });

  assert.equal(facts.quiescent, false);
  assert.equal(facts.spawnError, null);
  assert.match(runnerSource, /--no-new-privs/);
  assert.match(runnerSource, /--clear-groups/);
  assert.match(runnerSource, /PATH: plan\.env\.PATH \?\? process\.env\.PATH/);
  assert.match(runnerSource, /SHELL: plan\.env\.SHELL \?\? process\.env\.SHELL/);
});

test("E2B mounts a fixed Agent workspace layout without moving controller custody", async () => {
  const commands = [];
  let launch = null;
  const workload = {
    files: {
      async write(path, data, options) {
        assert.equal(options.user, "root");
        if (path.endsWith("/launch.json")) launch = JSON.parse(data);
      },
    },
    commands: {
      async run(command, options = {}) {
        commands.push(command);
        assert.equal(options.user, "root");
        if (command.startsWith("id -u")) {
          return { exitCode: 0, stdout: "1001\n1001\n" };
        }
        if (command.includes("TAE_PROCESS_CENSUS_SNAPSHOT")) {
          return { exitCode: 0, stdout: "TAE_PROCESS_CENSUS_SNAPSHOT=[]\n" };
        }
        if (command.includes("TAE_PROCESS_CENSUS_CLEANUP")) {
          return {
            exitCode: 0,
            stdout: 'TAE_PROCESS_CENSUS_CLEANUP={"remaining":[]}\n',
          };
        }
        return { exitCode: 0 };
      },
    },
  };

  const facts = await createE2BProvider().run(workload, {
    launchPlan: {
      command: "claude",
      args: [],
      env: { CLI_VERSION: "2.31.0" },
      stdin: "prompt",
      timeoutMs: 1_000,
      workspaceLayout: {
        schemaVersion: 1,
        workingDirectory: "/home/user/workspace",
        homeDirectory: "/home/user",
        temporaryDirectory: "/tmp",
      },
    },
    environment: { CLI_VERSION: "2.31.0" },
    onStdout() {},
    onStderr() {},
  });

  assert.equal(facts.exitCode, 0);
  const mount = commands.find((command) => command.includes("mount --bind"));
  assert.ok(mount, "expected a controller-owned bind mount");
  assert.match(mount, /mount --bind \/tmp\/tae-e2b\/workspace \/home\/user\/workspace/);
  assert.match(mount, /mount --make-private \/home\/user\/workspace/);
  assert.match(mount, /parent directory is writable by the Agent/);
  assert.equal(launch.cwd, "/home/user/workspace");
  assert.equal(launch.env.HOME, "/home/user");
  assert.equal(launch.env.TMPDIR, "/tmp");
  assert.equal(launch.env.PWD, "/home/user/workspace");
  assert.match(launch.env.PATH, /^\/home\/user\/\.local\/bin:/);
  assert.equal(launch.env.CLI_VERSION, "2.31.0");
});
