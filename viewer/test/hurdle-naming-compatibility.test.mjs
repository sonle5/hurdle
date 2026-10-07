import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { launchViewer } from "../launcher.mjs";
import { readStoredPreference } from "../lib/browser-preference-storage.mjs";
import { readViewerEnvironment } from "../lib/viewer-environment.mjs";

function storage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
}

test("Viewer settings accept legacy inputs only when the Hurdle setting is absent", () => {
  for (const suffix of ["RESULT_STORE_MODE", "RESULT_STORE_ROOT", "RESULT_STORE_DATABASE_URL", "VIEWER_ONBOARDING"]) {
    const canonical = `HURDLE_${suffix}`;
    const legacy = `TAE_${suffix}`;
    assert.equal(readViewerEnvironment({ [legacy]: "old" }, canonical), "old");
    assert.equal(readViewerEnvironment({ [legacy]: "old", [canonical]: "new" }, canonical), "new");
    assert.equal(readViewerEnvironment({ [legacy]: "old", [canonical]: "" }, canonical), "");
    assert.equal(readViewerEnvironment({}, canonical), undefined);
  }
});

test("legacy launcher settings are normalized without inherited credentials or legacy names", async () => {
  for (const selected of [
    { TAE_RESULT_STORE_MODE: "local", TAE_RESULT_STORE_ROOT: "/old/results" },
    { TAE_RESULT_STORE_MODE: "postgres", TAE_RESULT_STORE_DATABASE_URL: "postgresql://selected" },
  ]) {
    const child = new EventEmitter();
    child.kill = () => true;
    let actual;
    const result = launchViewer({
      cwd: "/viewer", storeEnvironment: selected,
      env: {
        HURDLE_RESULT_STORE_DATABASE_URL: "inherited-secret",
        TAE_RESULT_STORE_DATABASE_URL: "inherited-secret",
        HURDLE_VIEWER_ONBOARDING: "inherited-context",
        TAE_VIEWER_ONBOARDING: "inherited-context",
      },
      spawn(command, args, options) { actual = options.env; return child; },
    });
    assert.deepEqual(actual, {
      HURDLE_VIEWER_READ_ONLY: "1",
      ...Object.fromEntries(Object.entries(selected).map(([key, value]) => [key.replace(/^TAE_/, "HURDLE_"), value])),
    });
    child.emit("close", 0, null);
    await result;
  }
});

test("launcher gives canonical settings precedence and rejects explicitly blank selections", async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  let actual;
  const settings = {
    HURDLE_RESULT_STORE_MODE: "postgres", TAE_RESULT_STORE_MODE: "local",
    HURDLE_RESULT_STORE_DATABASE_URL: "postgresql://new", TAE_RESULT_STORE_DATABASE_URL: "postgresql://old",
  };
  const result = launchViewer({
    cwd: "/viewer", storeEnvironment: settings,
    spawn(command, args, options) { actual = options.env; return child; },
  });
  assert.equal(actual.HURDLE_RESULT_STORE_DATABASE_URL, "postgresql://new");
  assert.equal(actual.HURDLE_RESULT_STORE_MODE, "postgres");
  assert.equal(actual.TAE_RESULT_STORE_DATABASE_URL, undefined);
  child.emit("close", 0, null);
  await result;
  for (const key of ["HURDLE_RESULT_STORE_MODE", "HURDLE_RESULT_STORE_DATABASE_URL"]) {
    assert.throws(() => launchViewer({ cwd: "/viewer", storeEnvironment: { ...settings, [key]: "" } }), /Store selection is invalid/);
  }
});

for (const key of ["theme", "transcript-rail-width", "app-rail-width", "app-rail-collapsed", "check-code-drawer-width"]) {
  test(`saved ${key} preference migrates without overwriting a Hurdle preference`, () => {
    const saved = storage({ [`tae-${key}`]: "old" });
    assert.equal(readStoredPreference(saved, `hurdle-${key}`), "old");
    assert.equal(saved.getItem(`hurdle-${key}`), "old");
    saved.setItem(`hurdle-${key}`, "");
    assert.equal(readStoredPreference(saved, `hurdle-${key}`), "");
    assert.equal(saved.getItem(`tae-${key}`), "old");
  });
}

test("a read-only browser still returns the previous preference", () => {
  assert.equal(readStoredPreference({ getItem: key => key === "tae-theme" ? "dark" : null, setItem() { throw new Error("disabled"); } }, "hurdle-theme"), "dark");
});

test("pre-paint theme keeps the existing choice and respects the new choice", () => {
  const source = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const script = source.match(/const THEME_SCRIPT = `([\s\S]*?)`;/)[1];
  for (const initial of [{ "tae-theme": "dark" }, { "tae-theme": "dark", "hurdle-theme": "light" }]) {
    const saved = storage(initial);
    let dark;
    const root = { offsetHeight: 0, style: {}, classList: { add() {}, remove() {}, toggle(name, value) { dark = value; } } };
    runInNewContext(script, {
      localStorage: saved, document: { documentElement: root },
      window: { matchMedia: () => ({ matches: false, addEventListener() {} }), requestAnimationFrame() { return 1; }, cancelAnimationFrame() {} },
    });
    assert.equal(dark, !Object.hasOwn(initial, "hurdle-theme"));
    assert.equal(saved.getItem("hurdle-theme"), initial["hurdle-theme"] ?? initial["tae-theme"]);
  }
});
