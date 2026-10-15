import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openLocalResultStoreReader,
} from "../lib/local-result-store-reader.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import { canonicalRunRecordV3Fixture } from "./helpers/canonical-run-record-v3.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/canonical-run-record-v2.json", import.meta.url),
  "utf8",
));
const completeRecord = fixture.history.at(-1);

function seedFixtureStore(root, selectedFixture = fixture) {
  const selectedComplete = selectedFixture.history.at(-1);
  const runRoot = join(root, "runs", selectedComplete.id);
  const revisionsRoot = join(runRoot, "revisions");
  const blobsRoot = join(runRoot, "blobs");
  mkdirSync(revisionsRoot, { recursive: true });
  mkdirSync(blobsRoot, { recursive: true });
  selectedFixture.history.forEach((record, revision) => {
    writeFileSync(
      join(revisionsRoot, `${String(revision).padStart(6, "0")}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  });
  for (const [key, base64] of Object.entries(selectedFixture.blobs)) {
    writeFileSync(join(blobsRoot, key), Buffer.from(base64, "base64"));
  }
}

test("the Local Result Store reader returns canonical Run Record v3 lanes unchanged", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-result-reader-v3-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const v3 = canonicalRunRecordV3Fixture();
  const complete = v3.history.at(-1);
  seedFixtureStore(root, v3);

  const store = await openLocalResultStoreReader({ root });

  assert.deepEqual(await store.getRun(complete.id), complete);
  assert.deepEqual(await store.getRunHistory(complete.id), v3.history);
  assert.deepEqual(await store.listRuns(), [complete]);
  assert.equal((await store.getRun(complete.id)).schemaVersion, 3);
  assert.equal((await store.getRun(complete.id)).deterministic.baseline.verdict, "pass");
  assert.equal((await store.getRun(complete.id)).headline.decidedBy, "effective-deterministic");
});

test("one unreadable Run does not hide the other Runs in a listing", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-result-reader-corrupt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const v3 = canonicalRunRecordV3Fixture();
  const complete = v3.history.at(-1);
  seedFixtureStore(root, v3);
  // A truncated write, a sync-conflict copy, or a newer record schema.
  const damaged = "run_00000000-0000-4000-8000-000000000001";
  mkdirSync(join(root, "runs", damaged, "revisions"), { recursive: true });
  writeFileSync(join(root, "runs", damaged, "revisions", "000000.json"), '{"truncated": ');
  mkdirSync(join(root, "runs", "run_copy of a run", "revisions"), { recursive: true });

  const store = await openLocalResultStoreReader({ root });

  assert.deepEqual(await store.listRuns(), [complete]);
  await assert.rejects(store.getRun(damaged));
});

test("the Local Result Store reader performs no creation and returns canonical fixture truth", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-result-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedFixtureStore(root);
  const rootMtime = statSync(root).mtimeMs;
  const runsMtime = statSync(join(root, "runs")).mtimeMs;

  const store = await openLocalResultStoreReader({ root });

  assert.equal(statSync(root).mtimeMs, rootMtime);
  assert.equal(statSync(join(root, "runs")).mtimeMs, runsMtime);
  assert.deepEqual(await store.getRun(completeRecord.id), completeRecord);
  assert.deepEqual(await store.getRunHistory(completeRecord.id), fixture.history);
  assert.deepEqual(await store.listRuns(), [completeRecord]);
  assert.deepEqual(
    await store.listRuns({ targetId: "another-target" }),
    [],
  );
  assert.deepEqual(
    await store.listRuns({ targetId: "starter-target", limit: 1 }),
    [completeRecord],
  );

  const transcript = await store.readEvidence(
    completeRecord.evidence.transcript,
    { maxBytes: 1024 },
  );
  assert.match(transcript.toString("utf8"), /misleading transcript/);
  await assert.rejects(
    store.readEvidence(
      completeRecord.evidence.artifacts[2].content,
      { maxBytes: 1024 },
    ),
    /readable Evidence Reference/,
  );

  assert.equal("transition" in store, false);
  assert.equal("putEvidence" in store, false);
  assert.throws(
    () => createRunEngine({ resultStore: store }),
    /first-party Result Store/,
  );
});

test("the Local Result Store reader rejects a missing root without creating it", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "tae-result-reader-missing-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "does-not-exist");

  await assert.rejects(
    openLocalResultStoreReader({ root }),
    (error) => error?.code === "ENOENT",
  );
  assert.equal(existsSync(root), false);
});

test("the writable constructor rejects a symlinked root before creating store contents", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-result-writer-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const storeRoot = join(root, "store-link");
  mkdirSync(target);
  symlinkSync(target, storeRoot, "dir");

  await assert.rejects(
    openLocalResultStore({ root: storeRoot }),
    /non-symlink directory/,
  );
  assert.equal(existsSync(join(target, "runs")), false);
});
