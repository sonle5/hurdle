import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { resolveRuntimeProfile } from "./runtime-profile.mjs";
import { DEFAULT_PROJECT_RUNTIME, projectRuntimePath } from "./project-paths.mjs";
import { regularFileContents, atomicWrite, saveCredentials } from "./setup-project-files.mjs";
import { promptSetup } from "./setup-prompts.mjs";
import { createSetupOutput } from "./setup-output.mjs";
import { ensureSetupCredentials } from "./setup-credentials.mjs";
import { canonicalEnvironmentName, withHurdleEnvironment, RESULT_STORE_DATABASE_URL_ENV } from "./hurdle-environment.mjs";
import { PostgresMigrationError } from "./postgres-migration-error.mjs";
import {
  terminalUsesColor, terminalFact, terminalHeader,
  terminalNote, terminalNext, suiteCommand,
} from "./terminal-output.mjs";

function setupError(code, message) { return Object.assign(new Error(message), { code }); }

export async function loadPostgresSetupBackend() {
  const { createPostgresResultStorePool } = await import("./postgres-result-store-connection.mjs");
  const { applyPostgresResultStoreMigrations } = await import("./postgres-result-store-migrations.mjs");
  return {
    async checkConnection(connectionString) {
      const pool = createPostgresResultStorePool(connectionString, { max: 1 });
      try { await pool.query("SELECT 1"); }
      finally { await pool.end(); }
    },
    migrate: connectionString => applyPostgresResultStoreMigrations({ connectionString }),
  };
}

export async function setupPostgresStore({ suite, interactive = false, json = false }, io, dependencies) {
  const output = createSetupOutput(io, { json, target: "postgres" });
  io = output.io;
  const fact = (label, value) => terminalFact(label, value, { useColor: terminalUsesColor(io.stdout) });
  const line = (status, text) => output.check(status, text);
  io.stdout.write(terminalHeader(io.stdout) + fact("Store", "Postgres") + "\n");
  try {
    const runtimePath = projectRuntimePath(io.cwd) ?? DEFAULT_PROJECT_RUNTIME;
    const runtimeFile = resolve(io.cwd, runtimePath);
    const previous = await regularFileContents(runtimeFile);
    if (previous !== null) resolveRuntimeProfile({ cwd: io.cwd, runtimePath });
    const config = previous === null ? {
      schemaVersion: 1, environment: { kind: "local", settings: {} }, viewer: { port: 3000 },
    } : JSON.parse(previous);
    // Retain custom credential names and artifact paths on repeated setup.
    if (config.resultStore?.kind !== "postgres") config.resultStore = {
      kind: "postgres", databaseUrlEnv: RESULT_STORE_DATABASE_URL_ENV, artifactRoot: "../postgres-artifacts",
    };
    config.resultStore.databaseUrlEnv = canonicalEnvironmentName(config.resultStore.databaseUrlEnv);
    const profile = resolveRuntimeProfile({ cwd: io.cwd, runtimePath }, { readFile: () => JSON.stringify(config) });
    const name = profile.resultStore.databaseUrlEnv;
    let environment = { ...dependencies.env };
    const source = await regularFileContents(join(io.cwd, ".env.local"));
    if (source !== null) Object.assign(environment, parseEnv(source));
    environment = withHurdleEnvironment(environment);
    // Check files before making any database changes; never follow credential symlinks.
    await regularFileContents(join(io.cwd, ".gitignore"));
    const entered = await ensureSetupCredentials({
      requirements: [{ label: "Postgres", anyOf: [name] }], environment, interactive,
      prompt: dependencies.promptSetup ?? promptSetup, io, report: output.result,
    });
    const connectionString = environment[name];
    let url;
    try { url = new URL(connectionString); } catch { /* report without echoing the URL */ }
    if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname
      || !/^[\x21-\x7e]+$/.test(connectionString)) {
      throw setupError("setup.database-url", `Use a postgres:// or postgresql:// connection URL in ${name}.`);
    }
    const backend = await (dependencies.loadPostgresSetupBackend ?? loadPostgresSetupBackend)();
    try { await backend.checkConnection(connectionString); }
    catch { throw setupError("setup.database-connection", `Could not connect to Postgres. Check ${name}, network access, and TLS settings. Project Runtime was not changed.`); }
    line("pass", "Postgres connection verified.");
    try { await backend.migrate(connectionString); }
    catch (error) {
      const message = error instanceof PostgresMigrationError ? error.message
        : "Postgres schema setup failed. Check permission to create or rename the result schema and tables, and migration compatibility.";
      throw setupError("setup.database-migration", `${message} Project Runtime was not changed.`);
    }
    line("pass", "Postgres schema ready.");
    await saveCredentials(io.cwd, entered);
    await atomicWrite(runtimeFile, `${JSON.stringify(config, null, 2)}\n`, 0o600);
    line("pass", "Project storage configured.");
    const nextCommands = existsSync(resolve(io.cwd, suite))
      ? [suiteCommand("validate", suite), suiteCommand("run", suite, { view: true })]
      : ["npx hurdle init", "npx hurdle validate", "npx hurdle run --view"];
    Object.assign(output.result, { runtimePath, executionEnvironment: profile.environment.kind, resultStore: "postgres", nextCommands });
    io.stdout.write("\n" + fact("Runtime", runtimePath)
      + fact("Execution", profile.environment.kind === "e2b" ? "E2B" : "Local")
      + fact("Artifacts", relative(io.cwd, profile.resultStore.artifactRoot))
      + "\n" + terminalNote("Applies to future runs; existing local results stay in place.", io.stdout)
      + terminalNext(nextCommands, io.stdout));
    return output.finish(0);
  } catch (error) {
    const known = error.code?.startsWith("setup.") || error.code?.startsWith("runtime.");
    return output.finish(1, { code: known ? error.code : "setup.store-failed", message: known ? error.message
      : "Storage setup could not complete. Check project file permissions and the installed package, then retry. Database migrations may already have been applied; rerunning setup is safe." });
  }
}
