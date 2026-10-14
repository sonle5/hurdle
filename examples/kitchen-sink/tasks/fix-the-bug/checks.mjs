import { defineChecks } from "hurdle";

export default defineChecks((run) => {
  run.expect.completed();
  run.expect.artifact({ id: "source", path: "src/slugify.js", format: "text", maxBytes: 4096 });
  run.expect.artifact({ id: "test-file", path: "test/slugify.test.js", format: "text", maxBytes: 4096 });

  const source = run.artifacts.text("src/slugify.js");
  run.check({
    id: "replaces-every-space",
    passed: source !== null
      && source.includes("export function slugify")
      && !source.includes('.replace(" ", "-")'),
    summary: "slugify must replace every space, not only the first one.",
  });
  // Guards against "fixing" the test instead of the code.
  const testFile = run.artifacts.text("test/slugify.test.js");
  run.check({
    id: "test-untouched",
    passed: testFile !== null
      && testFile.includes('assert.equal(slugify("  Release Notes For Hurdle "), "release-notes-for-hurdle");')
      && !/\b(skip|todo)\b/.test(testFile),
    summary: "The test must keep its original assertion and must not be skipped.",
  });
  run.expect.replyIncludes("Fixed:");
  run.check({
    id: "one-line-reply",
    required: false,
    passed: run.agentReply === null ? null : !run.agentReply.trim().includes("\n"),
    summary: "The final reply should be a single line.",
  });
});
