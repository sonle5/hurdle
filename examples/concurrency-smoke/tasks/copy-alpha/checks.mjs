import { defineChecks } from "hurdle";

export default defineChecks((run) => {
  run.expect.completed();
  run.expect.artifact({ id: "answer", path: "answer.txt", format: "text", maxBytes: 4096 });
  run.check({
    id: "exact-copy",
    passed: run.artifacts.text("answer.txt") === "Alpha task.\n",
    summary: "answer.txt must match this Task’s fixture exactly.",
  });
});
