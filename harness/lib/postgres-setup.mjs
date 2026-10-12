import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { resolveRuntimeProfile } from "./runtime-profile.mjs";
import { DEFAULT_PROJECT_RUNTIME, projectRuntimePath } from "./project-paths.mjs";
import { discoverProjectSuites } from "./project-suites.mjs";
import { regularFileContents, atomicWrite, saveCredentials } from "./setup-project-files.mjs";
import { promptSetup } from "./setup-prompts.mjs";
import { createSetupOutput } from "./setup-output.mjs";
import { ensureSetupCredentials } from "./setup-credentials.mjs";
import { canonicalEnvironmentName, withHurdleEnvironment, RESULT_STORE_DATABASE_URL_ENV } from "./hurdle-environment.mjs";
import { PostgresMigrationError } from "./postgres-migration-error.mjs";
import {
  terminalUsesColor, terminalFact, terminalHeader,
  terminalNote, terminalNext, suiteCommand, cliExecutable, runtimeSummaryRows,
} from "./terminal-output.mjs";

function setupError(code, message) { return Object.assign(new Error(message), { code }); }

function postgresNextCommands(cwd, suite) {
  const executable = cliExecutable(cwd);
  if (suite && existsSync(resolve(cwd, suite))) return [suiteCommand("run", suite, { view: true, executable })];
  try {
    if (discoverProjectSuites(cwd).length) return [`${executable} suites`];
  } catch { return [`${executable} suites`]; }
  if (!existsSync(resolve(cwd, "evals"))) return [`${executable} init`];
  let destination = "evals/my-eval";
  for (let suffix = 2; existsSync(resolve(cwd, destination)); suffix += 1) destination = `evals/my-eval-${suffix}`;
  return [`${executable} init ${destination}`];
}

function postgresCredentialRecovery(code, name, source, io, suite) {
  const summaries = {
    "setup.credentials-missing": "Postgres connection URL is missing or blank.",
    "setup.credential": "Enter a nonblank Postgres connection URL without spaces or line breaks.",
    "setup.database-url": "Use a full postgres:// or postgresql:// connection URL.",
    "setup.database-connection": "A Postgres URL was found, but the connection failed.",
  };
  if (!Object.hasOwn(summaries, code)) return null;
  const executable = cliExecutable(io.cwd);
  const setup = suite && existsSync(resolve(io.cwd, suite)) ? suiteCommand("setup", suite, { executable }) : `${executable} setup`;
  const retry = `${setup} --store postgres`;
  const nextCommands = [retry];
  if (code === "setup.credentials-missing") nextCommands.push(`${retry} --interactive`);
  const fact = (label, value) => terminalFact(label, value, { useColor: terminalUsesColor(io.stdout) });
  const message = summaries[code] + "\n\n"
    + fact("Source", source)
    + "\n  Set in .env.local (replace the placeholders):\n"
    + `    ${name}="postgresql://USER:PASSWORD@HOST:5432/DATABASE"\n\n`
    + terminalNote("Copy your provider's full connection URL, including its required TLS options.", io.stdout)
    + (code === "setup.database-connection"
      ? terminalNote("Check the host, port, database, credentials and network access.", io.stdout) : "")
    + terminalNote(".env.local overrides matching shell variables; echo does not show file-only values.", io.stdout)
    + "\n" + nextCommands.map((command, index) => fact(index ? "Or" : "Retry", command)).join("") + "\n"
    + terminalNote("Project Runtime was not changed.", io.stdout).trimEnd();
  return { message, nextCommands };
}

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
  let credentialName = RESULT_STORE_DATABASE_URL_ENV;
  let credentialSource = "Not configured";
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
    credentialName = name;
    let environment = { ...dependencies.env };
    const source = await regularFileContents(join(io.cwd, ".env.local"));
    const localEnvironment = source === null ? {} : parseEnv(source);
    Object.assign(environment, localEnvironment);
    const selectedName = Object.hasOwn(environment, name) ? name
      : name === RESULT_STORE_DATABASE_URL_ENV ? "TAE_RESULT_STORE_DATABASE_URL" : name;
    if (Object.hasOwn(environment, selectedName)) {
      credentialSource = Object.hasOwn(localEnvironment, selectedName) ? ".env.local" : "environment";
      if (typeof environment[selectedName] !== "string" || !environment[selectedName].trim()) credentialSource += " (blank value)";
    }
    environment = withHurdleEnvironment(environment);
    // Check files before making any database changes; never follow credential symlinks.
    await regularFileContents(join(io.cwd, ".gitignore"));
    const entered = await ensureSetupCredentials({
      requirements: [{ label: "Postgres", anyOf: [name] }], environment, interactive,
      prompt(options, promptIo) {
        if (options.secret) credentialSource = "hidden terminal input";
        return (dependencies.promptSetup ?? promptSetup)(options, promptIo);
      }, io, report: output.result,
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
    const nextCommands = postgresNextCommands(io.cwd, suite);
    Object.assign(output.result, { runtimePath, executionEnvironment: profile.environment.kind, resultStore: "postgres", nextCommands });
    io.stdout.write("\n" + runtimeSummaryRows(profile, io.cwd).map(([label, value]) => fact(label, value)).join("")
      + fact("Artifacts", relative(io.cwd, profile.resultStore.artifactRoot))
      + "\n" + terminalNote("Applies to future runs; existing local results stay in place.", io.stdout)
      + terminalNext(nextCommands, io.stdout));
    return output.finish(0);
  } catch (error) {
    const known = error.code?.startsWith("setup.") || error.code?.startsWith("runtime.");
    const recovery = postgresCredentialRecovery(error.code, credentialName, credentialSource, io, suite);
    if (recovery) output.result.nextCommands = recovery.nextCommands;
    return output.finish(1, { code: known ? error.code : "setup.store-failed", message: recovery?.message ?? (known ? error.message
      : "Storage setup could not complete. Check project file permissions and the installed package, then retry. Database migrations may already have been applied; rerunning setup is safe.") });
  }
}
