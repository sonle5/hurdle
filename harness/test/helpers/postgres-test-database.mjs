import { randomBytes } from "node:crypto";

import pg from "pg";

export const postgresTestAdminConnectionString =
  process.env.TAE_TEST_DATABASE_URL?.trim();

function databaseUrl(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function createPostgresTestDatabase() {
  if (!postgresTestAdminConnectionString) {
    throw new TypeError("TAE_TEST_DATABASE_URL is required");
  }
  const databaseName = `tae_test_${process.pid}_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({
    connectionString: postgresTestAdminConnectionString,
    max: 1,
  });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  return {
    connectionString: databaseUrl(postgresTestAdminConnectionString, databaseName),
    async cleanup() {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin.end();
    },
  };
}
