import { deepFreeze } from "./run-model.mjs";
import { createCaptureRequest } from "./egress-evidence.mjs";

const credentialLeases = new WeakMap();

export function createExecutionEnvelope({
  executionId,
  settings,
  launchPlan,
  fixtures,
  outputArtifacts,
  workspaceArtifactMetadata = false,
  target,
  credentialDefinitions,
  credentialValues,
  signal = null,
}) {
  if (typeof executionId !== "string" || !executionId) {
    throw new TypeError("Execution envelope requires an execution ID");
  }
  if (typeof workspaceArtifactMetadata !== "boolean") {
    throw new TypeError("Execution envelope workspace metadata selection must be boolean");
  }
  const credentialBindings = credentialDefinitions.map(({ name, delivery }) => ({
    id: `credential:${name}`,
    environmentName: name,
    delivery: structuredClone(delivery ?? { kind: "environment" }),
  }));
  if (!launchPlan) {
    throw new TypeError("Execution envelope requires a launch plan");
  }
  const frozen = deepFreeze({
    schemaVersion: 1,
    executionId,
    settings: structuredClone(settings),
    launchPlan: structuredClone(launchPlan),
    fixtures: structuredClone(fixtures),
    outputArtifacts: structuredClone(outputArtifacts),
    workspaceArtifactMetadata,
    capture: createCaptureRequest(target),
    credentialBindings,
  });
  const envelope = Object.freeze({ ...frozen, signal });
  credentialLeases.set(envelope, {
    closed: false,
    values: Object.fromEntries(
      credentialBindings.map(({ environmentName }) => [
        environmentName,
        credentialValues[environmentName],
      ]),
    ),
  });
  return envelope;
}

function stopAfterOneTurn() {
  return Object.freeze({ kind: "stop", reason: "single-turn" });
}

export async function executeAgent(envelope, performAgentExecution) {
  if (typeof performAgentExecution !== "function") {
    throw new TypeError("Execution requires an agent execution capability");
  }
  return performAgentExecution(Object.freeze({
    initialPlan: envelope.launchPlan,
    maxTurns: 1,
    maxElapsedMs: envelope.launchPlan.timeoutMs ?? 55 * 60 * 1000,
    onTurn: stopAfterOneTurn,
  }));
}

export async function withExecutionCredentialValues(envelope, callback) {
  const lease = credentialLeases.get(envelope);
  if (!lease || lease.closed) {
    throw new TypeError("Execution credential lease is unavailable");
  }
  if (typeof callback !== "function") {
    throw new TypeError("Execution credential lease requires a callback");
  }
  try {
    return await callback(Object.freeze({ ...lease.values }));
  } finally {
    closeExecutionCredentialLease(envelope);
  }
}

export function closeExecutionCredentialLease(envelope) {
  const lease = credentialLeases.get(envelope);
  if (!lease || lease.closed) return false;
  lease.closed = true;
  for (const name of Object.keys(lease.values)) lease.values[name] = "";
  credentialLeases.delete(envelope);
  return true;
}
