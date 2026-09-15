import assert from "node:assert/strict";
import test from "node:test";
import { sameRecordedDefinition } from "../lib/comparison-identity.mjs";

test("comparison requires matching recorded definitions, not matching task/model labels", () => {
  const a = { task: "chat-app", model: "same-alias", snapshotFingerprint: "sha256:" + "a".repeat(64) };
  assert.equal(sameRecordedDefinition(a, { ...a }), true);
  assert.equal(sameRecordedDefinition(a, { ...a, snapshotFingerprint: "sha256:" + "b".repeat(64) }), false);
  assert.equal(sameRecordedDefinition(a, { ...a, snapshotFingerprint: undefined }), false);
  assert.equal(sameRecordedDefinition({ snapshotFingerprint: null }, { snapshotFingerprint: null }), false);
});
