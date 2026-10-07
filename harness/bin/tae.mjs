#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
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

const FIRST_PARTY_AGENT_ADAPTERS = Object.freeze({
  "claude-code": createClaudeCodeAdapter,
  codex: createCodexAdapter,
});

const AGENT_LABELS = Object.freeze({
  "claude-code": "Claude Code",
  codex: "Codex",
});
const RUN_COLORS = Object.freeze({
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  dim: "\u001b[2m",
  reset: "\u001b[0m",
});

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function runOutputUsesColor(io) {
  return Boolean(io.stdout?.isTTY || io.stderr?.isTTY) && !process.env.NO_COLOR;
}

function paintRunOutput(value, color, enabled) {
  return enabled ? `${RUN_COLORS[color]}${value}${RUN_COLORS.reset}` : value;
}

function runFact(label, value, { color = null, useColor = false } = {}) {
  const key = paintRunOutput(label.padEnd(9), "dim", useColor);
  const renderedValue = color ? paintRunOutput(value, color, useColor) : value;
  return `  ${key} ${renderedValue}\n`;
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
    io.stderr.write(renderDiagnostic(diagnostic, io.cwd));
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
    "  validate [suite]   Validate a Suite and check Agent readiness",
    "  run [suite]        Run a Suite",
    "  view               Start the Results Viewer",
    "  help [command]     Show help for a command",
    "",
    "Run `hurdle help <command>` for command options.",
  ].join("\n"),
  init: [
    "Usage:",
    "  hurdle init [directory] [--agent claude-code|codex]",
    "",
    "Create a starter evaluation. The default directory is `evals`.",
    "The destination must not already exist.",
    "",
    "Options:",
    "  --agent ID         Choose Claude Code (default) or Codex",
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
  io.stdout.write(`${HELP_TEXT[topic]}\n`);
  return 0;
}

function hasHelpFlag(args) {
  return args.some((argument) => ["--help", "-h"].includes(argument));
}

function usage(io) {
  io.stderr.write("Usage: hurdle <init [directory] | validate [suite] | run [suite] [options] [--view] | view [--runtime FILE | --store DIR]>\n");
  return 2;
}

function argumentError(message, io) {
  io.stderr.write(`hurdle [argument-error] ${message}\n`);
  return { ok: false, exitCode: 2 };
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

async function serveResolvedViewer(runtimeProfile, io, dependencies) {
  let storeEnvironment;
  try {
    storeEnvironment = viewerStoreEnvironment(runtimeProfile, dependencies.env);
  } catch (error) {
    if (!(error instanceof RuntimeProfileError)) throw error;
    io.stderr.write(`hurdle [${error.code}] ${error.message}\n`);
    return 2;
  }
  let readyPrinted = false;
  const progress = io.stderr?.isTTY === true
    ? createTerminalProgress({ stream: io.stderr })
    : null;
  const viewerStartedAt = Date.now();
  const markReady = (url) => {
    if (readyPrinted) return;
    readyPrinted = true;
    progress?.succeed("Results Viewer ready", `${Date.now() - viewerStartedAt}ms`);
    io.stdout.write(`Viewer: ${url}\nPress Ctrl+C to stop the Viewer\n`);
  };
  progress?.start("Starting Results Viewer");
  const outcome = await dependencies.launchViewer({
    storeEnvironment,
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
    io.stderr.write("hurdle [viewer-disposal-unconfirmed] Viewer shutdown could not be confirmed. Check for a surviving Viewer process before restarting.\n");
    return 1;
  }
  if (outcome.reason === "port-in-use") {
    io.stderr.write(
      `hurdle [viewer-port-in-use] Port ${runtimeProfile.viewer.port} is already in use.\n`
      + `Open http://127.0.0.1:${runtimeProfile.viewer.port} if the Viewer is already running, `
      + "or stop that process and run this command again.\n",
    );
  } else if (outcome.reason === "viewer-lock-held") {
    io.stderr.write(
      "hurdle [viewer-lock-held] Another Viewer development server appears to be running from this checkout.\n"
      + "Stop that Viewer and run this command again. If no Viewer is running, remove the stale viewer/.next/dev/lock file.\n",
    );
  } else {
    io.stderr.write(
      "hurdle [viewer-failed] The Results Viewer could not be started. "
      + "Run `npm --prefix viewer run dev` to inspect the startup error.\n",
    );
  }
  return 1;
}

async function runCliMain(argv, io, dependencies) {
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
  if (["init", "validate", "run", "view"].includes(command) && hasHelpFlag(args)) {
    return help(command, io);
  }

  if (command === "init") {
    let directory = "evals", agent = "claude-code", directorySeen = false, agentSeen = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--agent" && !agentSeen) {
        agent = args[++index];
        agentSeen = true;
        if (!["claude-code", "codex"].includes(agent)) return argumentError("--agent must be claude-code or codex.", io).exitCode;
      } else if (!args[index].startsWith("-") && !directorySeen) {
        directory = args[index];
        directorySeen = true;
      } else {
        return argumentError("Use init [directory] [--agent claude-code|codex].", io).exitCode;
      }
    }
    const destination = resolve(io.cwd, directory);
    const result = await dependencies.initializeSuite({ destination, agent });
    if (!result.ok) {
      printDiagnostics(result.diagnostics, io);
      return 1;
    }
    const evalName = directory;
    io.stdout.write(`Created evaluation: ${evalName}\n`);
    io.stdout.write(`Suite: ${evalName}/example.suite.mjs\n`);
    io.stdout.write(`\nThe starter asks ${AGENT_LABELS[agent]} to copy a fixture into answer.txt.\nHurdle checks the exact contents and opens the results with --view.\n`);
    io.stdout.write(agent === "codex"
      ? "Requires Codex on PATH and CODEX_ACCESS_TOKEN, CODEX_API_KEY, or OPENAI_API_KEY.\n"
      : "Requires Claude Code on PATH and a valid ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.\n");
    io.stdout.write("Configure credentials in .env.local; your interactive login is not inherited.\n");
    const suiteArgument = evalName === "evals"
      ? ""
      : ` ${JSON.stringify(`${evalName}/example.suite.mjs`)}`;
    io.stdout.write(
      `\nNext:\n`
      + `  npx hurdle validate${suiteArgument}\n`
      + `  npx hurdle run${suiteArgument} --view\n`,
    );
    return 0;
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
    if (validation) {
      io.stdout.write(`Valid Suite: ${options.suite}\n`);
      io.stdout.write(`Tasks: ${selectedTaskIds.length}  Conditions: ${options.conditionIds.length || Object.keys(resolvedPlan.value.definition.conditions).length}\n`);
      if (options.offline) {
        io.stdout.write("Readiness: not checked (--offline). Run `npx hurdle validate` before an evaluation.\n");
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
      io.stderr.write(`hurdle [${error.code}] ${error.message}\n`);
      disposeAuthoredSuite();
      return 2;
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
      io.stderr.write(
        `hurdle [matrix-rejected] ${plannedCells} selected cells could not be executed.\n`,
      );
      for (const diagnostic of authoritySelection.diagnostics.slice(0, 10)) {
        io.stderr.write(`hurdle [${diagnostic.code}] ${diagnostic.message}\n`);
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
      io.stderr.write(`hurdle [${error.code}] ${error.message}\n`);
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
    io.stdout.write(`\nReadiness (${dependencies.environmentSource})\n`);
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
      io.stderr.write("hurdle [readiness-unavailable] Readiness checks could not complete. No evaluation started; check your setup and retry.\n");
      disposeAuthoredSuite();
      return 1;
    }
    for (const check of readiness.checks) {
      const symbol = { pass: "✓", fail: "✗", warning: "!" }[check.status];
      io.stdout.write(`${symbol} ${check.message}\n`);
    }
    if (!readiness.ok) {
      io.stderr.write("hurdle [not-ready] Resolve the setup errors above and run `npx hurdle validate` again. No evaluation started.\n");
      disposeAuthoredSuite();
      return 1;
    }
    if (validation) {
      io.stdout.write("Readiness checks passed. Model access, billing, and task success are checked during execution.\n");
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
        `\n${paintRunOutput("Hurdle", "cyan", useColor)}\n\n`
        + runFact("Plan", plan, { useColor })
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
      io.stderr.write("hurdle [store-unavailable] The configured Result Store could not be opened.\n");
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
      io.stderr.write(
        "hurdle [store-close-failed] The configured Result Store could not be closed cleanly.\n",
      );
      return 1;
    }
    if (executionFailed) {
      io.stderr.write("hurdle [run-failed] Evaluation setup or execution failed; resources were closed.\n");
      return 1;
    }
    if (result.status === "rejected") {
      io.stderr.write(
        `hurdle [matrix-rejected] ${result.summary.plannedCells} selected cells could not be executed.\n`,
      );
      for (const diagnostic of result.diagnostics.slice(0, 10)) {
        io.stderr.write(`hurdle [${diagnostic.code}] ${diagnostic.message}\n`);
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
    const viewerExitCode = await serveResolvedViewer(runtimeProfile, io, dependencies);
    return viewerExitCode === 0 ? runExitCode : viewerExitCode;
  }

  if (command === "view") {
    const parsed = parseViewArguments(args, io);
    if (!parsed.ok) return parsed.exitCode;
    let runtimeProfile;
    try {
      runtimeProfile = resolveRuntimeProfile({
        runtimePath: parsed.values.runtime ?? undefined,
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
      io.stderr.write(`hurdle [${error.code}] ${error.message}\n`);
      return 2;
    }
    return serveResolvedViewer(runtimeProfile, io, dependencies);
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
  const { environment, source } = loadProjectEnvironment(io.cwd);
  return createFrameworkCli({ env: environment, environmentSource: source }).main(argv, io);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "hurdle [internal-error] An unexpected internal error occurred.\n",
    );
    process.exitCode = 70;
  }
}
