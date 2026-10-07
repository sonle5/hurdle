import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeSecrets, viewerStoreEnvironment } from "../lib/runtime-profile.mjs";
import { createRuntimeConfig } from "../lib/runtime-init.mjs";

const canonical = "HURDLE_RESULT_STORE_DATABASE_URL";
const legacy = "TAE_RESULT_STORE_DATABASE_URL";

test("new Postgres runtimes use Hurdle credentials and legacy profiles accept either name", () => {
  assert.equal(createRuntimeConfig("postgres").resultStore.databaseUrlEnv, canonical);
  for (const databaseUrlEnv of [canonical, legacy]) {
    const profile = { resultStore: { kind: "postgres", databaseUrlEnv } };
    for (const environment of [{ [canonical]: "new-url" }, { [legacy]: "new-url" }, { [canonical]: "new-url", [legacy]: "old-url" }]) {
      assert.equal(resolveRuntimeSecrets(profile, environment).postgresDatabaseUrl, "new-url");
      assert.deepEqual(viewerStoreEnvironment(profile, environment), {
        HURDLE_RESULT_STORE_MODE: "postgres", HURDLE_RESULT_STORE_DATABASE_URL: "new-url",
      });
    }
    for (const value of ["", " ", undefined]) {
      assert.throws(() => resolveRuntimeSecrets(profile, { [canonical]: value, [legacy]: "old-url" }), error =>
        error.code === "runtime.secret-missing" && error.message.includes(canonical) && !error.message.includes(legacy));
    }
  }
});

test("custom database credential names do not fall back to Hurdle or legacy defaults", () => {
  const profile = { resultStore: { kind: "postgres", databaseUrlEnv: "CUSTOM_DB" } };
  assert.throws(() => resolveRuntimeSecrets(profile, { [canonical]: "new-url", [legacy]: "old-url" }), error =>
    error.code === "runtime.secret-missing" && error.message.includes("CUSTOM_DB"));
  assert.equal(resolveRuntimeSecrets(profile, { CUSTOM_DB: "custom-url", [canonical]: "new-url" }).postgresDatabaseUrl, "custom-url");
});
