import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const MODES = new Set(["e2b", "postgres", "e2b-postgres"]);

function e2bEnvironment(template) {
  return {
    kind: "e2b",
    apiKeyEnv: "E2B_API_KEY",
    settings: {
      workloadTemplate: template,
      guardianTemplate: "base",
      cpuCount: 2,
      memoryMiB: 2048,
      maxLifetimeMs: 3_600_000,
    },
  };
}

function localEnvironment() {
  return { kind: "local", settings: {} };
}

function localStore() {
  return { kind: "local", root: "../e2b-results-v1" };
}

function postgresStore() {
  return {
    kind: "postgres",
    databaseUrlEnv: "TAE_RESULT_STORE_DATABASE_URL",
    artifactRoot: "../postgres-artifacts",
  };
}

export function createRuntimeConfig(mode, { template } = {}) {
  if (!MODES.has(mode)) {
    throw new TypeError("Runtime kind must be e2b, postgres, or e2b-postgres.");
  }
  const usesE2b = mode !== "postgres";
  if (usesE2b && (typeof template !== "string" || !template.trim())) {
    throw new TypeError("E2B runtime requires a workload template.");
  }
  const usesPostgres = mode !== "e2b";
  return Object.freeze({
    schemaVersion: 1,
    environment: usesE2b ? e2bEnvironment(template.trim()) : localEnvironment(),
    resultStore: usesPostgres ? postgresStore() : localStore(),
    judge: {
      kind: "anthropic-json-v1",
      model: "claude-opus-4-8",
      credentialEnv: "ANTHROPIC_API_KEY",
    },
    viewer: { port: usesPostgres ? 3001 : 3000 },
  });
}

export async function initializeRuntime({ cwd, mode, template }) {
  const relativePath = `.hurdle/runtime/${mode}.json`;
  const path = resolve(cwd, relativePath);
  const config = createRuntimeConfig(mode, { template });
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw Object.assign(new Error(`${relativePath} already exists; it was not changed.`), {
        code: "runtime-exists",
      });
    }
    throw error;
  }
  return Object.freeze({ path, relativePath, usesPostgres: mode !== "e2b" });
}
