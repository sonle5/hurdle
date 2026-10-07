import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createPostgresResultStorePool } from "./postgres-result-store-connection.mjs";
import { PostgresMigrationError } from "./postgres-migration-error.mjs";

const migrations = [{
  version: 1,
  name: "canonical_result_store",
  url: new URL("../migrations/postgres/0001_canonical_result_store.sql", import.meta.url),
}, {
  version: 2,
  name: "hurdle_schema",
  url: new URL("../migrations/postgres/0002_hurdle_schema.sql", import.meta.url),
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
    // Keep the original lock key to serialize upgrades with earlier clients.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tae.result_store.migrations'))");
    const namespaces = await client.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('tae', 'hurdle')");
    const hasLegacy = namespaces.rows.some(row => row.nspname === "tae");
    const hasHurdle = namespaces.rows.some(row => row.nspname === "hurdle");
    if (hasLegacy && hasHurdle) {
      throw new PostgresMigrationError("migration.schema-conflict",
        "Both 'tae' and 'hurdle' Postgres schemas exist. Stop older Hurdle clients and resolve the schema conflict before retrying; no schemas were merged or removed.");
    }
    const existingSchema = hasLegacy || hasHurdle;
    let schema = hasHurdle ? "hurdle" : "tae";
    if (existingSchema) {
      const ledger = await client.query(`SELECT c.relkind FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'schema_migrations'`, [schema]);
      if (ledger.rows[0]?.relkind !== "r") {
        throw new PostgresMigrationError("migration.schema-unrecognized",
          `The '${schema}' schema has no Hurdle migration history. Use a separate database or resolve the existing schema before retrying; it was not changed.`);
      }
    } else {
      // Apply the immutable historical migration, then rename within this transaction.
      // No committed intermediate legacy schema is visible on a fresh installation.
      await client.query("CREATE SCHEMA tae");
      await client.query(`CREATE TABLE tae.schema_migrations (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL UNIQUE,
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      )`);
    }
    for (const migration of migrations) {
      const bytes = await readFile(migration.url);
      const checksum = migrationChecksum(bytes);
      const applied = await client.query(
        `SELECT name, checksum FROM ${schema}.schema_migrations WHERE version = $1`,
        [migration.version],
      );
      if (applied.rowCount === 1) {
        const row = applied.rows[0];
        if (row.name !== migration.name || row.checksum !== checksum) {
          throw new PostgresMigrationError("migration.checksum-mismatch",
            `Postgres Result Store migration ${migration.version} checksum mismatch. Restore the verified migration history before retrying.`);
        }
        if (migration.version === 2 && schema !== "hurdle") {
          throw new PostgresMigrationError("migration.schema-incomplete",
            "The schema name does not match Hurdle migration history. Resolve the inconsistent schema before retrying; it was not changed.");
        }
        continue;
      }
      if ((migration.version === 1 && existingSchema) || (migration.version === 2 && schema === "hurdle")) {
        throw new PostgresMigrationError("migration.schema-incomplete",
          `The '${schema}' schema is missing verified Hurdle migration ${migration.version}. Resolve the incomplete migration history before retrying; it was not changed.`);
      }
      await client.query(bytes.toString("utf8"));
      if (migration.version === 2) schema = "hurdle";
      await client.query(
        `INSERT INTO ${schema}.schema_migrations (version, name, checksum)
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
