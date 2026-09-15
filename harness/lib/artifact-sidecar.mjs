import {
  lstat,
  mkdir,
  readFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { publishFileExclusive, syncDirectory } from "./durable-files.mjs";
import { sha256 } from "./run-model.mjs";
import { assertRunId } from "./result-store-policy.mjs";

async function assertDirectory(path, label) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError(`${label} must be a non-symlink directory`);
  }
}

async function ensureChildDirectory(parent, name, label) {
  const path = join(parent, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertDirectory(path, label);
  await syncDirectory(parent);
  return path;
}

async function ensureDurableDirectoryTree(path, label) {
  const missing = [];
  let cursor = path;
  while (true) {
    try {
      await assertDirectory(cursor, label);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    await ensureChildDirectory(
      dirname(directory),
      basename(directory),
      label,
    );
  }
  return path;
}

async function publishExclusive(directory, name, bytes) {
  const destination = join(directory, name);
  try {
    await publishFileExclusive(directory, name, bytes);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("Stored Output Artifact is not a regular isolated file");
    }
    const existing = await readFile(destination);
    if (existing.byteLength !== bytes.byteLength || sha256(existing) !== sha256(bytes)) {
      throw new Error("Stored Output Artifact does not match its content hash");
    }
    await syncDirectory(directory);
  }
}

export async function openArtifactSidecar(root) {
  if (!isAbsolute(root ?? "")) {
    throw new TypeError("Postgres Result Store localArtifactRoot must be absolute");
  }
  await ensureDurableDirectoryTree(
    root,
    "Postgres Result Store localArtifactRoot",
  );
  const runsRoot = await ensureChildDirectory(
    root,
    "runs",
    "Postgres Result Store sidecar runs path",
  );
  return Object.freeze({
    async put(runId, key, bytes) {
      assertRunId(runId);
      if (!/^[a-f0-9]{64}$/.test(key)) throw new TypeError("artifact key is invalid");
      const runRoot = await ensureChildDirectory(
        runsRoot,
        runId,
        "Postgres Result Store sidecar run path",
      );
      const artifactsRoot = await ensureChildDirectory(
        runRoot,
        "artifacts",
        "Postgres Result Store sidecar artifact path",
      );
      await publishExclusive(artifactsRoot, key, bytes);
    },
  });
}
