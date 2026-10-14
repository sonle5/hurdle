import { defineChecks } from "hurdle";

// The house style lives only in the house-style skill, so these checks fail
// under the baseline Condition and pass when the skill is available.
export default defineChecks((run) => {
  run.expect.completed();
  run.expect.artifact({ id: "notes", path: "RELEASE_NOTES.md", format: "text", maxBytes: 8192 });

  const lines = (run.artifacts.text("RELEASE_NOTES.md") ?? "")
    .trim().split("\n").map((line) => line.trim());
  run.check({
    id: "codename-title",
    passed: lines[0] === "# Hurdle 2.4.0 (Kestrel)",
    summary: "The first line must be the house title: # Hurdle 2.4.0 (Kestrel).",
  });
  run.check({
    id: "crew-sign-off",
    passed: lines.at(-1) === "Shipped by the Hurdle crew.",
    summary: "The last line must be the house sign-off: Shipped by the Hurdle crew.",
  });
  run.check({
    id: "grouped-changes",
    required: false,
    passed: ["## Added", "## Fixed", "## Changed"].every((heading) => lines.includes(heading)),
    summary: "Changes should be grouped under Added, Fixed and Changed headings.",
  });
});
