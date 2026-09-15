import { readFileSync } from "node:fs";

import { fingerprintSnapshot } from "../../lib/run-model.mjs";

const sourceFixture = JSON.parse(readFileSync(
  new URL("../fixtures/canonical-run-record-v2.json", import.meta.url),
  "utf8",
));

export function canonicalRunRecordV3Fixture() {
  const fixture = structuredClone(sourceFixture);
  const id = "run_33333333-3333-4333-8333-333333333333";
  const authority = {
    schemaVersion: 1,
    id: "canonical-deterministic",
    kind: "deterministic-primary",
    checkPolicy: {
      defaultRule: "authored",
      rules: [],
      unmatchedRule: "invalidate-evaluator-output",
    },
    judge: { availability: "disabled" },
  };
  for (const record of fixture.history) {
    record.schemaVersion = 3;
    record.id = id;
    record.snapshot.schemaVersion = 2;
    record.snapshot.manifestSchemaVersion = 2;
    record.snapshot.evaluation = {
      taskKind: "scored",
      deterministicEvaluator: "evaluators/exact-copy.mjs",
      authority,
    };
    record.snapshotFingerprint = fingerprintSnapshot(record.snapshot);
    record.invocation.rootRunId = id;
    record.headline = null;
  }
  const complete = fixture.history.at(-1);
  const rewriteReference = (reference) => {
    if (reference) reference.runId = id;
  };
  rewriteReference(complete.evidence.transcript);
  rewriteReference(complete.evidence.stderr);
  complete.evidence.structured.forEach(rewriteReference);
  complete.evidence.egress.forEach(({ content }) => rewriteReference(content));
  for (const value of Object.values(complete.evidence.lifecycle ?? {})) {
    (Array.isArray(value) ? value : [value]).forEach(rewriteReference);
  }
  complete.evidence.artifacts.forEach(({ content }) => rewriteReference(content));
  complete.runTrust = { schemaVersion: 1, status: "trusted", reasons: [] };
  complete.deterministic = {
    evaluatorStatus: "complete",
    baseline: {
      verdict: "pass",
      verdictReasons: [{
        code: "deterministic.baseline.required-pass",
        summary: "All evaluator-authored required checks passed.",
        evidenceRefs: [],
      }],
    },
    effective: {
      verdict: "pass",
      verdictReasons: [{
        code: "deterministic.effective.required-pass",
        summary: "All checks required by the selected authority profile passed.",
        evidenceRefs: [],
      }],
    },
  };
  complete.checks = complete.checks.map((check) => ({
    id: check.id,
    authoredAuthority: check.required ? "required" : "advisory",
    effectiveAuthority: check.required ? "required" : "advisory",
    outcome: check.outcome,
    summary: check.summary,
    evidenceRefs: check.evidenceRefs,
    ...(check.details === undefined ? {} : { details: check.details }),
  }));
  complete.headline = {
    ...structuredClone(complete.deterministic.effective),
    decidedBy: "effective-deterministic",
  };
  complete.verdict = complete.headline.verdict;
  complete.verdictReasons = complete.headline.verdictReasons;
  return fixture;
}
