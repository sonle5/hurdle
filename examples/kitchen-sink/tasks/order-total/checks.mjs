import { defineChecks } from "hurdle";

export default defineChecks((run) => {
  run.expect.completed();
  run.expect.artifact({ id: "total-file", path: "total.json", format: "json", maxBytes: 1024 });

  const result = run.artifacts.json("total.json");
  run.check({
    id: "order-id",
    passed: result?.order === "A-1042",
    summary: "total.json must name order A-1042.",
  });
  run.check({
    id: "correct-total",
    passed: result?.total === 248.25,
    summary: "total.json must report 248.25, the sum of price × quantity.",
  });
});
