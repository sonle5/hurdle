import { defineSuite } from "hurdle";

export default defineSuite({
  // Each Task is designed to reach a particular result; see README.md.
  tasks: [
    "./tasks/order-total",
    "./tasks/release-notes",
    "./tasks/fix-the-bug",
    "./tasks/oversized-report",
    "./tasks/summarize-notes",
  ],
  agents: [{ runner: "claude-code", model: "claude-opus-5-5", effort: "medium" }],
  conditions: {
    baseline: {},
    "with-skill": {
      skills: [{ name: "house-style", sourceDirectory: "skills/house-style" }],
    },
  },
  // 5 Tasks × 2 Conditions × 1 Agent × 1 repeat = 10 runs, three at a time.
  repeats: 1,
  concurrency: 3,
  verdict: "code",
});
