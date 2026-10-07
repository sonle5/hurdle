#!/usr/bin/env node

import { applyPostgresResultStoreMigrations } from "../lib/postgres-result-store-migrations.mjs";
import { loadProjectEnvironment } from "../lib/project-environment.mjs";
import { terminalHeader, terminalStatus } from "../lib/terminal-output.mjs";

try {
  const { environment } = loadProjectEnvironment(process.cwd());
  await applyPostgresResultStoreMigrations({
    connectionString: environment.TAE_RESULT_STORE_DATABASE_URL,
  });
  process.stdout.write(terminalHeader(process.stdout) + terminalStatus("pass", "Postgres migrations applied", process.stdout));
} catch {
  process.stderr.write(terminalStatus("fail", "hurdle [migration-failed] Postgres migration failed. Check TAE_RESULT_STORE_DATABASE_URL and database access.", process.stderr));
  process.exitCode = 1;
}
