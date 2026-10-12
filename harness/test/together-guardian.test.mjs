import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTogetherGuardianController, togetherApplicationHost, restrictTogetherGuardianNetwork } from "../lib/execution-environments/together-guardian.mjs";

test("Together Guardian shares scoped substitutions and seals digest-verified redacted evidence without management credentials in the workload", async () => {
  const guardianCommands = [], workloadCommands = [], networks = [];
  let pid = 100;
  const requests = [{ kind: "http-request", sequence: 0, method: "GET", scheme: "https", host: "api.example.com", path: "/v1/models", statusCode: 200 }];
  const journal = JSON.stringify(requests[0]) + "\n";
  const state = { sealed: true, activeFlows: 0, truncated: false, rowCount: 1,
    journalDigest: "sha256:" + createHash("sha256").update(journal).digest("hex"),
    journalBytes: Buffer.byteLength(journal), maxRows: 10000, maxJournalBytes: 15 * 1024 * 1024,
    maxPathBytes: 4096, policyFingerprint: null };
  const commands = (record) => ({
    async run(command, options = {}) {
      record.push({ command, options });
      if (options.background) return { pid: pid++, kill: async () => {} };
      return { stdout: command.includes("http.client") ? JSON.stringify(state)
        : command.includes("socket.create_connection") ? "READY\n" : "GUARDIAN_BRIDGE_READY", exitCode: 0 };
    },
    list: async () => [],
  });
  const sandbox = { commands: commands(guardianCommands),
    files: { write: async () => {}, getInfo: async () => ({ size: Buffer.byteLength(journal) }),
      read: async path => path.endsWith('requests.jsonl') ? journal : '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----' },
    updateNetwork: async policy => networks.push(policy), getHost: () => 'guardian.example.com',
  };
  const workload = { commands: commands(workloadCommands), files: { write: async () => {} }, getHost: () => "agent.example.com" };
  const controller = createTogetherGuardianController({ startRelay: async () => ({ assertHealthy() {}, allowShutdown() {}, close() {} }) });
  const session = await controller.prepare({ sandbox,
    capture: { mode: 'network-egress-metadata-v1', protocols: ['http', 'https', 'wss'], routes: [{ host: 'api.example.com', selectedFields: ['x-request-id'] }] },
    credentialBindings: [{ environmentName: 'KEY', delivery: { kind: 'captured-http-header', hosts: ['api.example.com'], headerNames: ['authorization'] } }],
    credentialValues: { KEY: 'real-key' }, surrogates: { KEY: 'surrogate-key' }, profile: 'external-guardian-http-metadata-v1',
  });
  assert.deepEqual(networks, [{ allowOut: ['api.example.com'], denyOut: ['0.0.0.0/0'] }]);
  await controller.attach({ sandbox, workload, session });
  const proxy = guardianCommands.find(({ options }) => options.envs?.TAE_EGRESS_SUBSTITUTIONS);
  assert.deepEqual(JSON.parse(proxy.options.envs.TAE_EGRESS_SUBSTITUTIONS), [{ surrogate: 'surrogate-key', value: 'real-key', hosts: ['api.example.com'], headerNames: ['authorization'] }]);
  const bridge = workloadCommands.find(({ options }) => options.envs?.EGRESS_BRIDGE_URL);
  assert.equal(bridge.options.envs.EGRESS_BRIDGE_TRAFFIC_HEADER, 'none');
  assert.equal(bridge.options.envs.EGRESS_BRIDGE_TRAFFIC_TOKEN, undefined);
  assert.doesNotMatch(JSON.stringify(workloadCommands), /real-key|TAE_EGRESS_CONTROL_TOKEN|PRIVATE KEY/);
  const firewall = workloadCommands.find(({ command }) => command.includes('socket.getaddrinfo'));
  assert.match(firewall.command, /"-legacy"/);
  assert.equal(firewall.options.user, 'root');
  const sealed = await controller.seal({ sandbox, session });
  assert.equal(sealed.provenance.producer, 'together-guardian');
  assert.deepEqual(sealed.requests, requests);
  state.journalDigest = 'sha256:' + '0'.repeat(64);
  await assert.rejects(controller.seal({ sandbox, session }), /digest mismatch/);
  state.truncated = true;
  await assert.rejects(controller.seal({ sandbox, session }), /did not seal cleanly/);
});

test("Together application port derivation rejects unknown endpoint formats", () => {
  assert.equal(togetherApplicationHost('https://vm-57468.cluster.csb.app', 18081), 'vm-18081.cluster.csb.app');
  assert.equal(togetherApplicationHost('https://vm-57468.cluster.csb.app:8443', 18081), 'vm-18081.cluster.csb.app:8443');
  for (const url of ['http://vm-57468.cluster.csb.app', 'https://arbitrary.example.com', 'https://user:secret@vm-57468.cluster.csb.app'])
    assert.throws(() => togetherApplicationHost(url, 18081), /routing is unavailable/);
});

test("Together Guardian firewall installs root-only IPv4/IPv6 deny-by-default rules with bounded DNS and public capture destinations", async () => {
  let invocation;
  const resource = { commands: { run: async (command, options) => { invocation = { command, options }; } } };
  await restrictTogetherGuardianNetwork(resource, { allowOut: ['api.example.com'], denyOut: ['0.0.0.0/0'] });
  assert.equal(invocation.options.user, 'root');
  assert.deepEqual(JSON.parse(invocation.options.envs.HURDLE_GUARDIAN_HOSTS), ['api.example.com']);
  assert.match(invocation.command, /iptables-legacy.*ip6tables-legacy/);
  assert.match(invocation.command, /not parsed.is_global/);
  assert.match(invocation.command, /len\(addresses\) > 128/);
  assert.match(invocation.command, /for port in \('57468', '18081'\)/);
  assert.doesNotMatch(invocation.command, /'--ctstate'/);
  assert.match(invocation.command, /command\('-A', chain, '-j', 'DROP'\)/);
  await assert.rejects(restrictTogetherGuardianNetwork(resource, { allowOut: ['api.example.com'] }), /unsupported/);
});
