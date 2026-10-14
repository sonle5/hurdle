import { defineChecks } from "hurdle";

// The 1 KB limit is deliberately smaller than the ~24 KB report, so Hurdle
// cannot capture it. The required check then returns null ("cannot decide"),
// which makes the run incomplete instead of a guessed pass or fail.
export default defineChecks((run) => {
  run.expect.completed();
  run.expect.artifact({ id: "report", path: "report.txt", format: "text", maxBytes: 1024, required: false });

  const report = run.artifacts.text("report.txt");
  const lines = report?.trim().split("\n") ?? [];
  run.check({
    id: "lists-every-number",
    passed: report === null
      ? null
      : lines.length === 5000 && lines.every((line, index) => line.trim() === String(index + 1)),
    summary: report === null
      ? "report.txt was not captured because it is over its 1 KB limit, so it cannot be checked."
      : "report.txt must list every integer from 1 to 5000, one per line.",
  });
});
