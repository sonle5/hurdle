import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../components/Markdown.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
}).outputText.replace(/from "([^"]+)"/g, (_, name) => `from "${pathToFileURL(require.resolve(name)).href}"`);
const { Markdown } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

test("captured Markdown cannot load or preload Agent-selected images", () => {
  const content = [
    "![external](https://agent-chosen.invalid/beacon?secret=value)",
    "![local](/api/agent-chosen-image)",
    '<img src="https://agent-chosen.invalid/html-beacon">',
    "[Explicit navigation](https://example.com/documentation)",
  ].join("\n\n");
  const html = renderToStaticMarkup(React.createElement(Markdown, { content }));
  assert.doesNotMatch(html, /<img\b|<link\b[^>]*preload/);
  assert.match(html, /Image omitted: external/);
  assert.match(html, /Image omitted: local/);
  assert.match(html, /href="https:\/\/example.com\/documentation"/);
  assert.match(html, /rel="noopener noreferrer"/);
});
