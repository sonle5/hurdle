import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkSourcePath, highlightCheckSource } from "../lib/evaluator-source-display.mjs";

test("the drawer selects the captured authored checks instead of generated helpers", () => {
  const sources = [
    { path: "evaluators/copy-message.mjs", entry: true },
    { path: "evaluators/runtime.mjs", entry: false },
    { path: "tae-authoring.mjs", entry: false },
    { path: "evaluators/copy-message-checks.mjs", entry: false },
  ];
  const before = structuredClone(sources);
  assert.equal(checkSourcePath(sources), "evaluators/copy-message-checks.mjs");
  assert.deepEqual(sources, before, "presentation must not remove captured support sources");
  assert.equal(checkSourcePath([{ path: "tasks/regex/checks.mjs", entry: true }]), "tasks/regex/checks.mjs");
  assert.equal(checkSourcePath([sources[0], { path: "unrelated-checks.mjs", entry: false }]), sources[0].path);
  assert.equal(checkSourcePath([]), "");
});

test("check code has both themes and one row per source line, including blank lines", async () => {
  const html = await highlightCheckSource('const text = "<script>";\n\n  run.check({ passed: true });\n', "checks.mjs");
  assert.match(html, /--shiki-light:/);
  assert.match(html, /--shiki-dark:/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /(?:&lt;|&#x3C;)script(?:&gt;|>)/);
  assert.deepEqual([...html.matchAll(/data-line="(\d+)"/g)].map(match => Number(match[1])), [1, 2, 3, 4]);
  assert.match(html, /<span class="line" data-line="2"><\/span>/);
  assert.doesNotMatch(html, /<\/span>\n<span class="line"/, "block rows must not have extra preformatted newlines");
  assert.match(html, /data-line="3">(?:<span[^>]*>)?  /, "authored indentation must be preserved");
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.dark \.evaluator-source-code/);
  assert.match(css, /var\(--shiki-light/);
  assert.match(css, /var\(--shiki-dark/);
  assert.match(css, /line-height: 20px/);
});
