import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
test("the Viewer is read-only by construction, without mode flags", () => {
  for (const path of [
    "app/api/verdict-override/route.ts", "app/api/verdict/route.ts",
    "app/api/failure-review/route.ts", "app/api/open/route.ts",
    "app/api/session/[id]/route.ts", "app/api/live/route.ts",
    "app/docs-candidates/page.tsx", "lib/db/index.ts",
  ]) assert.equal(existsSync(new URL(path, root)), false, path);
  assert.throws(() => lstatSync(new URL("public/data", root)), { code: "ENOENT" });
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  for (const name of ["@clerk/nextjs", "@neondatabase/serverless", "drizzle-orm"]) {
    assert.equal(pkg.dependencies[name], undefined, name);
  }
  const routes = readdirSync(new URL("app", root), { recursive: true })
    .filter(path => /route\.tsx?$/.test(path));
  for (const path of routes) {
    assert.doesNotMatch(readFileSync(new URL("app/" + path, root), "utf8"), /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/, path);
  }
});
