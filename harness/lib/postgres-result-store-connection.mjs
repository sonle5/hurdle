import pg from "pg";

import { normalizePostgresConnectionString } from "./postgres-connection-string.mjs";

const { Pool } = pg;

export function createPostgresResultStorePool(connectionString, { max }) {
  if (typeof connectionString !== "string" || !connectionString.trim()) {
    throw new TypeError("Postgres Result Store connection string is required");
  }
  const selectedConnectionString = normalizePostgresConnectionString(connectionString.trim());
  return new Pool({
    connectionString: selectedConnectionString,
    max,
    allowExitOnIdle: true,
    connectionTimeoutMillis: 10_000,
  });
}
