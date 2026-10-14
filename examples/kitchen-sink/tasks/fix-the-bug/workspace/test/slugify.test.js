import assert from "node:assert/strict";
import test from "node:test";

import { slugify } from "../src/slugify.js";

test("slugify joins every word with a hyphen", () => {
  assert.equal(slugify("  Release Notes For Hurdle "), "release-notes-for-hurdle");
});
