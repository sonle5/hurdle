import { openArtifactSidecar } from "./artifact-sidecar.mjs";
import { createPostgresResultStorePool } from "./postgres-result-store-connection.mjs";
import { registerResultStoreEngineFactory } from "./result-store-composition.mjs";
import { deepFreeze, sha256 } from "./run-model.mjs";
import {
  assertInitialRunRecord,
  collectRunEvidence,
  assertRunHistory,
  assertRunId,
  assertRunTransition,
  normalizeRunRecord,
  normalizeResultStoreQuery,
} from "./result-store-policy.mjs";

const poolsByStore = new WeakMap();
const EVIDENCE_LIMIT = 64 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;

async function assertSchema(pool) {
  try {
    const result = await pool.query(
      "SELECT version FROM hurdle.schema_migrations WHERE version IN (1, 2)",
    );
    if (result.rowCount !== 2) throw new Error("required schema migrations are not applied");
  } catch (error) {
    const wrapped = new Error("Postgres Result Store schema migration is not applied. Run npx hurdle setup --store postgres to initialize or upgrade the hurdle schema");
    wrapped.cause = error;
    throw wrapped;
  }
}

function assertCurrentRecord(record, row) {
  const normalizedRecord = normalizeRunRecord(record);
  if (
    normalizedRecord.id !== row.id
    || normalizedRecord.revision !== row.current_revision
    || normalizedRecord.schemaVersion !== row.schema_version
    || normalizedRecord.state !== row.state
    || normalizedRecord.snapshot?.target?.id !== row.target_id
    || normalizedRecord.createdAt !== row.created_at.toISOString()
  ) {
    throw new Error(`Run '${row.id}' has an invalid Postgres head projection`);
  }
  return deepFreeze(normalizedRecord);
}

function createReader(pool) {
  const getRunHistory = async (runId) => {
    assertRunId(runId);
    const result = await pool.query(
      `SELECT record
       FROM hurdle.run_revisions
       WHERE run_id = $1
       ORDER BY revision ASC`,
      [runId],
    );
    return assertRunHistory(result.rows.map(({ record }) => record), runId);
  };
  return Object.freeze({
    async getRun(runId) {
      const history = await getRunHistory(runId);
      return history.at(-1) ?? null;
    },
    getRunHistory,
    async listRuns(query) {
      const { limit, targetId } = normalizeResultStoreQuery(query);
      if (limit === 0) return deepFreeze([]);
      const result = await pool.query(
        `SELECT r.id, r.current_revision, r.schema_version, r.state,
                r.target_id, r.created_at, v.record
         FROM hurdle.runs AS r
         JOIN hurdle.run_revisions AS v
           ON v.run_id = r.id AND v.revision = r.current_revision
         WHERE ($1::text IS NULL OR r.target_id = $1)
         ORDER BY r.created_at DESC, r.id COLLATE "C" DESC
         LIMIT $2`,
        [targetId ?? null, limit],
      );
      return deepFreeze(result.rows.map((row) => assertCurrentRecord(row.record, row)));
    },
    async readEvidence(reference, { maxBytes } = {}) {
      if (
        !reference
        || reference.availability !== "available"
        || !Number.isSafeInteger(maxBytes)
        || maxBytes < 1
      ) {
        throw new TypeError("A readable Evidence Reference and maxBytes are required");
      }
      assertRunId(reference.runId);
      if (!/^[a-f0-9]{64}$/.test(reference.key)) {
        throw new TypeError("Evidence Reference key is invalid");
      }
      if (reference.sizeBytes > maxBytes) {
        throw new Error("Evidence exceeds the requested read limit");
      }
      const object = await pool.query(
        `SELECT size_bytes, sha256, chunk_count
         FROM hurdle.evidence_objects
         WHERE run_id = $1 AND key = $2 AND kind = 'canonical-evidence'`,
        [reference.runId, reference.key],
      );
      if (object.rowCount !== 1) throw new Error("Stored evidence does not match its manifest");
      const metadata = object.rows[0];
      if (
        Number(metadata.size_bytes) !== reference.sizeBytes
        || metadata.sha256 !== reference.sha256
      ) {
        throw new Error("Stored evidence does not match its manifest");
      }
      const chunks = await pool.query(
        `SELECT ordinal, bytes
         FROM hurdle.evidence_chunks
         WHERE run_id = $1 AND key = $2 AND kind = 'canonical-evidence'
         ORDER BY ordinal ASC`,
        [reference.runId, reference.key],
      );
      if (
        chunks.rowCount !== metadata.chunk_count
        || chunks.rows.some((row, ordinal) => row.ordinal !== ordinal)
      ) {
        throw new Error("Stored evidence does not match its manifest");
      }
      const bytes = Buffer.concat(chunks.rows.map(({ bytes }) => bytes));
      if (bytes.byteLength !== reference.sizeBytes || sha256(bytes) !== reference.sha256) {
        throw new Error("Stored evidence does not match its manifest");
      }
      return bytes;
    },
  });
}

async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function revisionConflict(runId) {
  const error = new Error(`Run '${runId}' revision is stale`);
  error.code = "RUN_REVISION_CONFLICT";
  return error;
}

function evidenceReference(runId, input, bytes, availability) {
  const digest = sha256(bytes);
  return deepFreeze({
    runId,
    key: digest.slice("sha256:".length),
    mediaType: input.mediaType,
    sizeBytes: bytes.byteLength,
    sha256: digest,
    provenance: input.provenance,
    authority: input.authority,
    producer: input.producer,
    lifecyclePhase: input.lifecyclePhase,
    capturedAt: input.capturedAt,
    trust: input.trust,
    availability,
  });
}

async function verifyEvidenceObject(client, kind, reference) {
  const object = await client.query(
    `SELECT size_bytes, sha256, chunk_count
     FROM hurdle.evidence_objects
     WHERE run_id = $1 AND key = $2 AND kind = $3`,
    [reference.runId, reference.key, kind],
  );
  if (object.rowCount !== 1) throw new Error("Run evidence is incomplete");
  const row = object.rows[0];
  if (Number(row.size_bytes) !== reference.sizeBytes || row.sha256 !== reference.sha256) {
    throw new Error("Run evidence is incomplete");
  }
  const expectedAvailability = kind === "canonical-evidence" ? "available" : "unavailable";
  if (reference.availability !== expectedAvailability) {
    throw new Error("Run evidence availability does not match the Result Store");
  }
  if (kind === "output-artifact") {
    if (row.chunk_count !== 0) throw new Error("Run evidence is incomplete");
    return;
  }
  const chunks = await client.query(
    `SELECT count(*)::integer AS count,
            COALESCE(sum(octet_length(bytes)), 0)::bigint AS size,
            min(ordinal)::integer AS first_ordinal,
            max(ordinal)::integer AS last_ordinal
     FROM hurdle.evidence_chunks
     WHERE run_id = $1 AND key = $2 AND kind = 'canonical-evidence'`,
    [reference.runId, reference.key],
  );
  const { count, first_ordinal: firstOrdinal, last_ordinal: lastOrdinal } = chunks.rows[0];
  if (
    count !== row.chunk_count
    || Number(chunks.rows[0].size) !== reference.sizeBytes
    || (count > 0 && (firstOrdinal !== 0 || lastOrdinal !== count - 1))
  ) {
    throw new Error("Run evidence is incomplete");
  }
}

async function verifyRunEvidence(client, record) {
  const unique = new Map();
  for (const item of collectRunEvidence(record)) {
    if (item.reference.runId !== record.id) throw new Error("Run evidence belongs to another run");
    unique.set(`${item.kind}:${item.reference.key}`, item);
  }
  for (const { kind, reference } of unique.values()) {
    await verifyEvidenceObject(client, kind, reference);
  }
}

async function putPostgresEvidence(pool, sidecar, runId, input) {
  assertRunId(runId);
  if (!input || !["canonical-evidence", "output-artifact"].includes(input.kind)) {
    throw new TypeError("Evidence kind is invalid");
  }
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength > EVIDENCE_LIMIT) throw new TypeError("Evidence exceeds the store limit");
  const availability = input.kind === "canonical-evidence" ? "available" : "unavailable";
  const reference = evidenceReference(runId, input, bytes, availability);
  if (input.kind === "output-artifact") {
    await sidecar.put(runId, reference.key, bytes);
  }
  await transaction(pool, async (client) => {
    const chunkCount = input.kind === "canonical-evidence"
      ? Math.ceil(bytes.byteLength / CHUNK_SIZE)
      : 0;
    const inserted = await client.query(
      `INSERT INTO hurdle.evidence_objects
         (run_id, key, kind, size_bytes, sha256, chunk_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [runId, reference.key, input.kind, bytes.byteLength, reference.sha256, chunkCount],
    );
    if (inserted.rowCount === 1 && input.kind === "canonical-evidence") {
      for (let offset = 0, ordinal = 0; offset < bytes.byteLength; offset += CHUNK_SIZE, ordinal += 1) {
        await client.query(
          `INSERT INTO hurdle.evidence_chunks (run_id, key, kind, ordinal, bytes)
           VALUES ($1, $2, 'canonical-evidence', $3, $4)`,
          [runId, reference.key, ordinal, bytes.subarray(offset, offset + CHUNK_SIZE)],
        );
      }
    }
    await verifyEvidenceObject(client, input.kind, reference);
    if (input.kind === "canonical-evidence") {
      const chunks = await client.query(
        `SELECT bytes FROM hurdle.evidence_chunks
         WHERE run_id = $1 AND key = $2 AND kind = 'canonical-evidence'
         ORDER BY ordinal ASC`,
        [runId, reference.key],
      );
      const stored = Buffer.concat(chunks.rows.map(({ bytes: chunk }) => chunk));
      if (stored.byteLength !== bytes.byteLength || sha256(stored) !== reference.sha256) {
        throw new Error("Stored evidence does not match its manifest");
      }
    }
  });
  return reference;
}

function createWriter(pool, sidecar) {
  return Object.freeze({
    async createQueued(record) {
      assertInitialRunRecord(record);
      try {
        return await transaction(pool, async (client) => {
          await client.query("SET CONSTRAINTS ALL DEFERRED");
          await client.query(
            `INSERT INTO hurdle.runs
               (id, current_revision, schema_version, state, target_id, created_at)
             VALUES ($1, 0, $2, $3, $4, $5)`,
            [
              record.id,
              record.schemaVersion,
              record.state,
              record.snapshot.target.id,
              record.createdAt,
            ],
          );
          const stored = await client.query(
            `INSERT INTO hurdle.run_revisions (run_id, revision, record)
             VALUES ($1, 0, $2::jsonb)
             RETURNING record`,
            [record.id, JSON.stringify(record)],
          );
          return deepFreeze(stored.rows[0].record);
        });
      } catch (error) {
        if (error?.code === "23505") {
          const duplicate = new Error(`Run '${record.id}' already exists`);
          duplicate.code = "RUN_ALREADY_EXISTS";
          throw duplicate;
        }
        throw error;
      }
    },
    transition(expectedRevision, record) {
      return transitionPostgresRun(pool, expectedRevision, record);
    },
    putEvidence(runId, input) {
      return putPostgresEvidence(pool, sidecar, runId, input);
    },
  });
}

export async function transitionPostgresRun(pool, expectedRevision, record) {
  return transaction(pool, async (client) => {
    const currentResult = await client.query(
      `SELECT current_revision FROM hurdle.runs WHERE id = $1 FOR UPDATE`,
      [record.id],
    );
    if (currentResult.rowCount !== 1) throw new Error(`Run '${record.id}' does not exist`);
    const current = currentResult.rows[0];
    if (current.current_revision !== expectedRevision) throw revisionConflict(record.id);
    // Read the revision only after owning the head lock. A joined locking SELECT
    // can recheck an advanced head against its old statement snapshot and return
    // no row after waiting, incorrectly reporting an existing run as missing.
    const revisionResult = await client.query(
      "SELECT record FROM hurdle.run_revisions WHERE run_id = $1 AND revision = $2",
      [record.id, current.current_revision],
    );
    if (revisionResult.rowCount !== 1) throw new Error("Run head revision is missing");
    assertRunTransition(revisionResult.rows[0].record, record);
    if (record.state === "complete") await verifyRunEvidence(client, record);
    try {
      await client.query(
        `INSERT INTO hurdle.run_revisions (run_id, revision, record)
         VALUES ($1, $2, $3::jsonb)`,
        [record.id, record.revision, JSON.stringify(record)],
      );
    } catch (error) {
      if (error?.code === "23505") throw revisionConflict(record.id);
      throw error;
    }
    const advanced = await client.query(
      `UPDATE hurdle.runs
       SET current_revision = $2, schema_version = $3, state = $4,
           target_id = $5, created_at = $6
       WHERE id = $1 AND current_revision = $7
       RETURNING current_revision`,
      [
        record.id,
        record.revision,
        record.schemaVersion,
        record.state,
        record.snapshot.target.id,
        record.createdAt,
        expectedRevision,
      ],
    );
    if (advanced.rowCount !== 1) throw revisionConflict(record.id);
    return deepFreeze(record);
  });
}

export async function openPostgresResultStoreReader({ connectionString } = {}) {
  const pool = createPostgresResultStorePool(connectionString, { max: 4 });
  try {
    await assertSchema(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const store = createReader(pool);
  poolsByStore.set(store, pool);
  return store;
}

export async function openPostgresResultStore({
  connectionString,
  localArtifactRoot,
} = {}) {
  const { createRunEngineWithWriter } = await import("./run-engine.mjs");
  const pool = createPostgresResultStorePool(connectionString, { max: 4 });
  try {
    await assertSchema(pool);
    const sidecar = await openArtifactSidecar(localArtifactRoot);
    const store = createReader(pool);
    const writer = createWriter(pool, sidecar);
    registerResultStoreEngineFactory(
      store,
      ({
        agentAdapter,
        agentAdapters,
        executionEnvironment,
        judge,
        progressObserver,
      }) => (
        createRunEngineWithWriter({
          writer,
          agentAdapter,
          agentAdapters,
          executionEnvironment,
          judge,
          progressObserver,
        })
      ),
    );
    poolsByStore.set(store, pool);
    return store;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export async function closePostgresResultStore(store) {
  const pool = poolsByStore.get(store);
  if (!pool) return;
  poolsByStore.delete(store);
  await pool.end();
}
