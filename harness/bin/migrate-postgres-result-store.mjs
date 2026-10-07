#!/usr/bin/env node

import { applyPostgresResultStoreMigrations } from "../lib/postgres-result-store-migrations.mjs";
import { loadProjectEnvironment } from "../lib/project-environment.mjs";
import { terminalHeader, terminalStatus } from "../lib/terminal-output.mjs";
import { hurdleEnvironmentValue, RESULT_STORE_DATABASE_URL_ENV } from "../lib/hurdle-environment.mjs";
import { PostgresMigrationError } from "../lib/postgres-migration-error.mjs";

try {
  const { environment } = loadProjectEnvironment(process.cwd());
  await applyPostgresResultStoreMigrations({
    connectionString: hurdleEnvironmentValue(environment, RESULT_STORE_DATABASE_URL_ENV),
  });
  process.stdout.write(terminalHeader(process.stdout) + terminalStatus("pass", "Postgres migrations applied", process.stdout));
} catch (error) {
  const code = error instanceof PostgresMigrationError ? error.code : "migration-failed";
  const message = error instanceof PostgresMigrationError ? error.message
    : `Postgres migration failed. Check ${RESULT_STORE_DATABASE_URL_ENV} and database access.`;
  process.stderr.write(terminalStatus("fail", `hurdle [${code}] ${message}`, process.stderr));
  process.exitCode = 1;
}
