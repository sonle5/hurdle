import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import pg from "pg";

import { applyPostgresResultStoreMigrations } from "../lib/postgres-result-store-migrations.mjs";
import {
  closePostgresResultStore,
  openPostgresResultStoreReader,
} from "../lib/postgres-result-store.mjs";
import {
  createPostgresTestDatabase,
  postgresTestAdminConnectionString,
} from "./helpers/postgres-test-database.mjs";

const historicalSql = readFileSync(new URL(
  "../migrations/postgres/0001_canonical_result_store.sql", import.meta.url,
));
// Existing installations record this checksum. Changing 0001 would strand them.
const historicalChecksum = "bc7e05239220448a074471f2332d73f515b17cfd41eb5dd30a76eaa868537826";
const fixture = JSON.parse(readFileSync(new URL(
  "./fixtures/canonical-run-record-v2.json", import.meta.url,
), "utf8"));
const databaseOptions = { skip: !postgresTestAdminConnectionString };
const storedTables = ["runs", "run_revisions", "evidence_objects", "evidence_chunks"];

async function openTestDatabase(t) {
  const database = await createPostgresTestDatabase();
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 4 });
  t.after(async () => {
    await pool.end();
    await database.cleanup();
  });
  return { pool, connectionString: database.connectionString };
}

async function seedHistoricalStore(pool, { checksum = historicalChecksum } = {}) {
  const history = structuredClone(fixture.history);
  const complete = history.at(-1);
  for (const artifact of complete.evidence.artifacts) {
    if (artifact.content) artifact.content.availability = "unavailable";
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA tae");
    await client.query(`CREATE TABLE tae.schema_migrations (
      version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL UNIQUE,
      checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
    )`);
    await client.query(historicalSql.toString("utf8"));
    await client.query(`INSERT INTO tae.schema_migrations (version, name, checksum, applied_at)
      VALUES (1, 'canonical_result_store', $1, '2025-01-02T03:04:05Z')`, [checksum]);
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`INSERT INTO tae.runs
      (id, current_revision, schema_version, state, target_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`, [
      complete.id, complete.revision, complete.schemaVersion, complete.state,
      complete.snapshot.target.id, complete.createdAt,
    ]);
    for (const record of history) {
      await client.query(`INSERT INTO tae.run_revisions (run_id, revision, record)
        VALUES ($1, $2, $3::jsonb)`, [record.id, record.revision, JSON.stringify(record)]);
    }
    const references = [
      complete.evidence.transcript, complete.evidence.stderr,
      ...complete.evidence.structured,
      ...complete.evidence.egress.map(({ content }) => content),
      ...Object.values(complete.evidence.lifecycle ?? {}).flat(),
    ].filter(Boolean);
    for (const reference of references) {
      const bytes = Buffer.from(fixture.blobs[reference.key], "base64");
      const splitAt = Math.ceil(bytes.byteLength / 2);
      const chunks = [bytes.subarray(0, splitAt), bytes.subarray(splitAt)]
        .filter(chunk => chunk.byteLength > 0);
      await client.query(`INSERT INTO tae.evidence_objects
        (run_id, key, kind, size_bytes, sha256, chunk_count)
        VALUES ($1, $2, 'canonical-evidence', $3, $4, $5)`, [
        reference.runId, reference.key, bytes.byteLength, reference.sha256, chunks.length,
      ]);
      for (const [ordinal, chunk] of chunks.entries()) {
        await client.query(`INSERT INTO tae.evidence_chunks (run_id, key, kind, ordinal, bytes)
          VALUES ($1, $2, 'canonical-evidence', $3, $4)`, [
          reference.runId, reference.key, ordinal, chunk,
        ]);
      }
    }
    for (const artifact of complete.evidence.artifacts) {
      if (!artifact.content) continue;
      await client.query(`INSERT INTO tae.evidence_objects
        (run_id, key, kind, size_bytes, sha256, chunk_count)
        VALUES ($1, $2, 'output-artifact', $3, $4, 0)`, [
        artifact.content.runId, artifact.content.key, artifact.content.sizeBytes,
        artifact.content.sha256,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return history;
}

async function storedSnapshot(pool, schema) {
  const snapshot = {};
  for (const table of storedTables) {
    // Schema/table identifiers are fixed test constants, never user inputs.
    snapshot[table] = (await pool.query(
      `SELECT to_jsonb(row) AS data FROM ${schema}.${table} AS row ORDER BY to_jsonb(row)::text`,
    )).rows;
  }
  return snapshot;
}

async function namespaceState(pool) {
  return (await pool.query(`SELECT
    to_regnamespace('tae') IS NOT NULL AS legacy,
    to_regnamespace('hurdle') IS NOT NULL AS hurdle`)).rows[0];
}

async function migrationLedger(pool, schema) {
  return (await pool.query(
    `SELECT version, name, checksum, applied_at FROM ${schema}.schema_migrations ORDER BY version`,
  )).rows;
}

test("historical Postgres migration bytes retain the checksum used by existing stores", () => {
  assert.equal(createHash("sha256").update(historicalSql).digest("hex"), historicalChecksum);
});

test("fresh Postgres setup creates only hurdle and records both immutable migrations", databaseOptions, async (t) => {
  const { pool, connectionString } = await openTestDatabase(t);
  await applyPostgresResultStoreMigrations({ connectionString });
  assert.deepEqual(await namespaceState(pool), { legacy: false, hurdle: true });
  const ledger = await migrationLedger(pool, "hurdle");
  assert.deepEqual(ledger.map(({ version }) => version), [1, 2]);
  assert.equal(ledger[0].checksum, historicalChecksum);
  assert.equal(ledger[1].checksum, createHash("sha256").update(readFileSync(new URL(
    "../migrations/postgres/0002_hurdle_schema.sql", import.meta.url,
  ))).digest("hex"));
  await applyPostgresResultStoreMigrations({ connectionString });
  assert.deepEqual(await migrationLedger(pool, "hurdle"), ledger);
});

test("concurrent Postgres schema upgrades preserve histories, evidence, timestamps, and constraints", databaseOptions, async (t) => {
  const { pool, connectionString } = await openTestDatabase(t);
  const history = await seedHistoricalStore(pool);
  await pool.query("GRANT USAGE ON SCHEMA tae TO PUBLIC");
  await pool.query("GRANT SELECT ON tae.evidence_chunks TO PUBLIC");
  const schemaOwnership = (await pool.query(`SELECT oid, nspowner, nspacl
    FROM pg_namespace WHERE nspname = 'tae'`)).rows;
  const before = await storedSnapshot(pool, "tae");
  const [historicalLedger] = await migrationLedger(pool, "tae");
  const tableOids = (await pool.query(`SELECT c.relname, c.oid, c.relowner, c.relacl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'tae' AND c.relkind = 'r' ORDER BY c.relname`)).rows;
  await Promise.all(Array.from({ length: 4 }, () =>
    applyPostgresResultStoreMigrations({ connectionString })));
  assert.deepEqual(await namespaceState(pool), { legacy: false, hurdle: true });
  assert.deepEqual(await storedSnapshot(pool, "hurdle"), before);
  assert.deepEqual((await pool.query(`SELECT oid, nspowner, nspacl
    FROM pg_namespace WHERE nspname = 'hurdle'`)).rows, schemaOwnership);
  assert.deepEqual((await pool.query(`SELECT c.relname, c.oid, c.relowner, c.relacl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'hurdle' AND c.relkind = 'r' ORDER BY c.relname`)).rows, tableOids);
  const ledger = await migrationLedger(pool, "hurdle");
  assert.deepEqual(ledger.map(({ version }) => version), [1, 2]);
  assert.deepEqual(ledger[0], historicalLedger);
  await applyPostgresResultStoreMigrations({ connectionString });
  assert.deepEqual(await migrationLedger(pool, "hurdle"), ledger);

  const reader = await openPostgresResultStoreReader({ connectionString });
  try {
    assert.deepEqual(await reader.getRunHistory(history[0].id), history);
    const complete = history.at(-1);
    assert.deepEqual(await reader.getRun(complete.id), complete);
    assert.deepEqual(await reader.listRuns(), [complete]);
    for (const reference of [complete.evidence.transcript, complete.evidence.stderr,
      ...complete.evidence.structured, ...complete.evidence.egress.map(({ content }) => content),
    ].filter(Boolean)) {
      assert.deepEqual(await reader.readEvidence(reference, { maxBytes: 67_108_864 }),
        Buffer.from(fixture.blobs[reference.key], "base64"));
    }
  } finally {
    await closePostgresResultStore(reader);
  }
  const constraints = (await pool.query(`SELECT conname, condeferrable, condeferred,
    conrelid::regclass::text AS source, confrelid::regclass::text AS target
    FROM pg_constraint WHERE contype = 'f' AND connamespace = 'hurdle'::regnamespace
    ORDER BY conname`)).rows;
  assert.equal(constraints.length, 4);
  assert.ok(constraints.every(({ source, target }) =>
    source.startsWith("hurdle.") && target.startsWith("hurdle.")));
  assert.ok(constraints.some(({ conname, condeferrable, condeferred }) =>
    conname === "hurdle_runs_current_revision_fk" && condeferrable && condeferred));
  const indexes = (await pool.query(`SELECT indexname FROM pg_indexes
    WHERE schemaname = 'hurdle' ORDER BY indexname`)).rows.map(({ indexname }) => indexname);
  assert.ok(indexes.includes("hurdle_runs_newest_idx"));
  assert.ok(indexes.includes("hurdle_runs_target_newest_idx"));
  assert.ok(!indexes.some(name => name.startsWith("tae_")));
  await assert.rejects(pool.query("DELETE FROM hurdle.runs WHERE id = $1", [history[0].id]),
    { code: "23503" });
  assert.deepEqual(await storedSnapshot(pool, "hurdle"), before);
});

test("the Postgres reader requires explicit setup for a legacy schema without modifying it", databaseOptions, async (t) => {
  const { pool, connectionString } = await openTestDatabase(t);
  await seedHistoricalStore(pool);
  const before = await storedSnapshot(pool, "tae");
  await assert.rejects(openPostgresResultStoreReader({ connectionString }), /hurdle setup --store postgres/);
  assert.deepEqual(await namespaceState(pool), { legacy: true, hurdle: false });
  assert.deepEqual(await storedSnapshot(pool, "tae"), before);
});

test("a historical checksum mismatch rolls back without renaming or changing legacy data", databaseOptions, async (t) => {
  const { pool, connectionString } = await openTestDatabase(t);
  await seedHistoricalStore(pool, { checksum: "0".repeat(64) });
  const before = await storedSnapshot(pool, "tae");
  const ledger = await migrationLedger(pool, "tae");
  await assert.rejects(applyPostgresResultStoreMigrations({ connectionString }), /checksum mismatch/);
  assert.deepEqual(await namespaceState(pool), { legacy: true, hurdle: false });
  assert.deepEqual(await storedSnapshot(pool, "tae"), before);
  assert.deepEqual(await migrationLedger(pool, "tae"), ledger);
});

test("conflicting tae and hurdle schemas preserve both without selecting or merging either", databaseOptions, async (t) => {
  const { pool, connectionString } = await openTestDatabase(t);
  await seedHistoricalStore(pool);
  await pool.query("CREATE SCHEMA hurdle; CREATE TABLE hurdle.sentinel (value text PRIMARY KEY)");
  await pool.query("INSERT INTO hurdle.sentinel VALUES ('keep-this-data')");
  const before = await storedSnapshot(pool, "tae");
  const ledger = await migrationLedger(pool, "tae");
  await assert.rejects(applyPostgresResultStoreMigrations({ connectionString }), /both|conflict|collision/i);
  assert.deepEqual(await namespaceState(pool), { legacy: true, hurdle: true });
  assert.deepEqual(await storedSnapshot(pool, "tae"), before);
  assert.deepEqual(await migrationLedger(pool, "tae"), ledger);
  assert.deepEqual((await pool.query("SELECT value FROM hurdle.sentinel")).rows,
    [{ value: "keep-this-data" }]);
});

test("a failed schema object rename rolls back the schema move and migration ledger", databaseOptions, async (t) => {
  const { pool, connectionString } = await openTestDatabase(t);
  await seedHistoricalStore(pool);
  await pool.query("CREATE TABLE tae.rename_collision (id integer PRIMARY KEY)");
  await pool.query("CREATE INDEX hurdle_runs_newest_idx ON tae.rename_collision (id)");
  await pool.query("INSERT INTO tae.rename_collision VALUES (7)");
  const before = await storedSnapshot(pool, "tae");
  const ledger = await migrationLedger(pool, "tae");
  await assert.rejects(applyPostgresResultStoreMigrations({ connectionString }), /already exists/);
  assert.deepEqual(await namespaceState(pool), { legacy: true, hurdle: false });
  assert.deepEqual(await storedSnapshot(pool, "tae"), before);
  assert.deepEqual(await migrationLedger(pool, "tae"), ledger);
  assert.deepEqual((await pool.query("SELECT id FROM tae.rename_collision")).rows, [{ id: 7 }]);
});

test("an unverified legacy schema is preserved until its migration ledger is repaired", databaseOptions, async (t) => {
  const { pool, connectionString } = await openTestDatabase(t);
  await seedHistoricalStore(pool);
  await pool.query("DROP TABLE tae.schema_migrations");
  const before = await storedSnapshot(pool, "tae");
  await assert.rejects(applyPostgresResultStoreMigrations({ connectionString }), /migration|ledger|unverified/i);
  assert.deepEqual(await namespaceState(pool), { legacy: true, hurdle: false });
  assert.deepEqual(await storedSnapshot(pool, "tae"), before);
  assert.equal((await pool.query("SELECT to_regclass('tae.schema_migrations') AS ledger")).rows[0].ledger, null);
});

test("an unrelated hurdle schema is rejected without adopting or modifying its tables", databaseOptions, async (t) => {
  const { pool, connectionString } = await openTestDatabase(t);
  await pool.query("CREATE SCHEMA hurdle; CREATE TABLE hurdle.sentinel (value text PRIMARY KEY)");
  await pool.query("INSERT INTO hurdle.sentinel VALUES ('unrelated-data')");
  await assert.rejects(applyPostgresResultStoreMigrations({ connectionString }), /migration|ledger|unverified/i);
  assert.deepEqual(await namespaceState(pool), { legacy: false, hurdle: true });
  assert.deepEqual((await pool.query("SELECT value FROM hurdle.sentinel")).rows, [{ value: "unrelated-data" }]);
  assert.equal((await pool.query("SELECT to_regclass('hurdle.schema_migrations') AS ledger")).rows[0].ledger, null);
});

test("a manually renamed schema without migration 2 is rejected without adopting its data", databaseOptions, async (t) => {
  const { pool, connectionString } = await openTestDatabase(t);
  await seedHistoricalStore(pool);
  await pool.query("ALTER SCHEMA tae RENAME TO hurdle");
  const before = await storedSnapshot(pool, "hurdle");
  const ledger = await migrationLedger(pool, "hurdle");
  assert.deepEqual(ledger.map(({ version }) => version), [1]);
  await assert.rejects(applyPostgresResultStoreMigrations({ connectionString }),
    { code: "migration.schema-incomplete" });
  assert.deepEqual(await namespaceState(pool), { legacy: false, hurdle: true });
  assert.deepEqual(await storedSnapshot(pool, "hurdle"), before);
  assert.deepEqual(await migrationLedger(pool, "hurdle"), ledger);
  assert.equal((await pool.query("SELECT to_regclass('hurdle.tae_runs_newest_idx') AS index")).rows[0].index,
    "hurdle.tae_runs_newest_idx");
  assert.equal((await pool.query("SELECT to_regclass('hurdle.hurdle_runs_newest_idx') AS index")).rows[0].index, null);
});
