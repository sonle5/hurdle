import assert from "node:assert/strict";
import test from "node:test";

import { UNVERSIONED_ID } from "../lib/version-date.mjs";
import { versionOptionItem } from "../lib/version-option.mjs";

const runAt = "2026-10-14T12:00:00.000Z";

test("experiment labels stay visible in version pickers", () => {
  // `run --experiment-version before` stores the label as the version id too.
  assert.deepEqual(versionOptionItem({ id: "before", name: "before", kind: "experiment", runAt }), {
    value: "before",
    label: "before",
    sub: "Oct 14, 2026",
    description: null,
  });
});

test("unversioned runs and date-like versions keep readable dates", () => {
  const unversioned = versionOptionItem({ id: UNVERSIONED_ID, name: "Oct 14, 2026", kind: "experiment", runAt });
  assert.equal(unversioned.label, "Oct 14, 2026");
  assert.equal(unversioned.sub, null);
  assert.equal(versionOptionItem({ id: "2026-10-14", name: "2026-10-14", kind: "weekly", runAt }).label, "Oct 14, 2026");
  assert.equal(versionOptionItem({ id: "v_9f1c2", name: "Release candidate", runAt }).label, "Release candidate");
  assert.equal(versionOptionItem({ id: "v_9f1c2", name: "v_9f1c2" }).label, "Date unavailable");
});
