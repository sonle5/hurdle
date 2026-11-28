import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFrameworkCli } from "../bin/hurdle.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import {
  IMAGE_CONTEXT_FILES,
  TOGETHER_SERVER_COMMAND,
  togetherImageDockerfile,
  togetherSandboxDockerfile,
  writeTogetherImageContext,
} from "../lib/together-sandbox-setup.mjs";
import { SETUP_AGENT_INTEGRITY, SETUP_AGENT_PACKAGES } from "../lib/managed-images.mjs";

async function fixture(t, example = "copy-message") {
  const root = await mkdtemp(join(tmpdir(), "hurdle-together-setup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(
    (await initializeSuite({ destination: join(root, "evals"), example })).ok,
    true,
  );
  let text = "";
  const io = {
    cwd: root,
    stdout: {
      write: (value) => {
        text += value;
      },
    },
    stderr: {
      write: (value) => {
        text += value;
      },
    },
  };
  const dependencies = {
    env: {
      TOGETHER_API_KEY: "test-sandbox-secret",
      ANTHROPIC_API_KEY: "test-agent-secret",
    },
    processTarget: new EventEmitter(),
    checkAgentReadiness: async () => ({ ok: true, checks: [] }),
    ensureHostGuardianRuntime: async () => ({}),
  };
  return {
    root,
    io,
    dependencies,
    output: () => text,
    runtimePath: join(root, ".hurdle/runtime/default.json"),
  };
}
test("setup --sandbox together selects Together's Hurdle image without a build, and validate discovers its private Runtime", async (t) => {
  const f = await fixture(t);
  const cli = createFrameworkCli(f.dependencies);
  assert.equal(
    await cli.main(["setup", "--sandbox", "together", "--yes", "--json"], f.io),
    0,
    f.output(),
  );
  const report = JSON.parse(f.output());
  assert.equal(report.executionEnvironment, "together");
  assert.equal(report.target, "together");
  assert.ok(report.checks.some(check => check.status === "pass" && check.message === "Setup complete · Together sandbox configured."));
  assert.ok(report.checks.some(check => check.message === "Together's Hurdle image selected; nothing to build."));
  const config = JSON.parse(await readFile(f.runtimePath, "utf8"));
  assert.equal(config.environment.settings.snapshotAlias, undefined);
  assert.equal(config.environment.settings.maxLifetimeMs, 300000);
  assert.equal(config.resultStore.root, "../together-results-v1");
  assert.equal(config.judge, undefined);
  assert.equal(existsSync(join(f.root, ".env.local")), false);
  assert.doesNotMatch(f.output(), /test-sandbox-secret|test-agent-secret/);
  assert.equal(await cli.main(["validate"], f.io), 0, f.output());
});
test("Together setup preserves an existing store, Judge and limits", async (t) => {
  const f = await fixture(t);
  const config = {
    schemaVersion: 1,
    environment: {
      kind: "together",
      apiKeyEnv: "TOGETHER_API_KEY",
      settings: {
        maxLifetimeMs: 120000,
      },
    },
    resultStore: { kind: "local", root: "../../saved" },
    viewer: { port: 3022 },
  };
  await mkdir(join(f.root, ".hurdle/runtime"), { recursive: true });
  await writeFile(f.runtimePath, JSON.stringify(config));
  const cli = createFrameworkCli(f.dependencies);
  assert.equal(
    await cli.main(["setup", "--sandbox", "together"], f.io),
    0,
    f.output(),
  );
  const saved = JSON.parse(await readFile(f.runtimePath, "utf8"));
  assert.deepEqual(saved.resultStore, config.resultStore);
  assert.equal(saved.environment.settings.maxLifetimeMs, 120000);
  assert.equal(saved.viewer.port, 3022);
  assert.match(f.output(), /✓ Setup complete · Together sandbox configured\./);
});
test("Together setup leaves a Kubernetes Runtime unchanged", async (t) => {
  const f = await fixture(t);
  const config = {
    schemaVersion: 1,
    environment: {
      kind: "kubernetes",
      tokenEnv: "HURDLE_KUBERNETES_TOKEN",
      settings: {
        apiServer: "https://127.0.0.1:16443",
        namespace: "hurdle",
        image: `registry.test/hurdle-sandbox@sha256:${"a".repeat(64)}`,
        nodeSelector: { workload: "app" },
      },
    },
    resultStore: { kind: "local", root: "../../saved" },
  };
  await mkdir(join(f.root, ".hurdle/runtime"), { recursive: true });
  const text = JSON.stringify(config);
  await writeFile(f.runtimePath, text);
  const cli = createFrameworkCli(f.dependencies);
  assert.equal(await cli.main(["setup", "--sandbox", "together"], f.io), 1, f.output());
  assert.match(f.output(), /already selects the Kubernetes sandbox/);
  assert.equal(await readFile(f.runtimePath, "utf8"), text);
});
test("Together API setup configures a longer Guardian lifetime", async (t) => {
  const f = await fixture(t, "together-api");
  const cli = createFrameworkCli(f.dependencies);
  assert.equal(
    await cli.main(["setup", "--sandbox", "together", "--yes"], f.io),
    0,
    f.output(),
  );
  const config = JSON.parse(await readFile(f.runtimePath, "utf8"));
  assert.equal(config.environment.settings.maxLifetimeMs, 600000);
  assert.match(f.output(), /All sandbox traffic routes through this machine/);
});
test("Together setup gives a later API Suite ten minutes but keeps a configured limit", async (t) => {
  const f = await fixture(t);
  const cli = createFrameworkCli(f.dependencies);
  const lifetime = async () =>
    JSON.parse(await readFile(f.runtimePath, "utf8")).environment.settings.maxLifetimeMs;
  assert.equal(await cli.main(["setup", "--sandbox", "together", "--yes"], f.io), 0, f.output());
  assert.equal(await lifetime(), 300000);

  assert.equal((await initializeSuite({ destination: join(f.root, "api"), example: "together-api" })).ok, true);
  const api = ["setup", "api/example.suite.mjs", "--sandbox", "together", "--yes"];
  assert.equal(await cli.main(api, f.io), 0, f.output());
  assert.equal(await lifetime(), 600000);

  const runtime = JSON.parse(await readFile(f.runtimePath, "utf8"));
  runtime.environment.settings.maxLifetimeMs = 420000;
  await writeFile(f.runtimePath, JSON.stringify(runtime));
  assert.equal(await cli.main(api, f.io), 0, f.output());
  assert.equal(await lifetime(), 420000);
});

test("Together setup refuses a dsh Suite before writing anything", async (t) => {
  const f = await fixture(t);
  const suite = join(f.root, "evals/example.suite.mjs");
  const text = await readFile(suite, "utf8");
  await writeFile(suite, text.replace(/agents: \[[^\]]*\]/, 'agents: [{ runner: "dsh", model: "deepseek-flash" }]'));
  const cli = createFrameworkCli(f.dependencies);
  assert.equal(await cli.main(["setup", "--sandbox", "together", "--yes", "--json"], f.io), 1, f.output());
  const report = JSON.parse(f.output());
  assert.equal(report.error.code, "setup.agent");
  assert.match(report.error.message, /not in the Together sandbox image yet/);
  assert.equal(existsSync(f.runtimePath), false);
});

test("Together Dockerfile includes pinned agents and Linux controller dependencies", () => {
  const text = togetherSandboxDockerfile([
    "claude-code",
    "codex",
    "claude-code",
  ]);
  assert.match(text, /FROM node:24-bookworm/);
  assert.match(text, /util-linux passwd/);
  assert.match(text, /passwd iptables/);
  assert.match(text, /@anthropic-ai\/claude-code@2\.1\.288/);
  assert.match(text, /@openai\/codex@0\.159\.3/);
  assert.throws(() => togetherSandboxDockerfile(["unknown-agent"]));
});

test("the managed image pins dsh by exact version and verifies every Agent tarball's integrity", () => {
  assert.equal(SETUP_AGENT_PACKAGES.dsh, "@deepseek-ai/dsh@0.2.2-rc.3");
  assert.deepEqual(Object.keys(SETUP_AGENT_INTEGRITY).sort(), Object.keys(SETUP_AGENT_PACKAGES).sort());
  for (const [id, spec] of Object.entries(SETUP_AGENT_PACKAGES)) {
    assert.match(spec, /^@[a-z0-9-]+\/[a-z0-9-]+@\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, `${id} is an exact pin`);
    assert.match(SETUP_AGENT_INTEGRITY[id], /^sha512-[A-Za-z0-9+/]{86}==$/, `${id} has a sha512 integrity`);
  }
  const text = togetherSandboxDockerfile(["dsh", "codex", "claude-code"]);
  const install = text.split("\n").find(line => line.includes("npm pack"));
  assert.match(install, /npm pack --silent @anthropic-ai\/claude-code@2\.1\.288 @openai\/codex@0\.159\.3 @deepseek-ai\/dsh@0\.2\.2-rc\.3 /);
  assert.match(install, /'4bee2851854a5ae7[0-9a-f]{112}  deepseek-ai-dsh-0\.2\.2-rc\.3\.tgz'/);
  assert.match(install, /\| sha512sum --check --strict - && npm install --global \.\/anthropic-ai-claude-code-2\.1\.288\.tgz \.\/openai-codex-0\.159\.3\.tgz \.\/deepseek-ai-dsh-0\.2\.2-rc\.3\.tgz /);
  // The install verifies before it installs and never installs from the registry by name.
  assert.ok(install.indexOf("sha512sum") < install.indexOf("npm install"));
  assert.doesNotMatch(install.slice(install.indexOf("npm install")), /@deepseek-ai\/dsh@/);
});

test("the Together image context bakes in the sandbox server and everything it loads", async (t) => {
  const context = await mkdtemp(join(tmpdir(), "hurdle-image-context-test-"));
  t.after(() => rm(context, { recursive: true, force: true }));
  await writeTogetherImageContext(context, ["claude-code", "codex"]);

  const dockerfile = await readFile(join(context, "Dockerfile"), "utf8");
  assert.equal(dockerfile, togetherImageDockerfile(["claude-code", "codex"]));
  assert.ok(dockerfile.startsWith(togetherSandboxDockerfile(["claude-code", "codex"]).trimEnd()));
  assert.match(dockerfile, /\nCOPY hurdle\/ \/opt\/hurdle\/\nRUN cd \/opt\/hurdle && npm ci /);

  const harness = join(import.meta.dirname, "..");
  for (const file of IMAGE_CONTEXT_FILES)
    assert.equal(
      await readFile(join(context, "hurdle", "harness", file), "utf8"),
      await readFile(join(harness, file), "utf8"),
    );
  const runtime = JSON.parse(await readFile(join(context, "hurdle", "package.json"), "utf8"));
  assert.ok(runtime.dependencies.ws);
  // Loading the baked modules from the context proves every relative import
  // and every asset they read at load time was copied.
  for (const module of ["sandbox-server", "sandbox-task", "together-workload-egress"])
    await import(join(context, "hurdle", "harness", "lib", "execution-environments", `${module}.mjs`));
  assert.equal(
    TOGETHER_SERVER_COMMAND,
    "node /opt/hurdle/harness/bin/hurdle-sandbox-server.mjs",
  );
});
