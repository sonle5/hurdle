import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createRuntimeConfig } from "./runtime-init.mjs";
import { resolveRuntimeProfile, describeRuntimeJudgeCapability } from "./runtime-profile.mjs";
import { resolveAuthoritySelections } from "./authority-profile.mjs";
import { createTerminalProgress } from "./terminal-progress.mjs";
import { promptSetup } from "./setup-prompts.mjs";
import { normalizeE2BSettings } from "./execution-environments/e2b.mjs";
import { DEFAULT_PROJECT_RUNTIME, projectRuntimePath } from "./project-paths.mjs";

export { DEFAULT_PROJECT_RUNTIME, projectRuntimePath } from "./project-paths.mjs";
export const SETUP_AGENT_PACKAGES = Object.freeze({
  "claude-code": "@anthropic-ai/claude-code@2.1.288",
  codex: "@openai/codex@0.141.0",
});
function setupError(code, message) { return Object.assign(new Error(message), { code }); }
const nonblank = value => typeof value === "string" && value.trim().length > 0;

export function createSetupTemplate(Template, agents) {
  const packages = [...new Set(agents)].sort().map(id => {
    if (!SETUP_AGENT_PACKAGES[id]) throw setupError("setup.agent", "This Suite selects an unsupported Agent.");
    return SETUP_AGENT_PACKAGES[id];
  });
  return Template().fromImage("node:22-bookworm")
    .runCmd("apt-get update && apt-get install -y python3 iproute2 curl jq git ca-certificates && rm -rf /var/lib/apt/lists/*", { user: "root" })
    .runCmd(`npm install --global ${packages.join(" ")}`, { user: "root" })
    .runCmd(["node --version", "/usr/bin/python3 --version", ...[...new Set(agents)].map(id => id === "codex" ? "codex --version" : "claude --version")].join(" && "), { user: "root" });
}

export async function inspectSetupTemplate(client, name) {
  const [base, requestedTag] = name.split(":");
  const get = (route, path) => client.api.GET(route, { params: { path }, signal: AbortSignal.timeout(20_000) });
  const alias = await get("/templates/aliases/{alias}", { alias: base });
  // The SDK's exists() treats 403 as existence, which does not prove that this
  // account can use the template. Require successful reads instead.
  if (![200, 404].includes(alias.response.status)) throw setupError("setup.template-access", "E2B denied access to the template. Check the selected name and account permissions.");
  const templateID = alias.data?.templateID ?? base;
  const details = await get("/templates/{templateID}", { templateID });
  if (details.response.status === 404) return false;
  if (details.response.status !== 200) throw setupError("setup.template-access", "E2B template details could not be read.");
  const tags = await get("/templates/{templateID}/tags", { templateID });
  if (tags.response.status !== 200 || !Array.isArray(tags.data)) throw setupError("setup.template-access", "E2B template tags could not be read.");
  const tagged = tags.data.find(item => item.tag === (requestedTag ?? "latest"));
  const builds = details.data?.builds ?? [];
  if (requestedTag && !tagged) return false;
  const selected = tagged ? builds.find(build => build.buildID === tagged.buildID)
    : [...builds].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (tagged && !selected) throw setupError("setup.template-details", "The tagged build's details were not returned by E2B. Check the template in your E2B dashboard; setup will not rebuild an existing tag.");
  if (!selected || selected.status === "error") return false;
  if (selected.status !== "ready") throw setupError("setup.template-building", "The E2B template is still building. Wait for it to finish, then rerun setup.");
  if (![selected.cpuCount, selected.memoryMB].every(value => Number.isSafeInteger(value) && value > 0)) throw setupError("setup.template-capacity", "E2B returned an unsupported template capacity.");
  return { cpuCount: selected.cpuCount, memoryMB: selected.memoryMB };
}

export async function loadSetupBackend() {
  const { Template, ApiClient, ConnectionConfig } = await import("e2b");
  return {
    exists: (name, apiKey) => inspectSetupTemplate(new ApiClient(new ConnectionConfig({ apiKey, requestTimeoutMs: 20_000 })), name),
    build: (name, agents, apiKey, capacity) => Template.build(createSetupTemplate(Template, agents), name, { apiKey, ...capacity }),
  };
}

async function regularFileContents(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw setupError("setup.file", "Setup needs regular .env.local, .gitignore, and Runtime files; symbolic links are not supported.");
    return await readFile(path, "utf8");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function atomicWrite(path, text, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode, flag: "wx" });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

async function saveCredentials(cwd, values) {
  const ignore = join(cwd, ".gitignore");
  const ignored = await regularFileContents(ignore) ?? "";
  // Append last so an earlier negation cannot accidentally expose credentials.
  const protectedPaths = "/.env.local\n/.hurdle/\n/.tae/";
  if (ignored.trimEnd().split("\n").slice(-3).join("\n") !== protectedPaths) {
    await atomicWrite(ignore, `${ignored}${ignored.endsWith("\n") || !ignored ? "" : "\n"}${protectedPaths}\n`, 0o644);
  }
  if (!Object.keys(values).length) return;
  const path = join(cwd, ".env.local");
  const existing = await regularFileContents(path) ?? "";
  const lines = Object.entries(values).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !/^[\x21-\x7e]+$/.test(value)) throw setupError("setup.credential", "Enter a nonblank credential without spaces or line breaks.");
    return `${name}=${JSON.stringify(value)}`;
  });
  // Preserve comments and existing credentials; the env parser uses the last
  // assignment when replacing an empty value entered during earlier setup.
  await atomicWrite(path, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${lines.join("\n")}\n`, 0o600);
}

export async function setupSandbox({ suite, template, yes = false }, io, dependencies) {
  const color = Boolean(io.stdout.isTTY) && !process.env.NO_COLOR;
  const paint = (text, code) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const line = (status, text) => io.stdout.write(`${paint({ pass: "✓", fail: "✗", warning: "!" }[status], { pass: 32, fail: 31, warning: 33 }[status])} ${text}\n`);
  const prompt = dependencies.promptSetup ?? promptSetup;
  io.stdout.write(`\n${paint("Hurdle", 1)}\n\n  Sandbox   E2B\n\n`);
  let authored;
  try {
    if (!existsSync(resolve(io.cwd, suite))) throw setupError("setup.suite-missing", "Create an evaluation first: npx hurdle init (or npx hurdle init --example together-api).");
    authored = await dependencies.resolveV1Suite({ suitePath: resolve(io.cwd, suite) });
    if (!authored.ok) throw setupError("setup.suite-invalid", "The Suite is invalid. Run npx hurdle validate --offline to inspect its diagnostics.");
    dependencies.assertRuntimeDependencies({ environment: { kind: "e2b" } });
    const ids = [...new Set(authored.defaults.agentSelections.map(agent => agent.adapterId))].sort();
    const selectedTasks = authored.defaults.taskIds;
    const taskCredentials = [...new Set(selectedTasks.flatMap(id => authored.value.definition.tasks[id].credentialRequirements))];
    const runtimePath = projectRuntimePath(io.cwd) ?? DEFAULT_PROJECT_RUNTIME;
    const runtimeFile = resolve(io.cwd, runtimePath);
    const previous = await regularFileContents(runtimeFile);
    if (previous !== null) resolveRuntimeProfile({ cwd: io.cwd, runtimePath });
    const old = previous === null ? null : JSON.parse(previous);
    const name = template ?? (old?.environment.kind === "e2b" ? old.environment.settings?.workloadTemplate : null)
      ?? `hurdle-${ids.join("-")}:v1`;
    const config = old ?? structuredClone(createRuntimeConfig("e2b", { template: name }));
    if (!old) {
      delete config.judge;
      config.environment.settings.maxLifetimeMs = 300_000;
      const judges = [...new Set(authored.value.definition.authorityProfiles.filter(p => p.judge.availability === "required").map(p => p.judge.capability.model))];
      if (judges.length === 1) config.judge = { kind: "anthropic-json-v1", model: judges[0], credentialEnv: "ANTHROPIC_API_KEY" };
    } else if (old.environment.kind !== "e2b") {
      config.environment = structuredClone(createRuntimeConfig("e2b", { template: name })).environment;
      config.environment.settings.maxLifetimeMs = 300_000;
    }
    config.environment.settings ??= {};
    config.environment.settings.workloadTemplate = name;
    const profile = resolveRuntimeProfile({ runtimePath, cwd: io.cwd }, { readFile: () => JSON.stringify(config) });
    let settings;
    try { settings = normalizeE2BSettings(config.environment.settings); }
    catch { throw setupError("setup.runtime-settings", `E2B Runtime settings are invalid. Check the templates, cpuCount, memoryMiB, and maxLifetimeMs in ${runtimePath} before rerunning setup.`); }
    const authority = resolveAuthoritySelections({ definition: authored.value.definition, selectedTaskIds: selectedTasks, judgeCapability: describeRuntimeJudgeCapability(profile) });
    if (!authority.ok) throw setupError("setup.authority", authority.diagnostics.map(d => d.message).join(" "));
    const judgeRequired = Object.values(authority.value.byTaskId).some(a => a.judge?.availability === "required");
    const env = { ...dependencies.env };
    const entered = {};
    // A project-local blank assignment must not fall back to an exported key.
    const source = await regularFileContents(join(io.cwd, ".env.local"));
    if (source !== null) Object.assign(env, parseEnv(source));
    const ensure = async (names, label) => {
      if (names.some(name => nonblank(env[name]))) return;
      let name = names[0];
      if (names.length > 1 && (io.stdin ?? process.stdin).isTTY && io.stdout.isTTY) {
        const choice = await prompt({ message: `  ${label} credential (${names.join(" / ")}) [${name}]: ` }, io);
        if (choice === null) throw setupError("setup.cancelled", "Setup cancelled; no template build or evaluation started.");
        if (choice.trim()) name = choice.trim();
        if (!names.includes(name)) throw setupError("setup.credential", `Choose ${names.join(" or ")} and rerun setup.`);
      }
      const value = await prompt({ message: `  ${name} (hidden): `, secret: true }, io);
      if (value === null) {
        if ((io.stdin ?? process.stdin).isTTY && io.stdout.isTTY) throw setupError("setup.cancelled", "Setup cancelled; no template build or evaluation started.");
        throw setupError("setup.credentials-missing", `${names.join(" or ")} is missing. Add it to ${join(io.cwd, ".env.local")} or export it, then rerun npx hurdle setup. .env.local overrides exported values.`);
      }
      if (!/^[\x21-\x7e]+$/.test(value)) throw setupError("setup.credential", "Enter a nonblank credential without spaces or line breaks.");
      env[name] = entered[name] = value;
    };
    await ensure([profile.environment.apiKeyEnv], "E2B");
    for (const id of ids) await ensure(id === "codex" ? ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"] : ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], id === "codex" ? "Codex" : "Claude Code");
    for (const name of taskCredentials) await ensure([name], "Task");
    if (judgeRequired) await ensure([profile.judge.credentialEnv], "Judge");
    if (profile.resultStore.kind === "postgres") await ensure([profile.resultStore.databaseUrlEnv], "Postgres");
    const readiness = await dependencies.checkAgentReadiness({ agentSelections: authored.defaults.agentSelections, runtimeProfile: profile, runtimeEnv: env, requiredCredentials: taskCredentials, judgeCredentialName: judgeRequired ? profile.judge.credentialEnv : null });
    for (const check of readiness.checks) line(check.status, check.message);
    if (!readiness.ok) throw setupError("setup.not-ready", "Resolve the credential errors above and rerun npx hurdle setup. No template build or evaluation started.");
    const backend = await (dependencies.loadSetupBackend ?? loadSetupBackend)();
    let available;
    try { available = await backend.exists(name, env[profile.environment.apiKeyEnv]); }
    catch (error) {
      if (error.code?.startsWith("setup.")) throw error;
      throw setupError("setup.template-unavailable", "Could not check the E2B template. Check account access and retry setup.");
    }
    if (!available && template) throw setupError("setup.template-missing", "The selected template is not available. Check --template NAME, or omit it to build the Hurdle template.");
    if (available && typeof available === "object") {
      if (!old) {
        config.environment.settings.cpuCount = available.cpuCount;
        config.environment.settings.memoryMiB = available.memoryMB;
      } else if (settings.cpuCount !== available.cpuCount || settings.memoryMiB !== available.memoryMB) {
        throw setupError("setup.template-capacity", `Template capacity does not match the saved Runtime. Update cpuCount and memoryMiB in ${runtimePath}, then rerun setup.`);
      }
      try { normalizeE2BSettings(config.environment.settings); }
      catch { throw setupError("setup.template-capacity", "Template capacity is not supported by the E2B Runtime. Choose a template with at least 512 MB of memory."); }
    }
    await saveCredentials(io.cwd, entered);
    if (!available) {
      const capacity = { cpuCount: settings.cpuCount, memoryMB: settings.memoryMiB };
      io.stdout.write(`\n  Template  ${name}\n  Build     ${capacity.cpuCount} CPUs · ${capacity.memoryMB} MB · installs ${ids.join(" + ")}\n  Building uses your E2B account and may be billed. No evaluation runs during setup.\n\n`);
      if (!yes) {
        const answer = await prompt({ message: "  Build this template? [y/N]: " }, io);
        if (!answer || !["y", "yes"].includes(answer.trim().toLowerCase())) throw setupError("setup.build-required", "Template build not started. Rerun setup to confirm, or use --yes to accept build usage without a prompt.");
      }
      const progress = io.stderr.isTTY ? createTerminalProgress({ stream: io.stderr }) : null;
      progress?.start("Building E2B template");
      if (!progress) io.stdout.write("Building E2B template…\n");
      try { await backend.build(name, ids, env[profile.environment.apiKeyEnv], capacity); }
      catch { throw setupError("setup.build-failed", "E2B template build failed. Inspect the build in your E2B dashboard, then rerun setup. Project Runtime was not changed."); }
      finally { progress?.stop(); }
      line("pass", "E2B template built.");
    } else line("pass", `E2B template available · ${name}`);
    // Keep existing stores, Judge settings, and user limits when reusing setup.
    await atomicWrite(runtimeFile, `${JSON.stringify(config, null, 2)}\n`, 0o600);
    line("pass", "Project sandbox configured.");
    io.stdout.write(`\n  Runtime   ${runtimePath}\n  Suite     ${suite}\n\n  Model access, remote tools, and billing are checked during execution.\n  Next: npx hurdle run${suite === "evals/example.suite.mjs" || suite === "example.suite.mjs" ? "" : ` ${JSON.stringify(suite)}`} --view\n`);
    return 0;
  } catch (error) {
    const known = error.code?.startsWith("setup.") || error.code?.startsWith("runtime.") || error.code === "backend-not-installed";
    line("fail", known ? error.message : "Setup could not complete. Check your project files, credentials, and E2B account, then retry.");
    return 1;
  } finally { authored?.dispose(); }
}
