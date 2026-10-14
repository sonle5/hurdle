import { defineChecks } from "hurdle";

// No pass criteria: every check is an advisory observation, so the run's
// result is always unknown. Observations still show how each Agent approached
// open-ended work, without scoring it.
export default defineChecks((run) => {
  run.expect.artifact({ id: "summary", path: "summary.md", format: "text", maxBytes: 8192, required: false });

  const summary = run.artifacts.text("summary.md");
  const observe = (id, test, text) => run.check({
    id,
    required: false,
    passed: summary === null ? null : test(summary),
    summary: text,
  });
  observe("uses-bullets", (text) => /^\s*[-*] /m.test(text), "The summary should use bullet points.");
  observe(
    "under-120-words",
    (text) => text.split(/\s+/).filter(Boolean).length <= 120,
    "The summary should stay under 120 words.",
  );
  observe(
    "names-owners",
    (text) => ["Priya", "Marco", "Ana"].every((name) => text.includes(name)),
    "The summary should name every action-item owner.",
  );
});
