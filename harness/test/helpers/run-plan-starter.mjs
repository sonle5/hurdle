// Internal RunPlan fixture for engine regression tests; not a public authoring API.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cp } from "node:fs/promises";
import { join } from "node:path";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeDefinition(input) {
  const definition = structuredClone(input);
  delete definition.$schema;
  definition.target.egress ??= { relevantHosts: [], selectedFields: [] };
  definition.authorityProfiles ??= [];
  for (const requirement of Object.values(definition.credentialRequirements)) {
    requirement.delivery ??= { kind: "environment" };
  }
  for (const condition of Object.values(definition.conditions)) {
    condition.executionRequirements ??= [];
    condition.resources ??= { skills: [], mcpServers: [] };
  }
  for (const task of Object.values(definition.tasks)) {
    task.fixtures ??= [];
    task.outputArtifacts ??= [];
    task.credentialRequirements ??= [];
    task.executionRequirements ??= [];
  }
  return definition;
}

export async function resolveTestRunPlan({ sourceRoot }) {
  const definitionPath = join(sourceRoot, "run-plan.json");
  const definition = normalizeDefinition(JSON.parse(await readFile(definitionPath, "utf8")));
  const fixturePaths = [...new Set(
    Object.values(definition.tasks).flatMap((task) => task.fixtures.map(({ source }) => source)),
  )].sort();
  const behaviorPaths = [...new Set(
    Object.values(definition.tasks)
      .map((task) => task.evaluation?.deterministicEvaluator)
      .filter(Boolean),
  )].sort();
  const referencedPaths = [...new Set([...fixturePaths, ...behaviorPaths])].sort();
  const files = await Promise.all(referencedPaths.map(async (path) => {
    const absolutePath = join(sourceRoot, ...path.split("/"));
    const bytes = await readFile(absolutePath);
    return { path, absolutePath, sha256: digest(bytes) };
  }));
  const hashes = Object.fromEntries(files.map(({ path, sha256 }) => [path, sha256]));
  definition.referencedContent = {
    fixtures: Object.fromEntries(fixturePaths.map((path) => [path, hashes[path]])),
    behaviorModules: Object.fromEntries(behaviorPaths.map((path) => [path, hashes[path]])),
    conditionResources: {},
  };
  const definitionFingerprint = digest(Buffer.from(JSON.stringify(canonicalize({
    kind: "tae.run-plan-definition",
    fingerprintVersion: 1,
    definition,
  }))));
  return {
    sourceRoot: sourceRoot,
    sourcePath: definitionPath,
    filesByPath: Object.fromEntries(files.map(({ path, absolutePath }) => [path, absolutePath])),
    definition,
    definitionFingerprint,
    behaviorGraphsByEntry: Object.fromEntries(behaviorPaths.map((path) => [path, [path]])),
  };
}

export const resolveStarterRunPlan = resolveTestRunPlan;

export async function initializeStarterRunPlan({ destination }) {
  await cp(new URL("../fixtures/starter-run-plan/", import.meta.url), destination, { recursive: true, errorOnExist: true, force: false });
  return {
    ok: true,
    value: {
      ...(await resolveTestRunPlan({ sourceRoot: destination })),
      createdFiles: ["run-plan.json", "evaluators/exact-copy.mjs", "fixtures/message.txt"],
    },
    diagnostics: [],
  };
}
