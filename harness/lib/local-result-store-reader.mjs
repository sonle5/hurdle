import {
  lstat,
  readdir,
  readFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { deepFreeze, sha256 } from "./run-model.mjs";
import {
  assertRunHistory,
  assertRunId,
  compareRunsNewestFirst,
  normalizeResultStoreQuery,
} from "./result-store-policy.mjs";

export { assertRunId as assertLocalRunId } from "./result-store-policy.mjs";
export { assertRunTransition as validateLocalRunTransition } from "./result-store-policy.mjs";

function revisionName(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("record revision must be a non-negative safe integer");
  }
  return `${String(revision).padStart(6, "0")}.json`;
}

export async function readLocalRunHistory(root, runId) {
  assertRunId(runId);
  const revisionsRoot = join(root, "runs", runId, "revisions");
  let names;
  try {
    names = (await readdir(revisionsRoot))
      .filter((name) => /^\d{6}\.json$/.test(name))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (names.length === 0) return [];
  for (const [index, name] of names.entries()) {
    if (name !== revisionName(index)) {
      throw new Error(`Run '${runId}' has a non-contiguous revision history`);
    }
  }
  const records = [];
  for (const [revision, name] of names.entries()) {
    const record = JSON.parse(await readFile(join(revisionsRoot, name), "utf8"));
    records.push(deepFreeze(record));
  }
  return assertRunHistory(records, runId);
}

export async function readLatestLocalRunRecord(root, runId) {
  return (await readLocalRunHistory(root, runId)).at(-1) ?? null;
}

async function assertNonSymlinkDirectory(path, label) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError(`${label} must be a non-symlink directory`);
  }
}

export async function assertLocalResultStoreRoot(root) {
  if (!isAbsolute(root ?? "")) {
    throw new TypeError("Local Result Store root must be an absolute path");
  }
  await assertNonSymlinkDirectory(root, "Local Result Store root");
}

export function createLocalResultStoreReader(root) {
  return Object.freeze({
    async getRun(runId) {
      return readLatestLocalRunRecord(root, runId);
    },
    async getRunHistory(runId) {
      return readLocalRunHistory(root, runId);
    },
    async listRuns(query) {
      const { limit, targetId } = normalizeResultStoreQuery(query);
      if (limit === 0) return deepFreeze([]);
      const entries = await readdir(join(root, "runs"), { withFileTypes: true });
      const records = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
        const record = await readLatestLocalRunRecord(root, entry.name);
        if (!record) continue;
        if (targetId && record.snapshot.target.id !== targetId) continue;
        records.push(record);
      }
      records.sort(compareRunsNewestFirst);
      return deepFreeze(records.slice(0, limit));
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
      const bytes = await readFile(
        join(root, "runs", reference.runId, "blobs", reference.key),
      );
      if (bytes.byteLength !== reference.sizeBytes || sha256(bytes) !== reference.sha256) {
        throw new Error("Stored evidence does not match its manifest");
      }
      return bytes;
    },
  });
}

export async function openLocalResultStoreReader({ root } = {}) {
  await assertLocalResultStoreRoot(root);
  await assertNonSymlinkDirectory(
    join(root, "runs"),
    "Local Result Store runs path",
  );
  return createLocalResultStoreReader(root);
}
