import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compile } from "tailwindcss";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("the Viewer does not install the component scaffolding CLI to render styles", () => {
  const manifest = JSON.parse(read("../package.json"));
  const lock = JSON.parse(read("../package-lock.json"));
  assert.equal(manifest.dependencies.shadcn, undefined);
  assert.equal(lock.packages["node_modules/shadcn"], undefined);
  assert.doesNotMatch(read("../app/globals.css"), /@import\s+["']shadcn\//);
});

test("unused optional calendar peers are not part of the Viewer install", () => {
  const lock = JSON.parse(read("../package-lock.json"));
  for (const name of ["date-fns", "@date-fns/tz"]) {
    assert.equal(lock.packages[`node_modules/${name}`], undefined);
    assert.equal(lock.packages["node_modules/@base-ui/react"].peerDependenciesMeta[name].optional, true);
  }
});

test("local state variants still compile tooltip and separator styles", async () => {
  const css = read("../app/globals.css");
  const variants = css.match(/^@custom-variant data-[^\n]+$/gm) ?? [];
  const compiler = await compile(variants.join("\n") + "\n@tailwind utilities;");
  const built = compiler.build([
    "data-open:block", "data-closed:hidden",
    "data-horizontal:w-full", "data-vertical:h-full",
  ]);
  for (const state of ["open", "closed", "horizontal", "vertical"]) {
    assert.ok(variants.some(line => line.startsWith(`@custom-variant data-${state} `)), state);
    assert.ok(built.includes(`.data-${state}\\:`), state);
  }
  for (const state of ["open", "closed"]) {
    assert.ok(built.includes(`[data-state="${state}"]`), state);
    assert.ok(built.includes(`[data-${state}]:not([data-${state}="false"])`), state);
  }
  assert.ok(built.includes('[data-orientation="horizontal"]'));
  assert.ok(built.includes('[data-orientation="vertical"]'));
});
