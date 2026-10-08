#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";
import { assertRuntimeDependencies, BackendDependencyError } from "../lib/backend-dependencies.mjs";
import { createE2BExecutionEnvironment } from "../lib/execution-environments/e2b.mjs";
import { createLocalExecutionEnvironment } from "../lib/execution-environments/local.mjs";
import { createAnthropicJsonJudge } from "../lib/judges/anthropic-json.mjs";
import { resolveAuthoritySelections } from "../lib/authority-profile.mjs";
import { normalizeExecutionProgressObserver, projectVerdictReasons, reportExecutionProgress } from "../lib/execution-progress.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { loadProjectEnvironment } from "../lib/project-environment.mjs";
import {
  closePostgresResultStore,
  openPostgresResultStore,
} from "../lib/postgres-result-store.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import {
  RuntimeProfileError,
  describeRuntimeJudgeCapability,
  resolveRuntimeProfile,
  resolveRuntimeSecrets,
  viewerStoreEnvironment,
} from "../lib/runtime-profile.mjs";
import { selectDefinitionIds } from "../lib/run-model.mjs";
import { createTerminalProgress } from "../lib/terminal-progress.mjs";
import {
  V1AuthoringError,
  resolveV1Suite,
} from "../lib/v1-authoring.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import { checkAgentReadiness } from "../lib/agent-readiness.mjs";
import { projectRuntimePath, setupSandbox } from "../lib/sandbox-setup.mjs";
import { setupPostgresStore } from "../lib/postgres-setup.mjs";
import { createSetupOutput } from "../lib/setup-output.mjs";
import { createViewerOnboarding } from "../lib/viewer-onboarding.mjs";
import {
  terminalUsesColor, paintTerminal as paintRunOutput, terminalFact as runFact,
  terminalHeader, terminalStatus, terminalNote, terminalNext, suiteCommand,
} from "../lib/terminal-output.mjs";

const FIRST_PARTY_AGENT_ADAPTERS = Object.freeze({
  "claude-code": createClaudeCodeAdapter,
  codex: createCodexAdapter,
});

const AGENT_LABELS = Object.freeze({
  "claude-code": "Claude Code",
  codex: "Codex",
});

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function runOutputUsesColor(io) {
  return terminalUsesColor(io.stdout);
}

function writeError(io, text) {
  io.stderr.write(terminalStatus("fail", text.trimEnd(), io.stderr));
}

function agentSelectionLabel(selection) {
  const agent = AGENT_LABELS[selection.adapterId] ?? selection.adapterId;
  return selection.requestedModel ? `${agent} · ${selection.requestedModel}` : agent;
}

function scoringLabel(authorities) {
  const labels = new Set(authorities.map((authority) => ({
    "deterministic-primary": "Code",
    "judge-primary": "Judge",
    hybrid: "Code + Judge",
  })[authority?.kind] ?? "Observation"));
  return labels.size === 1 ? [...labels][0] : "Mixed";
}

function displayStore(runtimeProfile, cwd) {
  if (runtimeProfile.resultStore.kind === "postgres") {
    const artifactRoot = relative(cwd, runtimeProfile.resultStore.artifactRoot);
    const displayedRoot = artifactRoot && !artifactRoot.startsWith(`..${sep}`)
      ? artifactRoot
      : runtimeProfile.resultStore.artifactRoot;
    return `Postgres · artifacts ${displayedRoot}`;
  }
  const storeRoot = relative(cwd, runtimeProfile.resultStore.root);
  return storeRoot && !storeRoot.startsWith(`..${sep}`)
    ? storeRoot
    : runtimeProfile.resultStore.root;
}

const SOURCE_VIEWER_LAUNCHER_URL = new URL("../../viewer/launcher.mjs", import.meta.url);

async function launchFirstPartyViewer(options) {
  try {
    const { launchViewer } = await import(
      SOURCE_VIEWER_LAUNCHER_URL
    );
    return launchViewer(options);
  } catch {
    return Object.freeze({ kind: "failed", exitCode: 1 });
  }
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  env: process.env,
  environmentSource: "provided environment",
  checkAgentReadiness,
  processTarget: process,
  viewerCwd: fileURLToPath(new URL("../../", import.meta.url)),
  initializeSuite,
  openLocalResultStore,
  openPostgresResultStore,
  closePostgresResultStore,
  createRunEngine,
  createLocalExecutionEnvironment,
  createE2BExecutionEnvironment,
  assertRuntimeDependencies,
  createAnthropicJsonJudge,
  resolveV1Suite,
  launchViewer: launchFirstPartyViewer,
  createAgentAdapter(adapterId, runtimeEnv) {
    const createAdapter = FIRST_PARTY_AGENT_ADAPTERS[adapterId];
    if (!createAdapter) {
      throw new TypeError(`Unsupported first-party Agent Adapter '${adapterId}'`);
    }
    return createAdapter({ runtimeEnv });
  },
});

function renderDiagnostic(diagnostic, cwd) {
  const relativeFile = isAbsolute(diagnostic.file)
    ? relative(cwd, diagnostic.file)
    : diagnostic.file;
  const file = relativeFile !== ".." && !relativeFile.startsWith(`..${sep}`)
    ? relativeFile
    : diagnostic.file;
  const pointer = diagnostic.pointer ? `:${diagnostic.pointer}` : "";
  return `${file}${pointer} [${diagnostic.code}] ${diagnostic.message}\n`;
}

function printDiagnostics(diagnostics, io) {
  for (const diagnostic of diagnostics) {
    writeError(io, renderDiagnostic(diagnostic, io.cwd));
  }
}

const HELP_TEXT = Object.freeze({
  main: [
    "Hurdle",
    "",
    "Usage:",
    "  hurdle <command> [options]",
    "",
    "Commands:",
    "  init [directory]   Create a starter evaluation",
    "  setup [suite]      Configure sandbox or result storage",
    "  validate [suite]   Validate a Suite and check Agent readiness",
    "  run [suite]        Run a Suite",
    "  view               Start the Results Viewer",
    "  version            Show the installed version",
    "  help [command]     Show help for a command",
    "",
    "Run `hurdle help <command>` for command options.",
  ].join("\n"),
  init: [
    "Usage:",
    "  hurdle init [directory] [--agent claude-code|codex] [--example copy-message|together-api]",
    "",
    "Create a starter evaluation. The default directory is `evals`.",
    "The destination must not already exist.",
    "",
    "Credentials come from .env.local or exported environment variables.",
    "Interactive Agent logins are not inherited. Claude Code uses",
    "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; Codex uses CODEX_ACCESS_TOKEN,",
    "CODEX_API_KEY, or OPENAI_API_KEY. Together API also needs TOGETHER_API_KEY.",
    "",
    "Options:",
    "  --agent ID         Choose Claude Code (default) or Codex",
    "  --example NAME     Choose copy-message (default) or Together API demo",
    "  -h, --help         Show this help",
  ].join("\n"),
  setup: [
    "Usage:",
    "  hurdle setup [suite] [options]",
    "",
    "Configure the project sandbox (E2B) or connect an existing Postgres database.",
    "Sandbox setup checks credentials and reuses or builds an E2B template.",
    "Saves .hurdle/runtime/default.json for validate, run, and view. No Agent runs.",
    "Template builds use your E2B account and may be billed.",
    "--store postgres checks the connection and applies the result schema migrations.",
    "Storage setup preserves execution settings and creates no database.",
    "Configure sandbox and storage in separate commands.",
    "Reads .env.local or environment credentials; reports missing values without prompting.",
    "",
    "Options:",
    "  --store postgres   Configure Postgres storage without changing execution",
    "  --sandbox e2b      Select the sandbox provider",
    "  --template NAME    Reuse an existing template (must include the Suite's Agent CLIs)",
    "  --yes              Accept E2B template build usage",
    "  --json             Emit one JSON result, including missing credential names",
    "  --interactive      Prompt for missing credentials and template build approval",
    "  -h, --help         Show this help",
  ].join("\n"),
  validate: [
    "Usage:",
    "  hurdle validate [suite] [options]",
    "",
    "Validate a .suite.mjs Suite and check runtime/authentication readiness.",
    "Uses read-only provider requests; never runs an Agent or Judge.",
    "The default Suite is `evals/example.suite.mjs` when it exists,",
    "otherwise `example.suite.mjs`.",
    "Uses the project Runtime saved by setup unless overridden.",
    "",
    "Options:",
    "  --offline          Check Suite definitions only; no readiness checks",
    "  --runtime FILE     Check the Runtime Profile used by run",
    "  --agent ID         Check one Agent selected by the Suite",
    "  --model MODEL      Filter Suite model selections",
    "  -h, --help         Show this help",
  ].join("\n"),
  run: [
    "Usage:",
    "  hurdle run [suite] [options]",
    "",
    "Run a .suite.mjs Suite. The default is `evals/example.suite.mjs` when",
    "it exists, otherwise `example.suite.mjs`.",
    "Uses the project Runtime saved by setup unless overridden.",
    "Agent and model options filter selections already defined by the Suite.",
    "",
    "Selection:",
    "  --task ID                   Select a Task; repeat to select more",
    "  --condition ID              Select a Condition; repeat to select more",
    "  --agent claude-code|codex   Select an Agent",
    "  --model MODEL               Select a model",
    "",
    "Runtime:",
    "  --runtime FILE              Use a Runtime Profile",
    "  --environment local|e2b     Select an Execution Environment",
    "  --environment-settings JSON Configure the Environment with a JSON object",
    "  --store DIR                 Save results to a local directory",
    "",
    "Output:",
    "  --experiment-version LABEL  Label runs for comparison",
    "  --view                      Start the Results Viewer after the run",
    "  -h, --help                  Show this help",
    "",
    "`--runtime` cannot be combined with `--environment`,",
    "`--environment-settings`, or `--store`.",
  ].join("\n"),
  version: [
    "Usage:",
    "  hurdle version",
    "",
    "Print the installed package version. No project or credentials required.",
    "Aliases: hurdle --version, hurdle -v",
  ].join("\n"),
  view: [
    "Usage:",
    "  hurdle view [--runtime FILE | --store DIR]",
    "",
    "Start the Results Viewer for the default or selected Result Store.",
    "",
    "Options:",
    "  --runtime FILE      Read the Result Store from a Runtime Profile",
    "  --store DIR         Open a local Result Store directory",
    "  -h, --help          Show this help",
  ].join("\n"),
});

function help(topic, io) {
  const body = topic === "main" ? HELP_TEXT[topic].slice("Hurdle\n\n".length) : HELP_TEXT[topic];
  io.stdout.write(terminalHeader(io.stdout).trimStart() + `${body}\n`);
  return 0;
}

function hasHelpFlag(args) {
  return args.some((argument) => ["--help", "-h"].includes(argument));
}

function usage(io) {
  writeError(io, "hurdle [argument-error] Unknown command or help topic. Run npx hurdle help.\n");
  return 2;
}

function argumentError(message, io) {
  writeError(io, `hurdle [argument-error] ${message}\n`);
  return { ok: false, exitCode: 2 };
}

function versionCommand(argv, io) {
  const [command, ...args] = argv;
  if (!["version", "--version", "-v"].includes(command)) return null;
  if (command === "version" && args.length === 1 && hasHelpFlag(args)) return help("version", io);
  if (args.length !== 0) return argumentError("Use version, --version, or -v without additional arguments.", io).exitCode;
  const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  io.stdout.write(`${version}\n`);
  return 0;
}

function defaultSuiteArgument(cwd) {
  return existsSync(resolve(cwd, "evals/example.suite.mjs"))
    ? "evals/example.suite.mjs"
    : "example.suite.mjs";
}

function parseRunArguments(args, io, { validation = false } = {}) {
  const values = {
    suite: defaultSuiteArgument(io.cwd),
    taskIds: [],
    conditionIds: [],
    agent: undefined,
    environment: "local",
    model: undefined,
    repeat: 1,
    retries: 0,
    environmentSettings: "{}",
    experimentVersion: null,
    store: null,
    runtime: null,
    viewAfterRun: false,
    offline: false,
    explicitTopology: new Set(),
  };
  let suiteSeen = false;
  const seenScalarFields = new Set();
  const flags = new Map([
    ["--task", "taskIds"],
    ["--condition", "conditionIds"],
    ["--agent", "agent"],
    ["--environment", "environment"],
    ["--model", "model"],
    ["--environment-settings", "environmentSettings"],
    ["--experiment-version", "experimentVersion"],
    ["--store", "store"],
    ["--runtime", "runtime"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("-")) {
      if (suiteSeen) return argumentError("Only one Suite may be selected.", io);
      values.suite = token;
      suiteSeen = true;
      continue;
    }
    if (validation && token === "--offline") {
      if (values.offline) return argumentError("Option '--offline' may only be supplied once.", io);
      values.offline = true;
      continue;
    }
    if (token === "--view" && !validation) {
      if (seenScalarFields.has("viewAfterRun")) {
        return argumentError("Option '--view' may only be supplied once.", io);
      }
      seenScalarFields.add("viewAfterRun");
      values.viewAfterRun = true;
      continue;
    }
    const field = flags.get(token);
    if (!field) return argumentError(`Unknown ${validation ? "validate" : "run"} option '${token}'.`, io);
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      return argumentError(`Option '${token}' requires a value.`, io);
    }
    if (Array.isArray(values[field])) {
      if (values[field].includes(value)) {
        return argumentError(`Option '${token}' selects '${value}' more than once.`, io);
      }
      values[field].push(value);
    } else {
      if (seenScalarFields.has(field)) {
        return argumentError(`Option '${token}' may only be supplied once.`, io);
      }
      seenScalarFields.add(field);
      values[field] = value;
      if (["environment", "environmentSettings", "store"].includes(field)) {
        values.explicitTopology.add(field);
      }
    }
    index += 1;
  }
  try {
    values.environmentSettings = JSON.parse(values.environmentSettings);
  } catch {
    return argumentError("--environment-settings must be a JSON object.", io);
  }
  if (
    !values.environmentSettings
    || typeof values.environmentSettings !== "object"
    || Array.isArray(values.environmentSettings)
  ) {
    return argumentError("--environment-settings must be a JSON object.", io);
  }
  if (values.agent !== undefined && !Object.hasOwn(FIRST_PARTY_AGENT_ADAPTERS, values.agent)) {
    return argumentError("Agent filter must use 'claude-code' or 'codex'.", io);
  }
  if (!["local", "e2b"].includes(values.environment)) {
    return argumentError("Execution Environment must be 'local' or 'e2b'.", io);
  }
  if (
    values.runtime === null
    && values.environment === "local"
    && Object.keys(values.environmentSettings).length > 0
  ) {
    return argumentError("Local Execution Environment settings must be empty.", io);
  }
  if (values.runtime !== null && values.explicitTopology.size > 0) {
    return argumentError(
      "--runtime cannot be combined with --environment, --environment-settings, or --store.",
      io,
    );
  }
  if (values.runtime === null && values.explicitTopology.size === 0) values.runtime = projectRuntimePath(io.cwd);
  return { ok: true, values };
}

function parseViewArguments(args, io) {
  if (args.length === 0) return { ok: true, values: { runtime: null, store: null } };
  if (
    args.length !== 2
    || !["--runtime", "--store"].includes(args[0])
    || !args[1]
    || args[1].startsWith("-")
  ) {
    return argumentError(
      "view accepts only an optional '--runtime FILE' or '--store DIR'.",
      io,
    );
  }
  return args[0] === "--store"
    ? { ok: true, values: { runtime: null, store: args[1] } }
    : { ok: true, values: { runtime: args[1], store: null } };
}

function validateRunSelection(options, definition, io) {
  try {
    for (const [field, definitions, label] of [
      ["taskIds", definition.tasks, "Task"],
      ["conditionIds", definition.conditions, "Condition"],
    ]) {
      selectDefinitionIds(
        definitions,
        options[field].length > 0 ? options[field] : undefined,
        label,
      );
    }
  } catch (error) {
    return argumentError(`${error.message}.`, io);
  }
  return { ok: true };
}

async function serveResolvedViewer(runtimeProfile, io, dependencies, {
  showHeader = true, suite = defaultSuiteArgument(io.cwd), storeOverride = false,
} = {}) {
  let storeEnvironment;
  try {
    storeEnvironment = viewerStoreEnvironment(runtimeProfile, dependencies.env);
  } catch (error) {
    if (!(error instanceof RuntimeProfileError)) throw error;
    writeError(io, `hurdle [${error.code}] ${error.message}\n`);
    return 2;
  }
  let readyPrinted = false;
  const progress = io.stderr?.isTTY === true
    ? createTerminalProgress({ stream: io.stderr })
    : null;
  const useColor = runOutputUsesColor(io);
  if (showHeader) io.stdout.write(terminalHeader(io.stdout));
  const markReady = (url) => {
    if (readyPrinted) return;
    readyPrinted = true;
    progress?.stop();
    io.stdout.write(
      terminalStatus("pass", "Viewer ready", io.stdout) + "\n"
      + runFact("URL", url, { useColor })
      + runFact("Store", displayStore(runtimeProfile, io.cwd), { useColor })
      + `\n  ${paintRunOutput("Press Ctrl+C to stop.", "dim", useColor)}\n`,
    );
  };
  progress?.start("Starting Results Viewer");
  const outcome = await dependencies.launchViewer({
    storeEnvironment,
    onboarding: createViewerOnboarding({
      cwd: io.cwd,
      cliPath: fileURLToPath(import.meta.url),
      sourceCheckout: existsSync(new URL("../../viewer/package.json", import.meta.url)),
      suite,
      runtimeProfile,
      storeOverride,
    }),
    port: runtimeProfile.viewer.port,
    cwd: dependencies.viewerCwd,
    env: dependencies.env,
    processTarget: dependencies.processTarget,
    onReady(url) {
      markReady(url);
    },
  });
  if (!readyPrinted && outcome.url) markReady(outcome.url);
  if (outcome.kind === "interrupted") {
    if (!readyPrinted) progress?.warn("Results Viewer stopped");
    return outcome.exitCode;
  }
  if (outcome.kind === "stopped") {
    if (!readyPrinted) progress?.succeed("Results Viewer stopped");
    return 0;
  }
  progress?.fail(readyPrinted ? "Results Viewer stopped unexpectedly" : "Results Viewer failed to start");
  if (outcome.reason === "disposal-unconfirmed") {
    writeError(io, "hurdle [viewer-disposal-unconfirmed] Viewer shutdown could not be confirmed. Check for a surviving Viewer process before restarting.\n");
    return 1;
  }
  if (outcome.reason === "port-in-use") {
    writeError(io,
      `hurdle [viewer-port-in-use] Port ${runtimeProfile.viewer.port} is already in use.\n`
      + `Open http://127.0.0.1:${runtimeProfile.viewer.port} if the Viewer is already running, `
      + "or stop that process and run this command again.\n",
    );
  } else if (outcome.reason === "viewer-lock-held") {
    writeError(io,
      "hurdle [viewer-lock-held] Another Viewer development server appears to be running from this checkout.\n"
      + "Stop that Viewer and run this command again. If no Viewer is running, remove the stale viewer/.next/dev/lock file.\n",
    );
  } else {
    writeError(io,
      "hurdle [viewer-failed] The Results Viewer could not be started. "
      + "Run `npm --prefix viewer run dev` to inspect the startup error.\n",
    );
  }
  return 1;
}

async function runCliMain(argv, io, dependencies) {
  const versionResult = versionCommand(argv, io);
  if (versionResult !== null) return versionResult;
  const [command, ...args] = argv;
  if (!command) return help("main", io);

  if (["--help", "-h"].includes(command) && args.length === 0) {
    return help("main", io);
  }
  if (command === "help") {
    if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
      return help("main", io);
    }
    if (args.length === 1 && Object.hasOwn(HELP_TEXT, args[0]) && args[0] !== "main") {
      return help(args[0], io);
    }
    return usage(io);
  }
  if (["init", "setup", "validate", "run", "view"].includes(command) && hasHelpFlag(args)) {
    return help(command, io);
  }

  if (command === "init") {
    let directory = "evals", agent = "claude-code", example = "copy-message", directorySeen = false, agentSeen = false, exampleSeen = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--agent" && !agentSeen) {
        agent = args[++index];
        agentSeen = true;
        if (!["claude-code", "codex"].includes(agent)) return argumentError("--agent must be claude-code or codex.", io).exitCode;
      } else if (args[index] === "--example" && !exampleSeen) {
        example = args[++index];
        exampleSeen = true;
        if (!["copy-message", "together-api"].includes(example)) return argumentError("--example must be copy-message or together-api.", io).exitCode;
      } else if (!args[index].startsWith("-") && !directorySeen) {
        directory = args[index];
        directorySeen = true;
      } else {
        return argumentError("Use init [directory] [--agent claude-code|codex] [--example copy-message|together-api].", io).exitCode;
      }
    }
    const destination = resolve(io.cwd, directory);
    const result = await dependencies.initializeSuite({ destination, agent, example });
    if (!result.ok) {
      printDiagnostics(result.diagnostics, io);
      return 1;
    }
    const suite = `${directory.replace(/\/$/, "")}/example.suite.mjs`;
    const useColor = runOutputUsesColor(io);
    io.stdout.write(terminalHeader(io.stdout)
      + terminalStatus("pass", "Evaluation created", io.stdout) + "\n"
      + runFact("Suite", suite, { useColor })
      + runFact("Agent", AGENT_LABELS[agent], { useColor })
      + (example === "together-api" ? runFact("Needs", "E2B + TOGETHER_API_KEY", { useColor }) : "")
      + runFact("Auth", ".env.local or shell · see npx hurdle help init", { useColor })
      + runFact("Usage", example === "together-api" ? "Agent, Together, and E2B may be billed" : "Agent may be billed", { useColor })
      + terminalNext([
        suiteCommand(example === "together-api" ? "setup" : "validate", suite),
        suiteCommand("run", suite, { view: true }),
      ], io.stdout));
    return 0;
  }

  if (command === "setup") {
    const options = { suite: defaultSuiteArgument(io.cwd), sandbox: "e2b", template: undefined, yes: false, interactive: false, json: args.includes("--json") };
    const setupArgumentError = message => options.json
      ? createSetupOutput(io, { json: true }).finish(2, { code: "argument-error", message })
      : argumentError(message, io).exitCode;
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (["--yes", "--json", "--interactive"].includes(arg) && !seen.has(arg)) { options[arg.slice(2)] = true; seen.add(arg); }
      else if (["--sandbox", "--template", "--store"].includes(arg) && !seen.has(arg) && args[index + 1] && !args[index + 1].startsWith("-")) {
        seen.add(arg); options[arg.slice(2)] = args[++index];
      } else if (!arg.startsWith("-") && !seen.has("suite")) { options.suite = arg; seen.add("suite"); }
      else return setupArgumentError("Use setup [suite] [--store postgres | --sandbox e2b] [--template NAME] [--yes] [--json | --interactive].");
    }
    if (options.json && options.interactive) return setupArgumentError("Use --json for noninteractive setup or --interactive for terminal prompts, not both.");
    if (options.interactive && (!(io.stdin ?? process.stdin).isTTY || !io.stdout.isTTY)) {
      return setupArgumentError("--interactive requires a terminal. Configure credentials in .env.local or the environment instead.");
    }
    if (options.sandbox !== "e2b") return setupArgumentError("Only the E2B sandbox provider is supported currently.");
    if (options.template && !/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(options.template)) return setupArgumentError("Use an E2B template ID or name, optionally with a tag.");
    if (options.store !== undefined) {
      if (options.store !== "postgres") return setupArgumentError("Use --store postgres to configure database storage.");
      if (seen.has("--sandbox") || seen.has("--template")) {
        return setupArgumentError("Configure the sandbox with setup first, then run setup --store postgres.");
      }
      return setupPostgresStore(options, io, dependencies);
    }
    return setupSandbox(options, io, dependencies);
  }

  if (command === "run" || command === "validate") {
    const validation = command === "validate";
    const parsed = parseRunArguments(args, io, { validation });
    if (!parsed.ok) return parsed.exitCode;
    const options = parsed.values;
    const suiteSelected = /\.suite\.mjs$/.test(options.suite);
    let authoredSuite = null;
    let authoredSuiteCleanupOnExit = null;
    let resolvedPlan;
    if (suiteSelected) {
      try {
        authoredSuite = await dependencies.resolveV1Suite({
          suitePath: resolve(io.cwd, options.suite),
        });
      } catch (error) {
        if (!(error instanceof V1AuthoringError)) throw error;
        printDiagnostics([error], io);
        return 1;
      }
      resolvedPlan = authoredSuite;
      if (!resolvedPlan.ok) {
        printDiagnostics(resolvedPlan.diagnostics, io);
        authoredSuite.dispose();
        return 1;
      }
      if (options.taskIds.length === 0) options.taskIds = [...authoredSuite.defaults.taskIds];
      if (options.conditionIds.length === 0) options.conditionIds = [...authoredSuite.defaults.conditionIds];
      options.agentSelections = authoredSuite.defaults.agentSelections.filter((agent) =>
        (options.agent === undefined || agent.adapterId === options.agent)
        && (options.model === undefined || agent.requestedModel === options.model));
      if (options.agentSelections.length === 0) {
        authoredSuite.dispose();
        return argumentError("No Suite Agent matches the selected agent/model filters. Edit the Suite to change its matrix.", io).exitCode;
      }
      options.repeat = authoredSuite.defaults.repeat;
      authoredSuiteCleanupOnExit = () => authoredSuite?.dispose();
      dependencies.processTarget.once("exit", authoredSuiteCleanupOnExit);
    } else {
      return argumentError("Select a .suite.mjs Suite.", io).exitCode;
    }
    if (!resolvedPlan.ok) {
      printDiagnostics(resolvedPlan.diagnostics, io);
      return 1;
    }
    const disposeAuthoredSuite = () => {
      if (!authoredSuite) return;
      dependencies.processTarget.off("exit", authoredSuiteCleanupOnExit);
      authoredSuite.dispose();
      authoredSuite = null;
      authoredSuiteCleanupOnExit = null;
    };
    const selection = validateRunSelection(
      options,
      resolvedPlan.value.definition,
      io,
    );
    if (!selection.ok) {
      disposeAuthoredSuite();
      return selection.exitCode;
    }
    const selectedTaskIds = selectDefinitionIds(
      resolvedPlan.value.definition.tasks,
      options.taskIds.length > 0 ? options.taskIds : undefined,
      "Task",
    );
    io.stdout.write(terminalHeader(io.stdout));
    if (validation) {
      const useColor = runOutputUsesColor(io);
      const conditions = options.conditionIds.length || Object.keys(resolvedPlan.value.definition.conditions).length;
      io.stdout.write(terminalStatus("pass", "Suite valid", io.stdout) + "\n"
        + runFact("Suite", options.suite, { useColor })
        + runFact("Plan", `${selectedTaskIds.length} ${plural(selectedTaskIds.length, "task")} · ${conditions} ${plural(conditions, "condition")}`, { useColor }));
      if (options.offline) {
        io.stdout.write("\n" + terminalStatus("warning", "Readiness not checked (--offline)", io.stdout)
          + terminalNext([suiteCommand("validate", options.suite)], io.stdout));
        disposeAuthoredSuite();
        return 0;
      }
    }
    let runtimeProfile;
    try {
      if (options.runtime !== null) {
        runtimeProfile = resolveRuntimeProfile({
          runtimePath: options.runtime,
          cwd: io.cwd,
          defaultRoot: authoredSuite ? io.cwd : resolvedPlan.value.sourceRoot,
        });
      } else {
        const builtIn = resolveRuntimeProfile({
          cwd: io.cwd,
          defaultRoot: authoredSuite ? io.cwd : resolvedPlan.value.sourceRoot,
        });
        runtimeProfile = Object.freeze({
          ...builtIn,
          environment: Object.freeze({
            kind: options.environment,
            ...(options.environment === "e2b" ? { apiKeyEnv: "E2B_API_KEY" } : {}),
            settings: structuredClone(options.environmentSettings),
          }),
          resultStore: Object.freeze({
            kind: "local",
            root: options.store
              ? resolve(io.cwd, options.store)
              : builtIn.resultStore.root,
          }),
        });
      }
    } catch (error) {
      if (!(error instanceof RuntimeProfileError)) throw error;
      writeError(io, `hurdle [${error.code}] ${error.message}\n`);
      disposeAuthoredSuite();
      return 2;
    }
    if (runtimeProfile.environment.kind === "local" && selectedTaskIds.some(taskId => (
      resolvedPlan.value.definition.tasks[taskId].executionRequirements?.some(requirement => [
        "environment.trusted-egress-capture", "environment.trusted-request-blocking",
      ].includes(requirement))
    ))) {
      writeError(io, `hurdle [runtime.capture-required] Selected Tasks require trusted API capture or request blocking. Run \`${suiteCommand("setup", options.suite)}\` to configure E2B, or select an E2B Runtime with --runtime. No evaluation started.\n`);
      disposeAuthoredSuite();
      return 1;
    }
    const judgeCapability = describeRuntimeJudgeCapability(runtimeProfile);
    const authoritySelection = resolveAuthoritySelections({
      definition: resolvedPlan.value.definition,
      selectedTaskIds,
      judgeCapability,
    });
    if (!authoritySelection.ok) {
      const selectedConditionCount = options.conditionIds.length > 0
        ? options.conditionIds.length
        : Object.keys(resolvedPlan.value.definition.conditions).length;
      const plannedCells = selectedTaskIds.length
        * selectedConditionCount
        * options.agentSelections.length;
      writeError(io,
        `hurdle [matrix-rejected] ${plannedCells} selected cells could not be executed.\n`,
      );
      for (const diagnostic of authoritySelection.diagnostics.slice(0, 10)) {
        writeError(io, `hurdle [${diagnostic.code}] ${diagnostic.message}\n`);
      }
      const exitCode = authoritySelection.diagnostics.every(
        ({ category }) => category === "selection",
      ) ? 2 : 1;
      disposeAuthoredSuite();
      return exitCode;
    }
    const authorityNeedsJudge = Object.values(authoritySelection.value.byTaskId).some(
      (authority) => authority?.judge?.availability === "required",
    );
    if (
      options.runtime === null
      && runtimeProfile.environment.kind === "e2b"
      && (
        typeof dependencies.env.E2B_API_KEY !== "string"
        || !dependencies.env.E2B_API_KEY.trim()
      )
    ) {
      const exitCode = argumentError("--environment e2b requires E2B_API_KEY.", io).exitCode;
      disposeAuthoredSuite();
      return exitCode;
    }
    let runtimeSecrets;
    try {
      runtimeSecrets = resolveRuntimeSecrets(
        runtimeProfile,
        dependencies.env,
        { judge: authorityNeedsJudge },
      );
      dependencies.assertRuntimeDependencies(runtimeProfile);
    } catch (error) {
      if (!(error instanceof RuntimeProfileError || error instanceof BackendDependencyError)) throw error;
      writeError(io, `hurdle [${error.code}] ${error.message}\n`);
      disposeAuthoredSuite();
      return 2;
    }
    const selectedCredentialNames = new Set(selectedTaskIds.flatMap((taskId) => (
      resolvedPlan.value.definition.tasks[taskId].credentialRequirements
    )));
    const agentVisibleCredentialNames = new Set(selectedTaskIds.flatMap((taskId) => {
      const task = resolvedPlan.value.definition.tasks[taskId];
      return task.credentialRequirements.filter((name) => (
        task.credentialDeliveryOverrides?.[name]
          ?? resolvedPlan.value.definition.credentialRequirements[name]?.delivery
          ?? { kind: "environment" }
      ).kind === "environment");
    }));
    io.stdout.write("\n" + terminalNote(`Readiness (${dependencies.environmentSource})`, io.stdout));
    let readiness;
    try {
      readiness = await dependencies.checkAgentReadiness({
        agentSelections: options.agentSelections,
        runtimeProfile,
        runtimeEnv: dependencies.env,
        requiredCredentials: [...selectedCredentialNames],
        judgeCredentialName: authorityNeedsJudge ? runtimeProfile.judge.credentialEnv : null,
      });
    } catch {
      writeError(io, "hurdle [readiness-unavailable] Readiness checks could not complete. No evaluation started; check your setup and retry.\n");
      disposeAuthoredSuite();
      return 1;
    }
    for (const check of readiness.checks) {
      io.stdout.write(terminalStatus(check.status, check.message, io.stdout));
    }
    if (!readiness.ok) {
      writeError(io, `hurdle [not-ready] Resolve the setup errors above and run \`${suiteCommand("validate", options.suite)}\` again. No evaluation started.\n`);
      disposeAuthoredSuite();
      return 1;
    }
    if (validation) {
      io.stdout.write("\n" + terminalStatus("pass", "Ready to run", io.stdout)
        + terminalNote("Model access, billing, and task success are checked during execution.", io.stdout)
        + terminalNext([suiteCommand("run", options.suite, { view: true })], io.stdout));
      disposeAuthoredSuite();
      return 0;
    }
    if (authoredSuite) {
      const selectedConditionCount = options.conditionIds.length > 0
        ? options.conditionIds.length
        : Object.keys(resolvedPlan.value.definition.conditions).length;
      const plannedCells = selectedTaskIds.length
        * selectedConditionCount
        * options.agentSelections.length;
      const plannedRuns = plannedCells * options.repeat;
      const services = [
        "Agent",
        ...(authorityNeedsJudge ? ["Judge"] : []),
        ...(runtimeProfile.environment.kind === "e2b" ? ["E2B"] : []),
        ...(selectedCredentialNames.size > 0 ? ["external API"] : []),
      ];
      const serviceText = services.length === 1
        ? services[0]
        : services.length === 2
          ? `${services[0]} and ${services[1]}`
          : `${services.slice(0, -1).join(", ")}, and ${services.at(-1)}`;
      const useColor = runOutputUsesColor(io);
      const plan = `${plannedRuns} ${plural(plannedRuns, "run")} · `
        + `${selectedTaskIds.length} ${plural(selectedTaskIds.length, "task")} · `
        + `${selectedConditionCount} ${plural(selectedConditionCount, "condition")}`;
      const agents = options.agentSelections.map(agentSelectionLabel).join(", ");
      const runtime = `${runtimeProfile.environment.kind === "e2b" ? "E2B" : "Local"} · `
        + `${runtimeProfile.resultStore.kind === "postgres" ? "Postgres" : "Filesystem"}`;
      const authorities = selectedTaskIds.map(
        (taskId) => authoritySelection.value.byTaskId[taskId],
      );
      io.stdout.write(
        "\n" + runFact("Plan", plan, { useColor })
        + runFact("Agent", agents, { useColor })
        + runFact("Runtime", runtime, { useColor })
        + runFact("Scoring", scoringLabel(authorities), { useColor })
        + runFact("Usage", `${serviceText} may be billed`, { useColor }),
      );
      if (agentVisibleCredentialNames.size > 0) {
        io.stdout.write(
          runFact("Access", "Target API credentials available to Agent", { useColor }),
        );
      }
      io.stdout.write("\n");
    }
    const progress = createTerminalProgress({
      stream: io.stderr?.isTTY === true ? io.stderr : io.stdout,
      showElapsed: true,
    });
    progress.start("Opening result store");
    let resultStore;
    try {
      resultStore = runtimeProfile.resultStore.kind === "postgres"
        ? await dependencies.openPostgresResultStore({
            connectionString: runtimeSecrets.postgresDatabaseUrl,
            localArtifactRoot: runtimeProfile.resultStore.artifactRoot,
          })
        : await dependencies.openLocalResultStore({ root: runtimeProfile.resultStore.root });
    } catch {
      progress.stop();
      writeError(io, "hurdle [store-unavailable] The configured Result Store could not be opened.\n");
      disposeAuthoredSuite();
      return 1;
    }
    let cellStartedAt = Date.now();
    const reportedReasonRunIds = new Set();
    const cellLabel = (cell) => {
      const agent = { "claude-code": "Claude Code", codex: "Codex" }[cell.adapterId] ?? cell.adapterId;
      const repeat = cell.repeatTotal > 1 ? ` · repeat ${cell.repeatOrdinal}/${cell.repeatTotal}` : "";
      return `[${cell.ordinal}/${cell.total}] ${cell.taskId} · ${cell.conditionId} · ${agent}${repeat}`;
    };
    const terminalObserver = { observe(event) {
      if (event.kind === "cell-started") {
        cellStartedAt = Date.now();
        progress.start(`${cellLabel(event.cell)} · Evaluating`);
      } else if (event.kind === "cell-completed") {
        const verdict = event.terminal.verdict;
        const method = verdict === "pass" ? "succeed" : verdict === "fail" ? "fail" : "warn";
        progress[method](
          `${cellLabel(event.cell)} · ${verdict}`,
          `${Math.max(0, Math.floor((Date.now() - cellStartedAt) / 1000))}s`,
        );
        const reasons = projectVerdictReasons([
          ...(event.terminal.runTrustReasons ?? []),
          ...event.terminal.verdictReasons,
        ]);
        for (const reason of reasons) progress.detail(`${reason.code}: ${reason.summary}`);
        if (reasons.length > 0) reportedReasonRunIds.add(event.terminal.id);
      }
    } };
    const progressObserver = { observe(event) {
      reportExecutionProgress(terminalObserver, event);
      reportExecutionProgress(dependencies.executionProgressObserver, event);
    } };
    const abortController = new AbortController();
    let interruptedSignal = null;
    const interrupt = (signal) => {
      interruptedSignal ??= signal;
      abortController.abort();
    };
    const onSigint = () => interrupt("SIGINT");
    const onSigterm = () => interrupt("SIGTERM");
    dependencies.processTarget.on("SIGINT", onSigint);
    dependencies.processTarget.on("SIGTERM", onSigterm);
    let result;
    let storeCloseFailed = false;
    let executionFailed = false;
    try {
      progress.start("Preparing evaluations");
      const credentials = Object.fromEntries(
        [...selectedCredentialNames]
          .filter((name) => dependencies.env[name] !== undefined)
          .map((name) => [name, dependencies.env[name]]),
      );
      const judge = authorityNeedsJudge
        ? dependencies.createAnthropicJsonJudge({
            model: runtimeProfile.judge.model,
            apiKey: runtimeSecrets.judgeCredential,
          })
        : null;
      const engine = dependencies.createRunEngine({
        resultStore,
        agentAdapters: [...new Set(
          options.agentSelections.map(({ adapterId }) => adapterId),
        )].map((adapterId) => (
          dependencies.createAgentAdapter(adapterId, dependencies.env)
        )),
        executionEnvironment: runtimeProfile.environment.kind === "e2b"
          ? dependencies.createE2BExecutionEnvironment({
              apiKey: runtimeSecrets.e2bApiKey,
              progressObserver,
            })
          : dependencies.createLocalExecutionEnvironment(),
        ...(judge === null ? {} : { judge }),
        progressObserver,
      });
      result = await engine.run({
        runPlan: resolvedPlan.value,
        taskIds: options.taskIds.length > 0 ? options.taskIds : undefined,
        conditionIds: options.conditionIds.length > 0 ? options.conditionIds : undefined,
        agentSelections: options.agentSelections,
        repeat: options.repeat,
        retries: options.retries,
        experimentVersion: options.experimentVersion,
        credentials,
        environmentSettings: runtimeProfile.environment.settings,
        signal: abortController.signal,
      });
    } catch {
      executionFailed = true;
    } finally {
      progress.stop();
      dependencies.processTarget.off("SIGINT", onSigint);
      dependencies.processTarget.off("SIGTERM", onSigterm);
      if (runtimeProfile.resultStore.kind === "postgres") {
        try {
          await dependencies.closePostgresResultStore(resultStore);
        } catch {
          storeCloseFailed = true;
        }
      }
      disposeAuthoredSuite();
    }
    if (storeCloseFailed) {
      writeError(io,
        "hurdle [store-close-failed] The configured Result Store could not be closed cleanly.\n",
      );
      return 1;
    }
    if (executionFailed) {
      writeError(io, "hurdle [run-failed] Evaluation setup or execution failed; resources were closed.\n");
      return 1;
    }
    if (result.status === "rejected") {
      writeError(io,
        `hurdle [matrix-rejected] ${result.summary.plannedCells} selected cells could not be executed.\n`,
      );
      for (const diagnostic of result.diagnostics.slice(0, 10)) {
        writeError(io, `hurdle [${diagnostic.code}] ${diagnostic.message}\n`);
      }
      return result.diagnostics.every(({ category }) => category === "selection") ? 2 : 1;
    }
    const { summary } = result;
    const counts = summary.terminalVerdicts;
    const authority = summary.authorityCoverage;
    const useColor = runOutputUsesColor(io);
    const issueCount = counts.fail + counts.incomplete + counts.unknown;
    const runCounts = [
      counts.pass > 0 ? `${counts.pass} passed` : null,
      counts.fail > 0 ? `${counts.fail} failed` : null,
      counts.incomplete > 0 ? `${counts.incomplete} incomplete` : null,
      counts.unknown > 0 ? `${counts.unknown} unknown` : null,
    ].filter(Boolean).join(" · ");
    io.stdout.write("\n");
    io.stdout.write(runFact(
      "Result",
      issueCount === 0 ? "Passed" : "Needs attention",
      { color: issueCount === 0 ? "green" : "yellow", useColor },
    ));
    io.stdout.write(runFact("Runs", runCounts, { useColor }));
    if (summary.retriesPerformed > 0) {
      io.stdout.write(runFact(
        "Retries",
        `${summary.retriesPerformed} ${plural(summary.retriesPerformed, "retry", "retries")}`,
        { useColor },
      ));
    }
    if (authority.judgeRequiredRuns > 0) {
      const judge = `${authority.judgeCompletedRuns}/${authority.judgeRequiredRuns} completed`
        + (authority.disagreements > 0
          ? ` · ${authority.disagreements} ${plural(authority.disagreements, "disagreement")}`
          : "");
      io.stdout.write(runFact("Judge", judge, { useColor }));
    }
    for (const run of summary.nonPasses) {
      if (!reportedReasonRunIds.has(run.id)) {
        for (const reason of projectVerdictReasons(run.verdictReasons)) {
          io.stdout.write(runFact("Reason", reason.summary, { useColor }));
        }
      }
    }
    if (summary.omittedNonPasses > 0) {
      io.stdout.write(runFact(
        "More",
        `${summary.omittedNonPasses} additional non-passing ${plural(summary.omittedNonPasses, "run")}`,
        { useColor },
      ));
    }
    io.stdout.write(`${runFact("Store", displayStore(runtimeProfile, io.cwd), { useColor })}\n`);
    if (interruptedSignal === "SIGINT") return 130;
    if (interruptedSignal === "SIGTERM") return 143;
    const runExitCode = counts.fail + counts.incomplete + counts.unknown === 0 ? 0 : 1;
    if (!options.viewAfterRun) return runExitCode;
    const viewerExitCode = await serveResolvedViewer(runtimeProfile, io, dependencies, { showHeader: false, suite: options.suite });
    return viewerExitCode === 0 ? runExitCode : viewerExitCode;
  }

  if (command === "view") {
    const parsed = parseViewArguments(args, io);
    if (!parsed.ok) return parsed.exitCode;
    let runtimeProfile;
    try {
      runtimeProfile = resolveRuntimeProfile({
        runtimePath: parsed.values.runtime ?? projectRuntimePath(io.cwd) ?? undefined,
        cwd: io.cwd,
      });
      if (parsed.values.store) {
        runtimeProfile = Object.freeze({
          ...runtimeProfile,
          resultStore: Object.freeze({
            kind: "local",
            root: resolve(io.cwd, parsed.values.store),
          }),
        });
      }
    } catch (error) {
      if (!(error instanceof RuntimeProfileError)) throw error;
      writeError(io, `hurdle [${error.code}] ${error.message}\n`);
      return 2;
    }
    return serveResolvedViewer(runtimeProfile, io, dependencies, { storeOverride: Boolean(parsed.values.store) });
  }

  return usage(io);
}

export function createFrameworkCli(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("CLI dependencies must be an object");
  }
  const dependencies = Object.freeze({
    ...PRODUCTION_DEPENDENCIES,
    ...overrides,
    executionProgressObserver: normalizeExecutionProgressObserver(
      overrides.executionProgressObserver,
    ),
  });
  return Object.freeze({
    main(argv, io = {
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
    }) {
      return runCliMain(argv, io, dependencies);
    },
  });
}

export async function main(argv, io = {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
}) {
  const versionResult = versionCommand(argv, io);
  if (versionResult !== null) return versionResult;
  let configured;
  try { configured = loadProjectEnvironment(io.cwd); }
  catch (error) {
    if (argv[0] !== "setup") throw error;
    return createSetupOutput(io, { json: argv.includes("--json") }).finish(1, {
      code: "setup.environment-unavailable",
      message: "Could not read .env.local. Use a readable regular file, then rerun setup.",
    });
  }
  const { environment, source } = configured;
  return createFrameworkCli({ env: environment, environmentSource: source }).main(argv, io);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    writeError({ stderr: process.stderr }, "hurdle [internal-error] An unexpected internal error occurred.\n");
    process.exitCode = 70;
  }
}
