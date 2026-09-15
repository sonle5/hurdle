const expected = "Hello from the fixture.\n";

export function evaluate({ readArtifactText }) {
  const actual = readArtifactText("answer.txt");
  const passed = actual.status === "present" && actual.text === expected;

  return {
    checks: [{
      id: "exact-copy",
      required: true,
      outcome: passed ? "pass" : "fail",
      summary: passed
        ? "answer.txt matches the fixture."
        : "answer.txt does not match the fixture.",
      evidenceRefs: [],
    }],
    targetMetrics: {},
  };
}
