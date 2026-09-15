import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const viewerRoot = fileURLToPath(new URL("../", import.meta.url));

const removedExecutionFiles = [
  "app/api/eval/cron/route.ts",
  "app/api/queues/eval/route.ts",
  "lib/eval/config.ts",
  "lib/eval/runner.ts",
  "lib/eval/validate-t1.ts",
  "vercel.json",
];

test("the legacy viewer execution surface stays removed", async () => {
  for (const relativePath of removedExecutionFiles) {
    await assert.rejects(
      access(`${viewerRoot}${relativePath}`),
      (error) => error.code === "ENOENT",
      `${relativePath} should not exist`,
    );
  }
});

test("the viewer does not carry legacy execution dependencies", async () => {
  const packageJson = JSON.parse(await readFile(`${viewerRoot}package.json`, "utf8"));

  for (const dependency of ["@anthropic-ai/sdk", "@vercel/queue", "e2b"]) {
    assert.equal(packageJson.dependencies?.[dependency], undefined);
  }
});
