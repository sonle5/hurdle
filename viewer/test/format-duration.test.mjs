import assert from "node:assert/strict";
import test from "node:test";

import { formatDuration } from "../lib/format-duration.mjs";

test("durations read the same everywhere in the Viewer", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(54), "54s");
  assert.equal(formatDuration(60), "1m");
  assert.equal(formatDuration(65), "1m 5s");
  assert.equal(formatDuration(1110), "18m 30s");
  assert.equal(formatDuration(53.6), "54s");
  assert.equal(formatDuration(-78), "1m 18s");
});
