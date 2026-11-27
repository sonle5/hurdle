import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DEFAULT_RUN_CONCURRENCY, normalizeRunConcurrency } from "./run-concurrency.mjs";
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  ANTHROPIC_JSON_JUDGE_ID,
  ANTHROPIC_JSON_JUDGE_MAX_INPUT_BYTES,
  ANTHROPIC_JSON_JUDGE_MAX_OUTPUT_BYTES,
  ANTHROPIC_JSON_JUDGE_MAX_TIMEOUT_MS,
} from "./judges/anthropic-json.mjs";
import { normalizeExchangeFactProfiles } from "./exchange-facts.mjs";
import { isAgentEffort } from "./agent-effort.mjs";

const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONDITION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]*$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?))+$/;
const ADAPTER_IDS = new Set(["claude-code", "codex", "dsh"]);
const VERDICTS = new Set(["code", "hybrid", "judge"]);

const JUDGE_PROJECTION = Object.freeze({
  schemaVersion: 2,
  include: Object.freeze({
    transcript: true,
    stderr: true,
    textArtifacts: false,
    egress: false,
    lifecycleReceipts: false,
    runTrustIssues: false,
    baselineDeterministicOutcome: false,
    effectiveDeterministicOutcome: false,
    requiredChecks: false,
    advisoryChecks: false,
  }),
  limits: Object.freeze({
    maxEvidenceItems: 64,
    maxEvidenceItemBytes: 64 * 1024,
    maxEvidenceTextBytes: 512 * 1024,
    maxChecks: 128,
    maxRunTrustIssues: 64,
    maxInputBytes: ANTHROPIC_JSON_JUDGE_MAX_INPUT_BYTES,
  }),
});

export class V1AuthoringError extends Error {
  constructor(code, message, file) {
    super(message);
    this.name = "V1AuthoringError";
    this.code = code;
    this.file = file;
  }
}

export function defineSuite(suite) {
  return suite;
}

export function defineChecks(checks) {
  return checks;
}

export function defineGuard(guard) {
  return guard;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fingerprintDefinition(definition) {
  const bytes = JSON.stringify(canonicalize({
    kind: "tae.run-plan-definition",
    fingerprintVersion: 1,
    definition,
  }));
  return sha256(bytes);
}

function compiledFile(root, path) {
  const absolutePath = join(root, ...path.split("/"));
  const bytes = readFileSync(absolutePath);
  return Object.freeze({
    path,
    absolutePath,
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

function compileRunPlan({ root, sourcePath, definition, fixturePaths, behaviorGraphs }) {
  const behaviorPaths = [...new Set(Object.values(behaviorGraphs).flat())].sort();
  const conditionFiles = Object.values(definition.conditions)
    .flatMap(({ resources }) => resources.skills.flatMap(({ files }) => files));
  const referencedPaths = [...new Set([
    ...fixturePaths,
    ...behaviorPaths,
    ...conditionFiles.map(({ path }) => path),
  ])].sort();
  const files = referencedPaths.map((path) => compiledFile(root, path));
  const filesByPath = Object.fromEntries(files.map(({ path, absolutePath }) => [path, absolutePath]));
  const hashes = Object.fromEntries(files.map(({ path, sha256: digest }) => [path, digest]));
  const normalized = deepFreeze({
    ...structuredClone(definition),
    referencedContent: {
      fixtures: Object.fromEntries(fixturePaths.sort().map((path) => [path, hashes[path]])),
      behaviorModules: Object.fromEntries(behaviorPaths.map((path) => [path, hashes[path]])),
      conditionResources: Object.fromEntries(
        conditionFiles.map(({ path }) => [path, hashes[path]]).sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
  });
  return deepFreeze({
    sourceRoot: root,
    sourcePath,
    filesByPath,
    definition: normalized,
    definitionFingerprint: fingerprintDefinition(normalized),
    behaviorGraphsByEntry: structuredClone(behaviorGraphs),
  });
}

function fail(code, message, file) {
  throw new V1AuthoringError(code, message, file);
}

// Generated modules keep the author's line numbers, so the stack names the
// failing line. Report that line and whether it is a syntax error, never the
// error text.
function failModule(code, message, syntaxMessage, file, error, sources) {
  const stack = String(error?.stack ?? "");
  let located = null;
  for (const [generated, source] of sources) {
    for (const href of new Set([generated, realpathSync(generated)].map((path) => pathToFileURL(path).href))) {
      const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`${escaped}(?:\\?[^:\\s]*)?:(\\d+)`).exec(stack);
      if (match) { located = { file: source, line: Number(match[1]) }; break; }
    }
    if (located) break;
    // Node keeps a syntax error's location out of its stack; node --check
    // prints it on the first line of its output.
    if (error?.name === "SyntaxError") {
      const checked = spawnSync(process.execPath, ["--check", generated], { encoding: "utf8", timeout: 10_000 });
      const line = /:(\d+)\s*$/.exec(String(checked.stderr ?? "").split("\n")[0] ?? "");
      if (checked.status !== 0 && line) { located = { file: source, line: Number(line[1]) }; break; }
    }
  }
  const failure = new V1AuthoringError(code, error?.name === "SyntaxError" ? syntaxMessage : message, located?.file ?? file);
  if (located) failure.pointer = located.line;
  throw failure;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertClosedKeys(value, allowed, label, file) {
  if (!plainObject(value)) fail("suite.invalid", `${label} must be an object.`, file);
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) {
    fail("suite.invalid", `${label} contains unknown field '${unexpected}'.`, file);
  }
}

function rewriteAuthoringImport(source, runtimeSpecifier, file) {
  const rewritten = source.replace(
    /(from\s+)(["'])(?:hurdle|@nutlope\/tae|tae)\2/g,
    `$1${JSON.stringify(runtimeSpecifier)}`,
  );
  if (rewritten === source) {
    fail(
      "authoring.import-missing",
      `${basename(file)} must import its define helper from 'hurdle'.`,
      file,
    );
  }
  const imports = [...rewritten.matchAll(/(?:from\s+|import\s*)(["'])([^"']+)\1/g)]
    .map((match) => match[2]);
  if (imports.some((specifier) => specifier !== runtimeSpecifier)) {
    fail(
      "authoring.import-unsupported",
      `${basename(file)} may only import the v1 authoring helpers in this release.`,
      file,
    );
  }
  return rewritten;
}

function listFixtureFiles(root, current = root) {
  if (current === root) {
    const rootStats = lstatSync(root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      fail("task.fixtures-invalid", "Task fixtures must be a regular directory.", root);
    }
  }
  const files = [];
  let entries;
  try { entries = readdirSync(current, { withFileTypes: true }); }
  catch { fail("task.fixture-unreadable", "Task fixtures must be readable.", current); }
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      fail("task.fixture-symlink", "Task fixtures may not contain symbolic links.", absolute);
    }
    if (entry.isDirectory()) files.push(...listFixtureFiles(root, absolute));
    else if (entry.isFile()) {
      try { accessSync(absolute, fsConstants.R_OK); }
      catch { fail("task.fixture-unreadable", "Task fixtures must be readable.", absolute); }
      files.push(relative(root, absolute));
    } else fail("task.fixture-invalid", "Task fixtures must be regular files.", absolute);
  }
  return files.sort();
}

function resolveTaskDirectory(suiteRoot, taskReference, suiteFile) {
  if (typeof taskReference !== "string" || !taskReference.startsWith("./")) {
    fail("suite.task-invalid", "Suite tasks must be relative './path' references.", suiteFile);
  }
  const taskRoot = resolve(suiteRoot, taskReference);
  const relativePath = relative(suiteRoot, taskRoot);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    fail("suite.task-outside-root", "Suite tasks must stay within the Suite directory.", suiteFile);
  }
  let realTaskRoot;
  try {
    realTaskRoot = realpathSync(taskRoot);
  } catch {
    fail("suite.task-missing", `Task directory '${taskReference}' does not exist.`, suiteFile);
  }
  const realSuiteRoot = realpathSync(suiteRoot);
  const realRelativePath = relative(realSuiteRoot, realTaskRoot);
  if (realRelativePath === ".." || realRelativePath.startsWith(`..${sep}`)) {
    fail("suite.task-outside-root", "Suite task paths must remain inside the Suite directory.", suiteFile);
  }
  const taskStats = lstatSync(taskRoot);
  if (taskStats.isSymbolicLink() || !taskStats.isDirectory()) {
    fail("suite.task-symlink", `Task directory '${taskReference}' may not be a symbolic link.`, suiteFile);
  }
  return taskRoot;
}

function readRegularText(path, missingCode, missingMessage) {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new TypeError("not a regular file");
    return readFileSync(path, "utf8");
  } catch {
    fail(missingCode, missingMessage, path);
  }
}

function readOptionalRegularText(path, invalidCode, invalidMessage) {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new TypeError("not a regular file");
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail(invalidCode, invalidMessage, path);
  }
}

function validateApi(value, label, file) {
  assertClosedKeys(value, ["authorizationCredential", "hosts"], label, file);
  if (!CREDENTIAL_NAME.test(value.authorizationCredential)) {
    fail(
      "suite.api-invalid",
      `${label} authorizationCredential must be an uppercase environment name.`,
      file,
    );
  }
  if (
    !Array.isArray(value.hosts)
    || value.hosts.length === 0
    || value.hosts.length > 16
    || value.hosts.some((host) => typeof host !== "string" || !HOST.test(host))
    || new Set(value.hosts).size !== value.hosts.length
  ) {
    fail("suite.api-invalid", `${label} hosts must be 1-16 unique exact HTTPS hosts.`, file);
  }
  return Object.freeze({
    authorizationCredential: value.authorizationCredential,
    hosts: Object.freeze([...value.hosts]),
  });
}

function validateConditionResources(value, conditionId, file) {
  assertClosedKeys(value, ["skills", "mcpServers"], `Suite Condition '${conditionId}'`, file);
  const declaredSkills = value.skills === undefined ? [] : value.skills;
  const declaredMcpServers = value.mcpServers === undefined ? [] : value.mcpServers;
  if (!Array.isArray(declaredSkills) || !Array.isArray(declaredMcpServers)) {
    fail("suite.conditions-invalid", "Suite Condition resources require skills and mcpServers arrays.", file);
  }
  const skills = declaredSkills.map((skill, index) => {
    assertClosedKeys(skill, ["name", "sourceDirectory"], `Suite skill ${index + 1}`, file);
    if (
      typeof skill.name !== "string"
      || !TASK_ID.test(skill.name)
      || typeof skill.sourceDirectory !== "string"
      || !skill.sourceDirectory
      || skill.sourceDirectory.startsWith("/")
      || skill.sourceDirectory.includes("\\")
      || skill.sourceDirectory.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      fail("suite.conditions-invalid", "Suite Skill Resources must use safe names and relative directories.", file);
    }
    return Object.freeze({ name: skill.name, sourceDirectory: skill.sourceDirectory });
  });
  const mcpServers = declaredMcpServers.map((server, index) => {
    assertClosedKeys(server, ["id", "transport"], `Suite MCP Server ${index + 1}`, file);
    if (typeof server.id !== "string" || !TASK_ID.test(server.id)) {
      fail("suite.conditions-invalid", "Suite MCP Server ids must use lowercase kebab-case.", file);
    }
    assertClosedKeys(server.transport, ["kind", "url"], "Suite MCP transport", file);
    if (server.transport.kind !== "http") {
      fail("suite.conditions-invalid", "Suite MCP transport kind must be 'http'.", file);
    }
    try {
      const url = new URL(server.transport.url);
      if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || url.search
        || url.hash
      ) throw new TypeError("invalid URL");
    } catch {
      fail("suite.conditions-invalid", "Suite MCP URLs must be credential-free absolute HTTPS URLs.", file);
    }
    return Object.freeze({
      id: server.id,
      transport: Object.freeze({ kind: "http", url: server.transport.url }),
    });
  });
  return Object.freeze({ skills: Object.freeze(skills), mcpServers: Object.freeze(mcpServers) });
}

function validateSuite(suite, suiteFile) {
  assertClosedKeys(
    suite,
    ["api", "tasks", "agents", "conditions", "repeats", "concurrency", "verdict", "judge"],
    "Suite",
    suiteFile,
  );
  if (!Array.isArray(suite.tasks) || suite.tasks.length === 0) {
    fail("suite.tasks-invalid", "Suite tasks must be a nonempty array.", suiteFile);
  }
  let api = null;
  if (suite.api !== undefined) {
    api = validateApi(suite.api, "Suite api", suiteFile);
  }
  if (!Array.isArray(suite.agents) || suite.agents.length === 0) {
    fail("suite.agents-invalid", "Suite agents must be a nonempty array.", suiteFile);
  }
  const agents = suite.agents.map((agent, index) => {
    assertClosedKeys(agent, ["runner", "model", "effort"], `Suite agent ${index + 1}`, suiteFile);
    if (!ADAPTER_IDS.has(agent.runner)) {
      fail("suite.agent-invalid", "Suite agent runner must be 'claude-code', 'codex', or 'dsh'.", suiteFile);
    }
    if (agent.model !== null && agent.model !== undefined && (
      typeof agent.model !== "string" || !agent.model.trim()
    )) {
      fail("suite.agent-invalid", "Suite agent model must be null or a nonblank string.", suiteFile);
    }
    if (agent.effort !== undefined && !isAgentEffort(agent.effort)) {
      fail("suite.agent-invalid", "Suite agent effort must be low, medium, high, xhigh, or max.", suiteFile);
    }
    return Object.freeze({
      adapterId: agent.runner,
      requestedModel: agent.model?.trim() ?? null,
      settings: Object.freeze(agent.effort === undefined ? {} : { effort: agent.effort }),
    });
  });
  if (new Set(agents.map((agent) => JSON.stringify(agent))).size !== agents.length) {
    fail("suite.agent-duplicate", "Suite agents must be unique.", suiteFile);
  }
  const declaredConditions = suite.conditions === undefined
    ? { baseline: {} }
    : suite.conditions;
  if (!plainObject(declaredConditions) || Object.keys(declaredConditions).length === 0) {
    fail("suite.conditions-invalid", "Suite conditions must be a nonempty object.", suiteFile);
  }
  const conditions = Object.fromEntries(Object.entries(declaredConditions).map(([condition, resources]) => {
    if (!CONDITION_ID.test(condition)) {
      fail("suite.condition-invalid", "Suite Condition ids must use lowercase kebab-case.", suiteFile);
    }
    return [condition, validateConditionResources(resources, condition, suiteFile)];
  }));
  const repeats = suite.repeats === undefined ? 1 : suite.repeats;
  let concurrency;
  try { concurrency = normalizeRunConcurrency(suite.concurrency === undefined ? DEFAULT_RUN_CONCURRENCY : suite.concurrency); }
  catch { fail("suite.concurrency-invalid", "Suite concurrency must be an integer between 1 and 100.", suiteFile); }
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100) {
    fail("suite.repeats-invalid", "Suite repeats must be an integer between 1 and 100.", suiteFile);
  }
  if (!VERDICTS.has(suite.verdict)) {
    fail("suite.verdict-unsupported", "Suite verdict must be 'code', 'hybrid', or 'judge'.", suiteFile);
  }
  let judge = null;
  if (suite.verdict === "code") {
    if (suite.judge !== undefined) {
      fail("suite.judge-unexpected", "A code verdict does not use Suite judge configuration.", suiteFile);
    }
  } else {
    assertClosedKeys(suite.judge, ["model"], "Suite judge", suiteFile);
    if (typeof suite.judge.model !== "string" || !suite.judge.model.trim()) {
      fail("suite.judge-invalid", "Suite judge model must be a nonblank string.", suiteFile);
    }
    judge = Object.freeze({ model: suite.judge.model.trim() });
  }
  return Object.freeze({
    api,
    agents,
    conditions: Object.freeze(conditions),
    repeats,
    concurrency,
    verdict: suite.verdict,
    judge,
  });
}

function authorityProfile(suite) {
  const profileId = `v1-${suite.verdict}`;
  return {
    schemaVersion: suite.verdict === "hybrid" ? 2 : 1,
    id: profileId,
    kind: {
      code: "deterministic-primary",
      hybrid: "hybrid",
      judge: "judge-primary",
    }[suite.verdict],
    checkPolicy: {
      defaultRule: suite.verdict === "judge" ? "advisory" : "authored",
    },
    judge: suite.verdict === "code"
      ? { availability: "disabled" }
      : {
          availability: "required",
          capability: {
            judgeId: ANTHROPIC_JSON_JUDGE_ID,
            model: suite.judge.model,
            inputSchemaVersion: 2,
          },
          timeoutMs: ANTHROPIC_JSON_JUDGE_MAX_TIMEOUT_MS,
          projection: structuredClone(JUDGE_PROJECTION),
          output: { maxSummaryBytes: ANTHROPIC_JSON_JUDGE_MAX_OUTPUT_BYTES },
        },
  };
}

function nativeToolExchangeProfile(path) {
  const sha = (id, pointer, maxInputBytes, maxMatches = 16) => ({
    id,
    pointer,
    maxMatches,
    projection: { kind: "sha256-string", maxInputBytes },
  });
  return {
    id: "v1-native-tool-calls",
    match: { method: "POST", paths: [path], statusCodes: [200] },
    requestJson: [
      sha("request-assistant-call-id-hashes", "/messages/*/tool_calls/*/id", 256),
      sha("request-assistant-call-argument-hashes", "/messages/*/tool_calls/*/function/arguments", 8192),
      sha("request-tool-result-call-id-hashes", "/messages/*/tool_call_id", 256),
    ],
    responseJson: [
      sha("response-tool-call-id-hashes", "/choices/*/message/tool_calls/*/id", 256),
      sha("response-tool-call-name-hashes", "/choices/*/message/tool_calls/*/function/name", 128),
      sha("response-tool-call-argument-hashes", "/choices/*/message/tool_calls/*/function/arguments", 8192),
    ],
  };
}

export async function resolveV1Suite({ suitePath }) {
  const suiteFile = resolve(suitePath);
  if (!suiteFile.endsWith(".suite.mjs")) {
    fail(
      "suite.extension-unsupported",
      "Suite files must use the .suite.mjs extension.",
      suiteFile,
    );
  }
  const generatedRoot = mkdtempSync(join(tmpdir(), "hurdle-v1-pack-"));
  try {
    writeFileSync(
      join(generatedRoot, "hurdle-authoring.mjs"),
      "export const defineSuite = (value) => value; export const defineChecks = (value) => value; export const defineGuard = (value) => value;\n",
    );
    const suiteSource = readRegularText(
      suiteFile,
      "suite.file-invalid",
      "Suite source must be a regular readable file.",
    );
    const generatedSuite = join(generatedRoot, "suite.mjs");
    writeFileSync(
      generatedSuite,
      rewriteAuthoringImport(suiteSource, "./hurdle-authoring.mjs", suiteFile),
    );
    let imported;
    try {
      imported = await import(`${pathToFileURL(generatedSuite).href}?v=${Date.now()}`);
    } catch (error) {
      failModule("suite.module-invalid", "Suite source could not be evaluated.", "Suite source has a syntax error.", suiteFile, error, [[generatedSuite, suiteFile]]);
    }
    const validated = validateSuite(imported.default, suiteFile);
    const suiteRoot = dirname(suiteFile);
    const profile = authorityProfile(validated);
    const fixturePaths = [];
    const behaviorGraphs = {};
    const definition = {
      schemaVersion: 2,
      target: {
        id: validated.api ? "api-target" : "v1-suite",
        displayName: validated.api ? "API Target" : "Hurdle Suite",
        ...(validated.api ? {
          egress: {
            relevantHosts: [...validated.api.hosts],
            selectedFields: [],
          },
        } : {}),
      },
      credentialRequirements: validated.api ? {
        [validated.api.authorizationCredential]: {
          minimumScopes: ["api"],
          delivery: { kind: "environment" },
        },
      } : {},
      conditions: Object.fromEntries(Object.entries(validated.conditions).map(([id, resources]) => [id, {
        displayName: id === "default" ? "Default" : id,
        resources: structuredClone(resources),
      }])),
      authorityProfiles: [profile],
      tasks: {},
    };
    const taskIds = [];
    mkdirSync(join(generatedRoot, "tasks"), { recursive: true });
    mkdirSync(join(generatedRoot, "evaluators"), { recursive: true });
    for (const [conditionId, resources] of Object.entries(validated.conditions)) {
      if (resources.skills.length > 0 || resources.mcpServers.length > 0) {
        definition.conditions[conditionId].executionRequirements = ["agent.selected-context"];
      }
      for (const skill of resources.skills) {
        const sourceRoot = resolve(suiteRoot, skill.sourceDirectory);
        const fromSuite = relative(suiteRoot, sourceRoot);
        let validSkillRoot = false;
        try {
          const stats = lstatSync(sourceRoot);
          const realSourceRoot = realpathSync(sourceRoot);
          const realFromSuite = relative(realpathSync(suiteRoot), realSourceRoot);
          validSkillRoot = fromSuite !== ".."
            && !fromSuite.startsWith(`..${sep}`)
            && realFromSuite !== ".."
            && !realFromSuite.startsWith(`..${sep}`)
            && !stats.isSymbolicLink()
            && stats.isDirectory();
        } catch {}
        if (!validSkillRoot) {
          fail(
            "suite.skill-invalid",
            `Skill '${skill.name}' must be a regular directory inside the Suite.`,
            suiteFile,
          );
        }
        const skillFiles = listFixtureFiles(sourceRoot);
        cpSync(sourceRoot, join(generatedRoot, skill.sourceDirectory), { recursive: true });
        const compiledSkill = definition.conditions[conditionId].resources.skills
          .find(({ name }) => name === skill.name);
        compiledSkill.files = skillFiles.map((relativePath) => {
          const file = compiledFile(generatedRoot, `${skill.sourceDirectory}/${relativePath}`);
          return {
            path: file.path,
            relativePath,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
          };
        });
      }
      definition.conditions[conditionId].executionRequirements ??= [];
    }
    const generatedRuntime = join(generatedRoot, "evaluators", "runtime.mjs");
    cpSync(new URL("./v1-evaluator-runtime.mjs", import.meta.url), generatedRuntime);
    const evaluatorRuntime = await import(pathToFileURL(generatedRuntime).href);
    for (const taskReference of imported.default.tasks) {
      const taskRoot = resolveTaskDirectory(suiteRoot, taskReference, suiteFile);
      const taskId = basename(taskRoot);
      if (!TASK_ID.test(taskId) || taskIds.includes(taskId)) {
        fail("task.id-invalid", "Task directory names must be unique lowercase kebab-case ids.", taskRoot);
      }
      if (existsSync(join(taskRoot, "task.json"))) {
        fail(
          "task.config-unsupported",
          "task.json is not supported by the v1 facade; declare API and Condition resources in the Suite.",
          join(taskRoot, "task.json"),
        );
      }
      if (existsSync(join(taskRoot, "rubric.md"))) {
        fail(
          "task.rubric-unsupported",
          "rubric.md is not supported by the v1 facade; declare the rubric with run.judge().",
          join(taskRoot, "rubric.md"),
        );
      }
      const promptFile = join(taskRoot, "prompt.md");
      const checksFile = join(taskRoot, "checks.mjs");
      const guardFile = join(taskRoot, "guard.mjs");
      const prompt = readRegularText(
        promptFile,
        "task.prompt-invalid",
        "Each Task requires a regular prompt.md file.",
      );
      const checksSource = readRegularText(
        checksFile,
        "task.checks-invalid",
        "Each Task requires a regular checks.mjs file.",
      );
      const guardSource = readOptionalRegularText(
        guardFile,
        "task.guard-invalid",
        "Task guard.mjs must be a regular readable file.",
      );
      if (!prompt.trim()) fail("task.prompt-empty", "Task prompt.md must be nonblank.", promptFile);
      const generatedTaskRoot = join(generatedRoot, "tasks", taskId);
      mkdirSync(generatedTaskRoot, { recursive: true });
      const fixtureRoot = join(taskRoot, "fixtures");
      let fixtureFiles = [];
      if (existsSync(fixtureRoot)) {
        fixtureFiles = listFixtureFiles(fixtureRoot);
        cpSync(fixtureRoot, join(generatedTaskRoot, "fixtures"), { recursive: true });
      }
      const workspaceRoot = join(taskRoot, "workspace");
      let workspaceFiles = [];
      if (existsSync(workspaceRoot)) {
        workspaceFiles = listFixtureFiles(workspaceRoot);
        cpSync(workspaceRoot, join(generatedTaskRoot, "workspace"), { recursive: true });
      }
      const stagedFixtures = [
        ...fixtureFiles.map((path) => ({
          source: `tasks/${taskId}/fixtures/${path}`,
          workspacePath: `fixtures/${path}`,
        })),
        ...workspaceFiles.map((path) => ({
          source: `tasks/${taskId}/workspace/${path}`,
          workspacePath: path,
        })),
      ];
      fixturePaths.push(...stagedFixtures.map(({ source }) => source));
      if (new Set(stagedFixtures.map(({ workspacePath }) => workspacePath)).size !== stagedFixtures.length) {
        fail(
          "task.fixture-collision",
          "Task fixtures and workspace files must not resolve to the same Agent path.",
          taskRoot,
        );
      }
      const generatedChecks = join(generatedRoot, "evaluators", `${taskId}-checks.mjs`);
      writeFileSync(
        generatedChecks,
        rewriteAuthoringImport(checksSource, "../hurdle-authoring.mjs", checksFile),
      );
      const generatedGuard = guardSource === null
        ? null
        : join(generatedRoot, "evaluators", `${taskId}-guard.mjs`);
      if (generatedGuard !== null) {
        writeFileSync(
          generatedGuard,
          rewriteAuthoringImport(guardSource, "../hurdle-authoring.mjs", guardFile),
        );
      }
      let declarations;
      try {
        const checksModule = await import(pathToFileURL(generatedChecks).href);
        if (typeof checksModule.default !== "function") throw new TypeError("invalid checks export");
        let guard = null;
        if (generatedGuard !== null) {
          const guardModule = await import(pathToFileURL(generatedGuard).href);
          if (typeof guardModule.default !== "function") throw new TypeError("invalid guard export");
          guard = guardModule.default;
        }
        declarations = evaluatorRuntime.collectTaskDeclarations(checksModule.default, guard);
      } catch (error) {
        failModule(
          guardSource === null ? "task.checks-invalid" : "task.behavior-invalid",
          guardSource === null
            ? "Task checks could not be evaluated."
            : "Task checks or guard could not be evaluated.",
          "Task code has a syntax error.",
          guardSource === null ? checksFile : taskRoot,
          error,
          [[generatedChecks, checksFile], ...(generatedGuard === null ? [] : [[generatedGuard, guardFile]])],
        );
      }
      const rubric = validated.verdict === "code" ? null : declarations.rubric;
      if (validated.verdict !== "code" && rubric === null) {
        fail(
          "task.rubric-missing",
          "Judge and hybrid Tasks must declare one rubric with run.judge().",
          checksFile,
        );
      }
      if (
        (
          declarations.requests.length > 0
          || declarations.blockedRequests.length > 0
          || declarations.tools.length > 0
        )
        && !validated.api
      ) {
        fail(
          "task.api-missing",
          "HTTP expectations and guards require Suite api configuration.",
          declarations.blockedRequests.length > 0 ? guardFile : checksFile,
        );
      }
      const usesApi = validated.api !== null;
      const requiresTrustedEgress = declarations.requests.some(({ required }) => required)
        || declarations.tools.some(({ required }) => required)
        || declarations.blockedRequests.length > 0;
      const judgeOnly = validated.verdict === "judge" && !declarations.hasDeterministicChecks;
      if (!judgeOnly) {
        const evaluatorImports = [
          `import checks from ${JSON.stringify(`./${taskId}-checks.mjs`)};`,
          ...(generatedGuard === null
            ? []
            : [`import guard from ${JSON.stringify(`./${taskId}-guard.mjs`)};`]),
          'import { evaluateChecks } from "./runtime.mjs";',
        ];
        writeFileSync(
          join(generatedRoot, "evaluators", `${taskId}.mjs`),
          [
            ...evaluatorImports,
            `export function evaluate(input) { return evaluateChecks(checks, input${generatedGuard === null ? "" : ", guard"}); }`,
            "",
          ].join("\n"),
        );
        behaviorGraphs[`evaluators/${taskId}.mjs`] = [
          `evaluators/${taskId}-checks.mjs`,
          ...(generatedGuard === null ? [] : [`evaluators/${taskId}-guard.mjs`]),
          `evaluators/${taskId}.mjs`,
          "evaluators/runtime.mjs",
          "hurdle-authoring.mjs",
        ].sort();
      }
      definition.tasks[taskId] = {
        prompt,
        fixtures: stagedFixtures,
        ...(declarations.artifacts.length > 0 ? {
          outputArtifacts: declarations.artifacts.map((artifact) => ({
            path: artifact.path,
            kind: "text",
            maxBytes: artifact.maxBytes,
            required: artifact.required,
          })),
        } : {}),
        credentialRequirements: usesApi ? [validated.api.authorizationCredential] : [],
        ...(usesApi && requiresTrustedEgress ? {
          credentialDeliveryOverrides: {
            [validated.api.authorizationCredential]: {
              kind: "captured-http-header",
              hosts: [...validated.api.hosts],
              headerNames: ["authorization"],
            },
          },
        } : {}),
        ...(usesApi ? {
          egress: {
            ...(!requiresTrustedEgress ? { captureMode: "optional" } : {}),
            relevantHosts: [...validated.api.hosts],
            selectedFields: [],
            protocols: ["https"],
            ...(declarations.blockedRequests.length > 0 ? {
              blockedRequests: declarations.blockedRequests.map(({ id, method, path }) => ({
                id,
                method,
                path,
              })),
            } : {}),
            ...(declarations.tools.length > 0 ? {
              exchangeFactProfiles: [nativeToolExchangeProfile(declarations.tools[0].request.path)],
            } : {}),
          },
          executionRequirements: [
            "environment.isolated-workspace",
            ...(requiresTrustedEgress ? ["environment.trusted-egress-capture"] : []),
            ...(declarations.blockedRequests.length > 0
              ? ["environment.trusted-request-blocking"]
              : []),
          ],
        } : {}),
        evaluation: {
          ...(judgeOnly ? {} : { deterministicEvaluator: `evaluators/${taskId}.mjs` }),
          authority: {
            defaultProfileId: profile.id,
            bindings: [{
              profileId: profile.id,
              ...(rubric === null ? {} : { rubric }),
              checkRules: [],
            }],
          },
        },
      };
      taskIds.push(taskId);
    }
    for (const credential of Object.values(definition.credentialRequirements)) {
      credential.minimumScopes.sort();
      credential.delivery ??= { kind: "environment" };
    }
    definition.authorityProfiles.sort((left, right) => left.id.localeCompare(right.id));
    definition.target.egress ??= { relevantHosts: [], selectedFields: [] };
    definition.target.egress.relevantHosts.sort();
    definition.target.egress.selectedFields.sort();
    for (const task of Object.values(definition.tasks)) {
      task.credentialRequirements.sort();
      task.executionRequirements?.sort();
      task.fixtures.sort((left, right) => left.workspacePath.localeCompare(right.workspacePath));
      task.outputArtifacts?.sort((left, right) => left.path.localeCompare(right.path));
      if (task.egress?.exchangeFactProfiles) {
        task.egress.exchangeFactProfiles = normalizeExchangeFactProfiles(task.egress.exchangeFactProfiles);
      }
      task.egress?.blockedRequests?.sort((left, right) => (
        left.id.localeCompare(right.id)
        || left.method.localeCompare(right.method)
        || left.path.localeCompare(right.path)
      ));
    }
    const value = compileRunPlan({
      root: generatedRoot,
      sourcePath: suiteFile,
      definition,
      fixturePaths,
      behaviorGraphs,
    });
    return {
      ok: true,
      value,
      defaults: Object.freeze({
        taskIds: Object.freeze(taskIds),
        conditionIds: Object.freeze(Object.keys(validated.conditions)),
        agentSelections: Object.freeze([...validated.agents]),
        repeat: validated.repeats,
        concurrency: validated.concurrency,
      }),
      generatedRoot,
      dispose: () => rmSync(generatedRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(generatedRoot, { recursive: true, force: true });
    throw error;
  }
}
