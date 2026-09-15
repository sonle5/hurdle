import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as authoring from "../index.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
test("the source CLI exposes only the Suite/check authoring API", () => {
  assert.deepEqual(Object.keys(authoring).sort(), ["defineChecks", "defineSuite"]);
  assert.deepEqual(Object.keys(pkg.exports), ["."]);
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.prepack, undefined);
  assert.equal(existsSync(new URL("../scripts/stage-viewer-runtime.mjs", import.meta.url)), false);
  assert.equal(existsSync(new URL("../templates/starter-pack/eval.config.json", import.meta.url)), false);
});
test("the harness has no duplicated Viewer dependency tree", () => {
  for (const name of ["next", "react", "react-dom", "@clerk/nextjs", "drizzle-orm", "shiki"]) assert.equal(pkg.dependencies[name], undefined, name);
  assert.equal(pkg.bin.tae, "./bin/tae.mjs");
  const entry = readFileSync(new URL("../bin/tae.mjs", import.meta.url), "utf8");
  assert.match(entry, /SOURCE_VIEWER_LAUNCHER_URL/);
  assert.doesNotMatch(entry, /HAS_PACKAGED_VIEWER|PACKAGED_VIEWER_ROOT_URL/);
});
