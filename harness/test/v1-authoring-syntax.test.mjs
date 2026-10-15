import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeSuite } from "../lib/starter-suite.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

async function failure(suitePath) {
  try {
    const resolved = await resolveV1Suite({ suitePath });
    resolved.dispose?.();
    return resolved.diagnostics?.[0] ?? null;
  } catch (error) {
    return error;
  }
}

function insertLine(file, index, line) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.splice(index, 0, line);
  writeFileSync(file, lines.join("\n"));
}

test("syntax errors in a Suite or checks.mjs name the file and line", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-syntax-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal((await initializeSuite({ destination: join(root, "evals") })).ok, true);
  const suitePath = join(root, "evals/example.suite.mjs");
  const checksPath = join(root, "evals/tasks/copy-message/checks.mjs");
  const suite = readFileSync(suitePath, "utf8");

  insertLine(suitePath, 5, "  oops: ,");
  let error = await failure(suitePath);
  assert.equal(error.code, "suite.module-invalid");
  assert.equal(error.file, suitePath);
  assert.equal(error.pointer, 6);
  assert.equal(error.message, "Suite source has a syntax error.");

  writeFileSync(suitePath, suite);
  insertLine(checksPath, 2, "const broken = ;");
  error = await failure(suitePath);
  assert.equal(error.code, "task.checks-invalid");
  assert.equal(error.file, checksPath);
  assert.equal(error.pointer, 3);
  assert.equal(error.message, "Task code has a syntax error.");
});

test("a checks module that throws keeps the fixed message and never shows the error text", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-throw-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal((await initializeSuite({ destination: join(root, "evals") })).ok, true);
  const suitePath = join(root, "evals/example.suite.mjs");
  const checksPath = join(root, "evals/tasks/copy-message/checks.mjs");
  insertLine(checksPath, 2, 'throw new Error("private-detail");');
  const error = await failure(suitePath);
  assert.equal(error.code, "task.checks-invalid");
  assert.equal(error.file, checksPath);
  assert.equal(error.pointer, 3);
  assert.equal(error.message, "Task checks could not be evaluated.");
  assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /private-detail/);
});
