#!/usr/bin/env node

import { applyPostgresResultStoreMigrations } from "../lib/postgres-result-store-migrations.mjs";
import { loadProjectEnvironment } from "../lib/project-environment.mjs";

try {
  const { environment } = loadProjectEnvironment(process.cwd());
  await applyPostgresResultStoreMigrations({
    connectionString: environment.TAE_RESULT_STORE_DATABASE_URL,
  });
  process.stdout.write("Postgres Result Store migrations are applied.\n");
} catch (error) {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
}
