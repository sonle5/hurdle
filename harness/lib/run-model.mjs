import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveAuthoritySelections } from "./authority-profile.mjs";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function fingerprintSnapshot(snapshot) {
  const preimage = {
    kind: "tae.run-definition-snapshot",
    fingerprintVersion: snapshot.schemaVersion,
    snapshot,
  };
  return sha256(Buffer.from(JSON.stringify(canonicalize(preimage))));
}

const INPUT_PATH_ERROR_CODES = new Set([
  "EACCES",
  "EISDIR",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

function isInputPathError(error) {
  return INPUT_PATH_ERROR_CODES.has(error?.code);
}

export class RunDefinitionInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunDefinitionInputError";
    this.code = "RUN_DEFINITION_INPUT_INVALID";
  }
}

export class RunSelectionInputError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "RunSelectionInputError";
    this.code = "RUN_SELECTION_INPUT_INVALID";
  }
}

export function selectDefinitionIds(definitions, requested, label) {
  if (requested === undefined) return Object.keys(definitions);
  const requestedIds = Array.isArray(requested) ? requested : [requested];
  if (requestedIds.length === 0) {
    throw new RunSelectionInputError(`${label} selection must not be empty`);
  }
  const selected = new Set();
  for (const requestedId of requestedIds) {
    if (typeof requestedId !== "string" || !Object.hasOwn(definitions, requestedId)) {
      throw new RunSelectionInputError(`${label} '${requestedId}' does not exist`);
    }
    if (selected.has(requestedId)) {
      throw new RunSelectionInputError(`${label} '${requestedId}' is selected more than once`);
    }
    selected.add(requestedId);
  }
  return Object.keys(definitions).filter((id) => selected.has(id));
}

function selectedId(definitions, requestedId, label) {
  const ids = selectDefinitionIds(definitions, requestedId, label);
  if (ids.length !== 1) {
    throw new TypeError(`${label} must resolve to exactly one definition`);
  }
  return ids[0];
}

function capabilityFromResolvedAuthority(authority) {
  if (authority?.judge?.availability !== "required") return null;
  return {
    judgeId: authority.judge.capability.judgeId,
    model: authority.judge.capability.model,
    inputSchemaVersions: [authority.judge.capability.inputSchemaVersion],
    maxTimeoutMs: authority.judge.timeoutMs,
    maxInputBytes: authority.judge.projection.limits.maxInputBytes,
    maxOutputBytes: authority.judge.output.maxSummaryBytes,
    requestProtocols: authority.judge.capability.requestProtocol
      ? [structuredClone(authority.judge.capability.requestProtocol)]
      : [],
  };
}

function assertResolvedAuthorityMatches(definition, taskId, authority) {
  let expected;
  try {
    expected = resolveAuthoritySelections({
      definition,
      selectedTaskIds: [taskId],
      ...(definition.schemaVersion === 2 && authority
        ? { authorityProfileId: authority.id }
        : {}),
      legacyJudging: definition.schemaVersion === 1
        && authority?.judge?.availability === "disabled"
        ? "disabled"
        : "task",
      judgeCapability: capabilityFromResolvedAuthority(authority),
    });
  } catch {
    expected = { ok: false };
  }
  const expectedAuthority = expected.ok
    ? expected.value.byTaskId[taskId]
    : undefined;
  if (
    expectedAuthority === undefined
    || JSON.stringify(canonicalize(expectedAuthority))
      !== JSON.stringify(canonicalize(authority))
  ) {
    throw new RunSelectionInputError(
      "resolvedAuthority does not match the selected Target definition",
    );
  }
}

async function readVerifiedFile(
  runPlan,
  relativePath,
  expectedHash,
  { maxBytes } = {},
) {
  const absolutePath = runPlan.filesByPath[relativePath];
  if (!absolutePath) {
    throw new RunDefinitionInputError(
      `Resolved RunPlan has no locator for '${relativePath}'`,
    );
  }
  let currentPath = runPlan.sourceRoot;
  let rootStat;
  try {
    rootStat = await lstat(currentPath);
  } catch (error) {
    if (isInputPathError(error)) {
      throw new RunDefinitionInputError(
        `Selected RunPlan input '${relativePath}' is no longer reachable`,
      );
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new RunDefinitionInputError(
      `Selected RunPlan input '${relativePath}' contains a symlink`,
    );
  }
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    let stat;
    try {
      stat = await lstat(currentPath);
    } catch (error) {
      if (isInputPathError(error)) {
        throw new RunDefinitionInputError(
          `Selected RunPlan input '${relativePath}' is no longer reachable`,
        );
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new RunDefinitionInputError(
        `Selected RunPlan input '${relativePath}' contains a symlink`,
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new RunDefinitionInputError(
        `Selected RunPlan input '${relativePath}' is no longer reachable`,
      );
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new RunDefinitionInputError(
        `Selected RunPlan input '${relativePath}' is no longer a regular file`,
      );
    }
  }
  if (currentPath !== absolutePath) {
    throw new RunDefinitionInputError(
      `Resolved RunPlan locator for '${relativePath}' changed`,
    );
  }
  let bytes;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    if (isInputPathError(error)) {
      throw new RunDefinitionInputError(
        `Selected RunPlan input '${relativePath}' is no longer readable`,
      );
    }
    throw error;
  }
  if (Number.isSafeInteger(maxBytes) && bytes.byteLength > maxBytes) {
    throw new RunDefinitionInputError(
      `Selected RunPlan input '${relativePath}' exceeds its ${maxBytes}-byte limit`,
    );
  }
  if (sha256(bytes) !== expectedHash) {
    throw new RunDefinitionInputError(
      `Selected RunPlan input '${relativePath}' changed after resolution`,
    );
  }
  return bytes;
}

async function pinBytes(pinRoot, category, relativePath, bytes) {
  const destination = join(pinRoot, category, ...relativePath.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  return destination;
}

export async function prepareRunDefinition({
  runPlan,
  taskId,
  conditionId,
  adapterId,
  agentSettings,
  environmentId,
  environmentSettings,
  pinRoot,
  resolvedAuthority,
  authorityProfileId,
  legacyJudging = "task",
  judgeCapability = null,
}) {
  const definition = runPlan?.definition;
  if (!definition || !runPlan.filesByPath) {
    throw new TypeError("runPlan must be a Resolved RunPlan");
  }
  if (resolvedAuthority !== undefined && authorityProfileId !== undefined) {
    throw new RunSelectionInputError(
      "resolvedAuthority and authorityProfileId cannot be combined",
    );
  }
  const selectedTaskId = selectedId(definition.tasks, taskId, "Task");
  const selectedConditionId = selectedId(
    definition.conditions,
    conditionId,
    "Condition",
  );
  const task = definition.tasks[selectedTaskId];
  const condition = definition.conditions[selectedConditionId];
  let authority = resolvedAuthority;
  if (authority === undefined) {
    const authoritySelection = resolveAuthoritySelections({
      definition,
      selectedTaskIds: [selectedTaskId],
      authorityProfileId,
      legacyJudging,
      judgeCapability,
    });
    if (!authoritySelection.ok) {
      const error = new RunSelectionInputError(
        authoritySelection.diagnostics[0]?.message
          ?? "Authority Profile selection is invalid",
      );
      error.diagnostics = authoritySelection.diagnostics;
      throw error;
    }
    authority = authoritySelection.value.byTaskId[selectedTaskId];
  } else {
    assertResolvedAuthorityMatches(definition, selectedTaskId, authority);
  }
  const effectiveTarget = {
    ...structuredClone(definition.target),
    egress: structuredClone(task.egress ?? definition.target.egress),
  };
  const selectedResources = task.conditionResourceOverrides?.[selectedConditionId]
    ?? condition.resources;
  const pinnedFixtures = [];
  const snapshotFixtures = [];
  const pinnedFixtureBySource = new Map();
  for (const fixture of task.fixtures) {
    const expectedHash = definition.referencedContent.fixtures[fixture.source];
    let pinned = pinnedFixtureBySource.get(fixture.source);
    if (!pinned) {
      const bytes = await readVerifiedFile(
        runPlan,
        fixture.source,
        expectedHash,
        { maxBytes: fixture.maxBytes },
      );
      pinned = {
        path: await pinBytes(pinRoot, "fixtures", fixture.source, bytes),
        sizeBytes: bytes.byteLength,
      };
      pinnedFixtureBySource.set(fixture.source, pinned);
    }
    pinnedFixtures.push({
      source: fixture.source,
      workspacePath: fixture.workspacePath,
      pinnedPath: pinned.path,
      sha256: expectedHash,
      ...(fixture.maxBytes ? { maxBytes: fixture.maxBytes } : {}),
    });
    snapshotFixtures.push({
      source: fixture.source,
      workspacePath: fixture.workspacePath,
      ...(fixture.maxBytes ? { maxBytes: fixture.maxBytes } : {}),
      sizeBytes: pinned.sizeBytes,
      sha256: expectedHash,
    });
  }

  const pinnedBehaviorByPath = {};
  const behavior = {
    deterministicEvaluator: null,
  };
  const evaluatorEntry = task.evaluation?.deterministicEvaluator
    ? { entryPath: task.evaluation.deterministicEvaluator }
    : null;
  for (const entry of evaluatorEntry ? [evaluatorEntry] : []) {
    const graph = runPlan.behaviorGraphsByEntry?.[entry.entryPath]
      ?? [entry.entryPath];
    const modules = {};
    for (const modulePath of graph) {
      const expectedHash = definition.referencedContent.behaviorModules[modulePath];
      const bytes = await readVerifiedFile(runPlan, modulePath, expectedHash);
      if (!pinnedBehaviorByPath[modulePath]) {
        pinnedBehaviorByPath[modulePath] = await pinBytes(
          pinRoot,
          "behavior",
          modulePath,
          bytes,
        );
      }
      modules[modulePath] = expectedHash;
    }
    const snapshotEntry = {
      entryPath: entry.entryPath,
      modules: Object.fromEntries(
        Object.entries(modules).sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
    behavior.deterministicEvaluator = snapshotEntry;
  }

  const pinnedResourceByHandle = {};
  const pinnedSkills = [];
  for (const skill of selectedResources?.skills ?? []) {
    const files = [];
    for (const file of skill.files) {
      const bytes = await readVerifiedFile(runPlan, file.path, file.sha256);
      const handle = `skill:${skill.name}:${file.relativePath}`;
      const pinnedPath = await pinBytes(pinRoot, "resources", file.path, bytes);
      pinnedResourceByHandle[handle] = deepFreeze({
        pinnedPath,
        sha256: file.sha256,
        sizeBytes: bytes.byteLength,
      });
      files.push({
        relativePath: file.relativePath,
        handle,
        sha256: file.sha256,
      });
    }
    pinnedSkills.push({ name: skill.name, files });
  }
  const pinnedResources = deepFreeze({
    skills: pinnedSkills,
    mcpServers: structuredClone(selectedResources?.mcpServers ?? []),
  });

  const snapshot = deepFreeze({
    schemaVersion: 2,
    manifestSchemaVersion: definition.schemaVersion,
    target: effectiveTarget,
    task: {
      id: selectedTaskId,
      prompt: task.prompt,
      fixtures: snapshotFixtures,
      outputArtifacts: structuredClone(task.outputArtifacts ?? []),
      ...(task.evidenceRedaction
        ? { evidenceRedaction: structuredClone(task.evidenceRedaction) }
        : {}),
      ...(task.maxExecutionRetries === undefined
        ? {}
        : { maxExecutionRetries: task.maxExecutionRetries }),
      credentialRequirements: [...task.credentialRequirements],
      credentialDefinitions: task.credentialRequirements.map((name) => ({
        name,
        minimumScopes: [...definition.credentialRequirements[name].minimumScopes],
        delivery: structuredClone(
          task.credentialDeliveryOverrides?.[name]
            ?? definition.credentialRequirements[name].delivery
            ?? { kind: "environment" },
        ),
      })),
      executionRequirements: [...(task.executionRequirements ?? [])],
      observationOnly: task.observationOnly === true,
      judge: task.evaluation?.judge
        ? structuredClone(task.evaluation.judge)
        : null,
    },
    condition: {
      id: selectedConditionId,
      definition: {
        ...structuredClone(condition),
        executionRequirements: [...(condition.executionRequirements ?? [])],
        resources: structuredClone(selectedResources ?? { skills: [], mcpServers: [] }),
      },
    },
    behavior,
    agent: {
      adapterId,
      requestedModel: agentSettings.requestedModel,
      settings: structuredClone(agentSettings.settings),
    },
    environment: {
      environmentId,
      settings: structuredClone(environmentSettings),
    },
    evaluation: {
      taskKind: task.observationOnly === true ? "observation" : "scored",
      deterministicEvaluator: task.evaluation?.deterministicEvaluator ?? null,
      authority: authority === null ? null : structuredClone(authority),
    },
  });

  return deepFreeze({
    snapshot,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    pinnedFixtures,
    pinnedResources,
    pinnedResourceByHandle: deepFreeze(pinnedResourceByHandle),
    evaluatorPath: behavior.deterministicEvaluator
      ? pinnedBehaviorByPath[behavior.deterministicEvaluator.entryPath]
      : null,
    evaluatorSourceModules: behavior.deterministicEvaluator
      ? Object.entries(behavior.deterministicEvaluator.modules)
          .sort(([left], [right]) => (
            Number(right === behavior.deterministicEvaluator.entryPath)
              - Number(left === behavior.deterministicEvaluator.entryPath)
            || left.localeCompare(right)
          ))
          .map(([path, digest]) => ({
            path,
            sha256: digest,
            pinnedPath: pinnedBehaviorByPath[path],
          }))
      : [],
    behaviorRoot: join(pinRoot, "behavior"),
  });
}

function jsonSafe(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const valid = children.every((child) => jsonSafe(child, seen));
  seen.delete(value);
  return valid;
}

export function validateDeterministicChecks(value, { evidenceRefs } = {}) {
  if (!Array.isArray(value)) {
    throw new TypeError("Deterministic Evaluator must return an array of checks");
  }
  const ids = new Set();
  return deepFreeze(value.map((check, index) => {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      throw new TypeError(`Deterministic check ${index} must be an object`);
    }
    if (typeof check.id !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(check.id)) {
      throw new TypeError(`Deterministic check ${index} has an invalid id`);
    }
    if (ids.has(check.id)) {
      throw new TypeError(`Deterministic check id '${check.id}' is duplicated`);
    }
    ids.add(check.id);
    if (typeof check.required !== "boolean") {
      throw new TypeError(`Deterministic check '${check.id}' must declare required`);
    }
    if (!["pass", "fail", "skip"].includes(check.outcome)) {
      throw new TypeError(`Deterministic check '${check.id}' has an invalid outcome`);
    }
    if (
      typeof check.summary !== "string"
      || !check.summary.trim()
      || Buffer.byteLength(check.summary) > 4096
    ) {
      throw new TypeError(`Deterministic check '${check.id}' has an invalid summary`);
    }
    if (check.details !== undefined && !jsonSafe(check.details)) {
      throw new TypeError(`Deterministic check '${check.id}' has non-JSON details`);
    }
    const references = check.evidenceRefs ?? [];
    if (
      !Array.isArray(references)
      || references.some((reference) => (
        typeof reference !== "string"
        || !/^sha256:[a-f0-9]{64}$/.test(reference)
      ))
      || new Set(references).size !== references.length
    ) {
      throw new TypeError(`Deterministic check '${check.id}' has invalid evidence references`);
    }
    if (
      evidenceRefs
      && references.some((reference) => !evidenceRefs.has(reference))
    ) {
      throw new TypeError(`Deterministic check '${check.id}' references unknown evidence`);
    }
    return {
      id: check.id,
      required: check.required,
      outcome: check.outcome,
      summary: check.summary,
      evidenceRefs: [...references],
      ...(check.details === undefined ? {} : { details: structuredClone(check.details) }),
    };
  }));
}

export function validateTargetMetrics(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !jsonSafe(value)
  ) {
    throw new TypeError("Deterministic Evaluator returned invalid target metrics");
  }
  const cloned = structuredClone(value);
  if (Buffer.byteLength(JSON.stringify(cloned)) > 64 * 1024) {
    throw new TypeError("Deterministic Evaluator target metrics exceed the limit");
  }
  return deepFreeze(cloned);
}

function deterministicVerdictReasons(verdict, checks, integrityIssues) {
  if (verdict === "fail") {
    return checks
      .filter((check) => check.required && check.outcome === "fail")
      .map((check) => ({
        code: `check.${check.id}`,
        summary: check.summary,
        evidenceRefs: check.evidenceRefs,
      }));
  }
  if (verdict === "incomplete" || verdict === "unknown") {
    return integrityIssues.map((issue) => ({
      code: issue.code,
      summary: issue.message,
      evidenceRefs: [],
    }));
  }
  return [{
    code: "checks.required-pass",
    summary: "All required checks passed.",
    evidenceRefs: [],
  }];
}

function deterministicRunVerdict({ snapshot, checks, integrityIssues, evaluatorStatus }) {
  if (snapshot?.task?.observationOnly === true) return "unknown";
  const required = checks.filter((check) => check.required);
  if (required.some((check) => check.outcome === "fail")) return "fail";
  if (
    required.some((check) => check.outcome === "skip")
    || integrityIssues.some((issue) => issue.effect === "incomplete")
  ) {
    return "incomplete";
  }
  if (evaluatorStatus !== "complete") return "unknown";
  if (required.length === 0) return "unknown";
  return required.every((check) => check.outcome === "pass") ? "pass" : "unknown";
}

function cleanJudgeOnlyBasis({
  snapshot,
  checks,
  integrityIssues,
  evaluatorStatus,
  deterministicOutcome,
}) {
  return (
    deterministicOutcome.verdict === "unknown"
    && snapshot?.task?.judge?.rubric
    && snapshot.task.observationOnly !== true
    && snapshot?.behavior?.deterministicEvaluator === null
    && evaluatorStatus === "not_requested"
    && checks.length === 0
    && integrityIssues.length === 0
  );
}

export function deriveRunOutcome({
  snapshot,
  checks,
  integrityIssues,
  evaluatorStatus,
  deterministicOutcome = null,
  judgeOutcome = null,
}) {
  const deterministic = deterministicOutcome ?? (() => {
    const verdict = deterministicRunVerdict({
      snapshot,
      checks,
      integrityIssues,
      evaluatorStatus,
    });
    return {
      verdict,
      verdictReasons: deterministicVerdictReasons(verdict, checks, integrityIssues),
    };
  })();
  if (judgeOutcome === null) return deepFreeze(structuredClone(deterministic));
  if (!["pass", "fail", "incomplete"].includes(judgeOutcome)) {
    throw new TypeError("Judge outcome is invalid");
  }
  if (
    deterministic.verdict !== "pass"
    && !cleanJudgeOnlyBasis({
      snapshot,
      checks,
      integrityIssues,
      evaluatorStatus,
      deterministicOutcome: deterministic,
    })
  ) {
    return deepFreeze(structuredClone(deterministic));
  }
  return deepFreeze({
    verdict: judgeOutcome,
    verdictReasons: [{
      code: `judge.rubric-${judgeOutcome}`,
      summary: `The optional Judge returned ${judgeOutcome}.`,
      evidenceRefs: [],
    }],
  });
}

export function deriveRunVerdict({ checks, integrityIssues, evaluatorStatus }) {
  return deterministicRunVerdict({
    snapshot: null,
    checks,
    integrityIssues,
    evaluatorStatus,
  });
}
