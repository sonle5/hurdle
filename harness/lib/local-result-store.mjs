import {
  mkdir,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { publishFileExclusive } from "./durable-files.mjs";
import { deepFreeze, sha256 } from "./run-model.mjs";
import { createRunEngineWithWriter } from "./run-engine.mjs";
import { registerResultStoreEngineFactory } from "./result-store-composition.mjs";
import {
  assertLocalResultStoreRoot,
  openLocalResultStoreReader,
  readLatestLocalRunRecord,
} from "./local-result-store-reader.mjs";
import {
  assertInitialRunRecord,
  assertRunId,
  assertRunTransition,
} from "./result-store-policy.mjs";

export { openLocalResultStoreReader } from "./local-result-store-reader.mjs";

function revisionName(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("record revision must be a non-negative safe integer");
  }
  return `${String(revision).padStart(6, "0")}.json`;
}

async function writeRecord(root, record) {
  const revisionsRoot = join(root, "runs", record.id, "revisions");
  await mkdir(revisionsRoot, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  await publishFileExclusive(revisionsRoot, revisionName(record.revision), bytes);
}

async function storeEvidence(root, runId, {
  bytes,
  mediaType,
  provenance,
  authority,
  producer,
  lifecyclePhase,
  capturedAt,
  trust,
}) {
  assertRunId(runId);
  const value = Buffer.from(bytes);
  const contentHash = sha256(value);
  const key = contentHash.slice("sha256:".length);
  const blobsRoot = join(root, "runs", runId, "blobs");
  await mkdir(blobsRoot, { recursive: true, mode: 0o700 });
  try {
    await publishFileExclusive(blobsRoot, key, value);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return deepFreeze({
    runId,
    key,
    mediaType,
    sizeBytes: value.byteLength,
    sha256: contentHash,
    provenance,
    authority,
    producer,
    lifecyclePhase,
    capturedAt,
    trust,
    availability: "available",
  });
}

export async function openLocalResultStore({ root } = {}) {
  if (!isAbsolute(root ?? "")) {
    throw new TypeError("Local Result Store root must be an absolute path");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertLocalResultStoreRoot(root);
  await mkdir(join(root, "runs"), { recursive: true, mode: 0o700 });

  const store = await openLocalResultStoreReader({ root });

  const writer = {
    async createQueued(record) {
      assertInitialRunRecord(record);
      const runRoot = join(root, "runs", record.id);
      await mkdir(runRoot, { recursive: false, mode: 0o700 });
      await writeRecord(root, record);
      return readLatestLocalRunRecord(root, record.id);
    },
    async transition(expectedRevision, record) {
      const current = await readLatestLocalRunRecord(root, record.id);
      if (!current) throw new Error(`Run '${record.id}' does not exist`);
      if (current.revision !== expectedRevision) {
        const error = new Error(`Run '${record.id}' revision is stale`);
        error.code = "RUN_REVISION_CONFLICT";
        throw error;
      }
      assertRunTransition(current, record);
      await writeRecord(root, record);
      return readLatestLocalRunRecord(root, record.id);
    },
    putEvidence(runId, input) {
      if (!input || !["canonical-evidence", "output-artifact"].includes(input.kind)) {
        throw new TypeError("Evidence kind is invalid");
      }
      return storeEvidence(root, runId, input);
    },
  };
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

  return store;
}
