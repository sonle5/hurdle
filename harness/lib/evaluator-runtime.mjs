import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  deepFreeze,
  validateDeterministicChecks,
  validateTargetMetrics,
} from "./run-model.mjs";

const workerPath = fileURLToPath(new URL("./evaluator-worker.mjs", import.meta.url));

function serializableArtifacts(artifacts) {
  return artifacts.map((artifact) => ({
    path: artifact.path,
    kind: artifact.kind,
    status: artifact.status,
    sha256: artifact.sha256 ?? null,
    bytesBase64: artifact.status === "captured"
      ? Buffer.from(artifact.bytes).toString("base64")
      : null,
    evidenceRef: artifact.evidenceRef ?? null,
  }));
}

async function runIsolatedEvaluator({
  evaluatorPath,
  behaviorRoot,
  snapshot,
  transcript,
  execution,
  artifacts,
  egress,
  lifecycle,
}) {
  const allowedBehaviorRoot = await realpath(behaviorRoot);
  const selectedEvaluatorPath = await realpath(evaluatorPath);
  const allowedWorkerPath = await realpath(workerPath);
  const child = spawn(process.execPath, [
    "--permission",
    `--allow-fs-read=${allowedBehaviorRoot}`,
    // Node 22.13-22.16 do not implicitly grant read access to the entry script.
    `--allow-fs-read=${allowedWorkerPath}`,
    allowedWorkerPath,
    selectedEvaluatorPath,
  ], {
    cwd: allowedBehaviorRoot,
    env: {},
    serialization: "advanced",
    stdio: ["pipe", "ignore", "ignore", "ipc"],
  });
  const resultPromise = new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let result = null;
    let shutdownTimer = null;
    const timeout = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 5_000);
    child.once("message", (message) => {
      if (settled) return;
      result = message;
      child.kill("SIGTERM");
      shutdownTimer = setTimeout(() => child.kill("SIGKILL"), 250);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      rejectPromise(error);
    });
    child.once("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      if (result) {
        resolvePromise(result);
      } else {
        rejectPromise(new Error("Evaluator worker exited without a result"));
      }
    });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({
    snapshot,
    transcript,
    execution,
    artifacts: serializableArtifacts(artifacts),
    egress,
    lifecycle,
  }));
  return resultPromise;
}

export async function runDeterministicEvaluator({
  evaluatorPath,
  behaviorRoot,
  snapshot,
  transcript,
  execution,
  artifacts,
  egress = [],
  lifecycle = {},
}) {
  if (!evaluatorPath) {
    return deepFreeze({ status: "not_requested", checks: [], integrityIssues: [] });
  }
  try {
    const result = await runIsolatedEvaluator({
      evaluatorPath,
      behaviorRoot,
      snapshot,
      transcript,
      execution,
      artifacts,
      egress,
      lifecycle,
    });
    if (!result?.ok) throw new TypeError("Evaluator worker rejected the result");
    const evaluation = result.evaluation;
    if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
      throw new TypeError("Evaluator worker returned no evaluation");
    }
    const evidenceRefs = new Set([
      ...artifacts.map(({ evidenceRef }) => evidenceRef).filter(Boolean),
      ...egress.map(({ evidenceRef }) => evidenceRef).filter(Boolean),
      ...Object.values(lifecycle).flatMap((value) => (
        Array.isArray(value)
          ? value.map(({ evidenceRef }) => evidenceRef)
          : [value?.evidenceRef]
      )).filter(Boolean),
      transcript?.evidenceRef,
    ].filter(Boolean));
    const checks = validateDeterministicChecks(evaluation.checks, { evidenceRefs });
    const targetMetrics = validateTargetMetrics(evaluation.targetMetrics);
    return deepFreeze({
      status: "complete",
      checks,
      targetMetrics,
      integrityIssues: [],
    });
  } catch {
    return deepFreeze({
      status: "invalid",
      checks: [],
      targetMetrics: {},
      integrityIssues: [
        {
          code: "evaluator.invalid",
          phase: "evaluate",
          effect: "unknown",
          message: "Deterministic Evaluator failed in its isolated runtime.",
        },
      ],
    });
  }
}
