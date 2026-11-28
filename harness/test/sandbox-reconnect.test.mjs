import assert from "node:assert/strict";
import { randomBytes, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rootCertificates } from "node:tls";

import { createExecutionEnvelope } from "../lib/execution-envelope.mjs";
import { createSandboxServer } from "../lib/execution-environments/sandbox-server.mjs";
import { createTogetherExecutionEnvironment } from "../lib/execution-environments/together.mjs";
import { createTogetherSocketProvider } from "../lib/execution-environments/together-socket-provider.mjs";
import { deriveRunTrust } from "../lib/run-trust.mjs";

const CA = new X509Certificate(rootCertificates[0]).toString();
const controlToken = randomBytes(32).toString("base64url");

async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
}

test("within its window the sandbox takes back only the controller that holds its token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hurdle-reconnect-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let closed = 0;
  const server = createSandboxServer({
    controlToken,
    runTask: async () => ({ ok: true }),
    port: 0,
    flowPort: 0,
    caPath: join(root, "guardian-ca.pem"),
    writeRoots: [root],
    onClosed: () => { closed += 1; },
    reconnectWindowMs: 300,
  });
  const { port } = await server.listen({ host: "127.0.0.1" });
  t.after(() => server.close());
  const provider = createTogetherSocketProvider({ runUrl: () => `ws://127.0.0.1:${port}/` });
  const acquire = (apiKey = controlToken, caCertificate = CA) => provider.acquire({ apiKey, caCertificate });

  const first = await acquire();
  assert.deepEqual(await first.step({ kind: "noop" }), { ok: true });
  first.close();
  // A second controller without the token, or with another CA, is refused.
  await assert.rejects(acquire(randomBytes(32).toString("base64url")), (error) => error.status === 401);
  await assert.rejects(acquire(""), (error) => error.status === 401);
  await assert.rejects(acquire(controlToken, new X509Certificate(rootCertificates[1]).toString()),
    (error) => error.status === 400);
  const again = await acquire();
  t.after(() => again.close());
  assert.deepEqual(await again.step({ kind: "noop" }), { ok: true });
  await assert.rejects(acquire(), (error) => error.status === 409);
  assert.equal(closed, 0);
  // Past the window the sandbox ends and takes no one back.
  again.close();
  assert.equal(await until(() => closed === 1), true);
  await assert.rejects(acquire(), (error) => error.status === 409);
});

test("a sandbox the platform cannot reach again stops the run as the platform's failure, and each drop is recorded", async () => {
  const connectionIssues = [{
    code: "environment.connection-dropped",
    phase: "transport",
    effect: "incomplete",
    message: "The sandbox connection dropped; output the running step wrote until it was re-established is lost.",
  }];
  const environment = createTogetherExecutionEnvironment({
    apiKey: "provider-api-key",
    guardian: {
      async prepare() { return { workloadEnvironment: {} }; },
      async attach() {},
      async seal() {
        return {
          status: "captured",
          requests: [],
          provenance: {
            producer: "together-host-guardian",
            authority: "environment",
            lifecyclePhase: "execution",
            capturedAt: new Date().toISOString(),
            trust: "environment-observed",
          },
        };
      },
    },
    provider: {
      async acquire() { return { sandboxId: "controlled-sandbox", connectionIssues }; },
      async stage() {},
      async run() {
        throw Object.assign(new Error("sandbox could not be reached again"), { code: "environment.platform-stopped" });
      },
      async collectArtifacts() { return []; },
      async dispose() {},
      async isDisposed() { return true; },
    },
  });
  const result = await environment.execute(createExecutionEnvelope({
    executionId: "controlled-run",
    settings: {},
    launchPlan: { command: "agent", env: {}, timeoutMs: 1000 },
    fixtures: [],
    outputArtifacts: [{ path: "result.txt", kind: "text", maxBytes: 100, required: true }],
    target: {},
    credentialDefinitions: [],
    credentialValues: {},
  }));
  assert.deepEqual(result.integrityIssues.map(({ code, phase, effect }) => [code, phase, effect]), [
    ["environment.platform-stopped", "execute", "incomplete"],
    ["environment.connection-dropped", "transport", "incomplete"],
  ]);
  assert.match(result.integrityIssues[0].message, /stopped by the platform, not by the Agent/);
  assert.equal(deriveRunTrust(result).status, "incomplete");
});
