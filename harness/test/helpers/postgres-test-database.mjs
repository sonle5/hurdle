import { randomBytes } from "node:crypto";

import pg from "pg";

export const postgresTestAdminConnectionString =
  (Object.hasOwn(process.env, "HURDLE_TEST_DATABASE_URL")
    ? process.env.HURDLE_TEST_DATABASE_URL : process.env.TAE_TEST_DATABASE_URL)?.trim();

function databaseUrl(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function createPostgresTestDatabase() {
  if (!postgresTestAdminConnectionString) {
    throw new TypeError("HURDLE_TEST_DATABASE_URL is required");
  }
  const databaseName = `hurdle_test_${process.pid}_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({
    connectionString: postgresTestAdminConnectionString,
    max: 1,
  });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  return {
    connectionString: databaseUrl(postgresTestAdminConnectionString, databaseName),
    async cleanup() {
      try {
        // pg-pool can resolve end() before the server observes socket shutdown.
        // Wait for graceful disconnects rather than terminating closing clients.
        const deadline = Date.now() + 5_000;
        while (true) {
          const sessions = await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
            [databaseName],
          );
          if (sessions.rowCount === 0) break;
          if (Date.now() >= deadline) {
            throw new Error("Test database cleanup found connections still open after 5 seconds");
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        await admin.query(`DROP DATABASE "${databaseName}"`);
      } finally {
        await admin.end();
      }
    },
  };
}
