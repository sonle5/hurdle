import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createPostgresResultStorePool } from "./postgres-result-store-connection.mjs";

const migrations = [{
  version: 1,
  name: "canonical_result_store",
  url: new URL("../migrations/postgres/0001_canonical_result_store.sql", import.meta.url),
}];

function migrationChecksum(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function applyPostgresResultStoreMigrations({ connectionString } = {}) {
  const pool = createPostgresResultStorePool(connectionString, { max: 1 });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tae.result_store.migrations'))");
    await client.query("CREATE SCHEMA IF NOT EXISTS tae");
    await client.query(`
      CREATE TABLE IF NOT EXISTS tae.schema_migrations (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL UNIQUE,
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      )
    `);
    for (const migration of migrations) {
      const bytes = await readFile(migration.url);
      const checksum = migrationChecksum(bytes);
      const applied = await client.query(
        "SELECT name, checksum FROM tae.schema_migrations WHERE version = $1",
        [migration.version],
      );
      if (applied.rowCount === 1) {
        const row = applied.rows[0];
        if (row.name !== migration.name || row.checksum !== checksum) {
          throw new Error(`Postgres Result Store migration ${migration.version} checksum mismatch`);
        }
        continue;
      }
      await client.query(bytes.toString("utf8"));
      await client.query(
        `INSERT INTO tae.schema_migrations (version, name, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, checksum],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}
