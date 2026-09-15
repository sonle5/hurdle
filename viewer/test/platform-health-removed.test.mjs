import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("the viewer does not load or render the unused platform-health panel", () => {
  const home = source("../app/page.tsx");
  const compare = source("../app/compare/page.tsx");
  const contextBar = source("../components/shell/ContextBar.tsx");

  assert.doesNotMatch(home, /getPlatformHealthSummary|platformHealth/);
  assert.doesNotMatch(compare, /getPlatformHealthSummary|platformHealth/);
  assert.doesNotMatch(contextBar, /PlatformHealthRail|platformHealth/);
  assert.equal(existsSync(new URL("../components/shell/PlatformHealthRail.tsx", import.meta.url)), false);
});
