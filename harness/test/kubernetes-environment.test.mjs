import assert from "node:assert/strict";
import { randomBytes, X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rootCertificates } from "node:tls";

import {
  createKubernetesExecutionEnvironment,
  createKubernetesProvider,
  normalizeKubernetesSettings,
} from "../lib/execution-environments/kubernetes.mjs";
import { createSandboxServer } from "../lib/execution-environments/sandbox-server.mjs";
import { createSandboxTask } from "../lib/execution-environments/sandbox-task.mjs";

const WebSocket = createRequire(import.meta.url)("ws");
const CA = new X509Certificate(rootCertificates[0]).toString();
const API_TOKEN = randomBytes(24).toString("hex");
const IMAGE = `registry.test/hurdle-sandbox@sha256:${"a".repeat(64)}`;

// A Kubernetes API server reduced to what the provider uses: pods in one
// namespace, and a v4.channel.k8s.io port-forward. Each created pod becomes a
// real sandbox server started with the token from the pod's env.
async function fakeCluster(t, {
  podStatus = () => ({ phase: "Running" }),
  refusePortForward = 0,
  hangCreate = false,
  hangSandbox = false,
  failDeletes = 0,
  lingerPolls = 0,
  quotaFullCreates = 0,
  hangGets = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "hurdle-k8s-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskRoot = join(root, "task");
  const artifactRoot = join(root, "sealed");
  await mkdir(artifactRoot);
  const pods = new Map();
  const requests = [];
  const jobs = [];
  let portForwards = 0;
  let deletes = 0;
  let creates = 0;
  const hung = [];
  const authorized = (request) => request.headers.authorization === `Bearer ${API_TOKEN}`;
  const podPath = /^\/api\/v1\/namespaces\/hurdle\/pods(?:\/([a-z0-9-]+))?(?:\/(portforward))?$/;

  const api = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://api");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const reply = (status, body = {}) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (!authorized(request)) return reply(401, { kind: "Status" });
    const match = podPath.exec(url.pathname);
    if (!match || match[2]) return reply(404);
    const name = match[1];
    if (request.method === "POST" && !name) {
      const parts = [];
      for await (const chunk of request) parts.push(chunk);
      const pod = JSON.parse(Buffer.concat(parts).toString("utf8"));
      creates += 1;
      if (creates <= quotaFullCreates) {
        // As the API server words a ResourceQuota refusal.
        return reply(403, { kind: "Status", reason: "Forbidden", message: `pods "${pod.metadata.name}" is forbidden: exceeded quota: hurdle-sandboxes, requested: pods=1, used: pods=4, limited: pods=4` });
      }
      if (hangCreate) {
        // Stored, but the reply never comes.
        pods.set(pod.metadata.name, { pod, server: { close: async () => {} }, port: 0, polls: 0 });
        hung.push(response);
        return;
      }
      const controlToken = pod.spec.containers[0].env.find((entry) => entry.name === "HURDLE_SANDBOX_CONTROL_TOKEN").value;
      const server = createSandboxServer({
        controlToken,
        runTask: async (job) => { jobs.push(job); return { ok: true }; },
        port: 0,
        flowPort: 0,
        caPath: join(taskRoot, "guardian-ca.pem"),
        writeRoots: [taskRoot],
        readRoots: [artifactRoot],
      });
      const { port } = await server.listen({ host: "127.0.0.1" });
      pods.set(pod.metadata.name, { pod, server, port, polls: 0 });
      return reply(201, pod);
    }
    const entry = pods.get(name);
    if (!entry) return reply(404, { kind: "Status", reason: "NotFound" });
    if (request.method === "GET") {
      if (hangGets && entry.deleting === undefined) { hung.push(response); return; }  // until deleted
      entry.polls += 1;
      if (entry.deleting > 0) entry.deleting -= 1;
      return reply(200, { ...entry.pod, status: podStatus(entry.polls) });
    }
    if (request.method === "DELETE") {
      deletes += 1;
      if (deletes <= failDeletes) return reply(500, { kind: "Status" });
      // As kubelet takes a moment to stop the container after a graceful delete.
      entry.deleting ??= lingerPolls;
      if (entry.deleting > 0) { entry.deleting -= 1; return reply(200, entry.pod); }
      pods.delete(name);
      await entry.server.close();
      return reply(200, entry.pod);
    }
    reply(405);
  });

  const forwarder = new WebSocket.WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("v4.channel.k8s.io") ? "v4.channel.k8s.io" : false),
  });
  api.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://api");
    const match = podPath.exec(url.pathname);
    const entry = match?.[2] && pods.get(match[1]);
    if (!authorized(request) || !entry || url.searchParams.get("ports") !== "18083") {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    forwarder.handleUpgrade(request, socket, head, (ws) => {
      portForwards += 1;
      const portFrame = (channel) => Buffer.from([channel, 18083 & 0xff, 18083 >> 8]);
      ws.send(portFrame(0));
      ws.send(portFrame(1));
      if (portForwards <= refusePortForward) {
        // As kubelet reports a port nothing listens on yet.
        ws.send(Buffer.concat([Buffer.from([1]), Buffer.from("connection refused")]));
        ws.close();
        return;
      }
      // A sandbox that accepts the stream but never answers the upgrade.
      if (hangSandbox) return;
      const tcp = net.connect(entry.port, "127.0.0.1");
      tcp.on("data", (data) => ws.send(Buffer.concat([Buffer.from([0]), data])));
      tcp.on("close", () => ws.close());
      tcp.on("error", () => ws.terminate());
      ws.on("message", (data) => { if (data[0] === 0) tcp.write(data.subarray(1)); });
      ws.on("close", () => tcp.destroy());
    });
  });
  await new Promise((ready) => api.listen(0, "127.0.0.1", ready));
  t.after(async () => {
    for (const response of hung) response.destroy();
    for (const { server } of pods.values()) await server.close();
    api.closeAllConnections();
    api.close();
  });
  return {
    apiServer: `http://127.0.0.1:${api.address().port}`,
    taskRoot,
    artifactRoot,
    pods,
    requests,
    jobs,
    portForwards: () => portForwards,
    deletes: () => deletes,
    creates: () => creates,
  };
}

function provider(cluster, options = {}) {
  return createKubernetesProvider({
    token: API_TOKEN,
    pollMs: 10,
    taskRoot: cluster.taskRoot,
    artifactRoot: cluster.artifactRoot,
    ...options,
  });
}

const acquireOptions = (cluster) => ({
  apiServer: cluster.apiServer,
  namespace: "hurdle",
  image: IMAGE,
  nodeSelector: { workload: "app" },
  maxLifetimeMs: 600_000,
  cpu: "1",
  memory: "2Gi",
  ephemeralStorage: "4Gi",
  caCertificate: CA,
});

test("a cell gets its own CPU-node pod and talks to it through the port-forward", async (t) => {
  const cluster = await fakeCluster(t, { podStatus: (polls) => ({ phase: polls < 3 ? "Pending" : "Running" }) });
  const pods = provider(cluster);
  const resource = await pods.acquire(acquireOptions(cluster));
  t.after(() => resource.close());

  assert.equal(cluster.pods.size, 1);
  const [{ pod }] = cluster.pods.values();
  assert.equal(resource.sandboxId, pod.metadata.name);
  assert.match(pod.metadata.name, /^hurdle-sandbox-[0-9a-f]{12}$/);
  assert.equal(pod.metadata.labels["app.kubernetes.io/name"], "hurdle-sandbox");
  assert.deepEqual(pod.spec.nodeSelector, { workload: "app" });
  assert.equal(pod.spec.restartPolicy, "Never");
  assert.equal(pod.spec.activeDeadlineSeconds, 600);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.hostUsers, false);
  assert.equal(pod.spec.enableServiceLinks, false);
  const [container] = pod.spec.containers;
  assert.equal(container.image, IMAGE);
  assert.equal(container.imagePullPolicy, "Never");
  // The fields the cluster's admission policy (nexus-compiler
  // platform/hurdle.yaml) checks; the policy itself is tested there.
  const bounds = { cpu: "1", memory: "2Gi", "ephemeral-storage": "4Gi" };
  assert.deepEqual(container.resources, { requests: bounds, limits: bounds });
  assert.equal(container.lifecycle, undefined);
  assert.equal(container.workingDir, undefined);
  assert.equal(container.args, undefined);
  assert.deepEqual(container.securityContext.capabilities, { add: ["NET_ADMIN"] });
  assert.deepEqual(container.securityContext.seccompProfile, { type: "RuntimeDefault" });
  assert.equal(container.securityContext.privileged, undefined);
  assert.equal(pod.spec.volumes, undefined);
  assert.deepEqual(container.command, ["node", "/opt/hurdle/harness/bin/hurdle-sandbox-server.mjs"]);
  assert.deepEqual(container.env.map(Object.keys), [["name", "value"]]);
  assert.deepEqual(container.env.map((entry) => entry.name), ["HURDLE_SANDBOX_CONTROL_TOKEN"]);
  // The cluster's own API token never reaches the pod.
  assert.doesNotMatch(JSON.stringify(pod), new RegExp(API_TOKEN));

  assert.equal(await readFile(join(cluster.taskRoot, "guardian-ca.pem"), "utf8"), CA);
  assert.deepEqual(await resource.step({ kind: "noop" }), { ok: true });
  // The server learns it runs in a Kubernetes pod from the controller's setup.
  await resource.attachEgress({ hosts: ["api.anthropic.com"], openUpstream: () => null });
  assert.deepEqual(cluster.jobs, [{ kind: "noop" }, { kind: "setup", hosts: ["api.anthropic.com"], sandbox: "kubernetes" }]);

  await pods.dispose(resource);
  assert.equal(resource.closed, true);
  assert.equal(cluster.pods.size, 0);
  assert.ok(cluster.requests.some((line) => line.startsWith("DELETE ") && line.endsWith("?gracePeriodSeconds=1")));
  assert.equal(await pods.isDisposed(resource), true);
});

test("the pod's deadline follows a lifetime up to 26 hours", async (t) => {
  const cluster = await fakeCluster(t);
  const pods = provider(cluster);
  const resource = await pods.acquire({ ...acquireOptions(cluster), maxLifetimeMs: 93_600_000 });
  t.after(() => resource.close());
  const [{ pod }] = cluster.pods.values();
  assert.equal(pod.spec.activeDeadlineSeconds, 93_600);
  await pods.dispose(resource);
});

test("the port-forward is retried until the sandbox server listens", async (t) => {
  const cluster = await fakeCluster(t, { refusePortForward: 2 });
  const pods = provider(cluster);
  const resource = await pods.acquire(acquireOptions(cluster));
  t.after(() => resource.close());
  assert.equal(cluster.portForwards(), 3);
  assert.deepEqual(await resource.step({ kind: "noop" }), { ok: true });
});

test("a pod that cannot start fails the cell and is deleted", async (t) => {
  const cluster = await fakeCluster(t, {
    podStatus: () => ({ phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }] }),
  });
  await assert.rejects(provider(cluster).acquire(acquireOptions(cluster)), /could not start its container \(ImagePullBackOff\)/);
  assert.equal(cluster.pods.size, 0);
});

test("a container that cannot run fails the cell at once", async (t) => {
  const cluster = await fakeCluster(t, {
    podStatus: () => ({ phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "RunContainerError" } } }] }),
  });
  await assert.rejects(provider(cluster).acquire(acquireOptions(cluster)), /could not start its container \(RunContainerError\)/);
  assert.equal(cluster.pods.size, 0);
});

test("a full namespace quota is waited out, not failed", async (t) => {
  const cluster = await fakeCluster(t, { quotaFullCreates: 2 });
  const resource = await provider(cluster).acquire(acquireOptions(cluster));
  t.after(() => resource.close());
  assert.equal(cluster.creates(), 3);
  assert.equal(cluster.pods.size, 1);
});

test("a quota that stays full times out", async (t) => {
  const cluster = await fakeCluster(t, { quotaFullCreates: Infinity });
  await assert.rejects(
    provider(cluster, { connectTimeoutMs: 100 }).acquire(acquireOptions(cluster)),
    (error) => error.code === "sandbox_connection_timeout",
  );
  assert.equal(cluster.pods.size, 0);
});

test("a status read that never answers ends at the deadline", async (t) => {
  const cluster = await fakeCluster(t, { hangGets: true });
  const started = Date.now();
  await assert.rejects(
    provider(cluster, { connectTimeoutMs: 200, deleteConfirmMs: 0 }).acquire(acquireOptions(cluster)),
    (error) => error.code === "sandbox_connection_timeout",
  );
  assert.ok(Date.now() - started < 5_000);
});

test("a pod that never runs times out and is deleted", async (t) => {
  const cluster = await fakeCluster(t, { podStatus: () => ({ phase: "Pending" }) });
  await assert.rejects(
    provider(cluster, { connectTimeoutMs: 100 }).acquire(acquireOptions(cluster)),
    (error) => error.code === "sandbox_connection_timeout",
  );
  assert.equal(cluster.pods.size, 0);
});

test("cancelling while the pod starts deletes it", async (t) => {
  const cluster = await fakeCluster(t, { podStatus: () => ({ phase: "Pending" }) });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    provider(cluster).acquire({ ...acquireOptions(cluster), signal: controller.signal }),
    (error) => error.name === "AbortError",
  );
  assert.equal(cluster.pods.size, 0);
});

test("cancelling while the create request is in flight deletes the stored pod", async (t) => {
  const cluster = await fakeCluster(t, { hangCreate: true });
  const controller = new AbortController();
  const acquiring = provider(cluster).acquire({ ...acquireOptions(cluster), signal: controller.signal });
  while (cluster.pods.size === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(acquiring, (error) => error.name === "AbortError");
  assert.equal(cluster.pods.size, 0);
});

test("a sandbox that never answers its handshake times out and is deleted", async (t) => {
  const cluster = await fakeCluster(t, { hangSandbox: true });
  await assert.rejects(
    provider(cluster, { connectTimeoutMs: 200 }).acquire(acquireOptions(cluster)),
    (error) => error.code === "sandbox_connection_timeout",
  );
  assert.equal(cluster.pods.size, 0);
});

test("dispose retries a failed delete and waits until the pod is gone", async (t) => {
  const cluster = await fakeCluster(t, { failDeletes: 1, lingerPolls: 3 });
  const pods = provider(cluster);
  const resource = await pods.acquire(acquireOptions(cluster));
  await pods.dispose(resource);
  assert.equal(cluster.pods.size, 0);
  assert.ok(cluster.deletes() >= 2);
  assert.equal(await pods.isDisposed(resource), true);
});

test("dispose fails when the pod never goes away", async (t) => {
  const cluster = await fakeCluster(t, { failDeletes: Infinity });
  const pods = provider(cluster, { deleteConfirmMs: 100 });
  const resource = await pods.acquire(acquireOptions(cluster));
  await assert.rejects(pods.dispose(resource), /did not delete the sandbox pod \(500\)/);
  assert.equal(await pods.isDisposed(resource), false);
});

test("an API refusal surfaces its status without the token", async (t) => {
  const cluster = await fakeCluster(t);
  const wrong = createKubernetesProvider({ token: "not-the-token", pollMs: 10 });
  await assert.rejects(wrong.acquire(acquireOptions(cluster)), (error) => (
    error.status === 401 && /refused the sandbox pod \(401\)/.test(error.message) && !error.message.includes("not-the-token")
  ));
  assert.equal(cluster.pods.size, 0);
  assert.throws(() => createKubernetesProvider({ token: " " }), /requires an API token/);
});

test("the API server's CA is read from caFile for every call", async (t) => {
  const cluster = await fakeCluster(t);
  const read = [];
  const pods = provider(cluster, { readCa: async (path) => { read.push(path); return CA; } });
  const resource = await pods.acquire({ ...acquireOptions(cluster), caFile: "/etc/hurdle/cluster-ca.pem" });
  assert.deepEqual(read, ["/etc/hurdle/cluster-ca.pem"]);
  assert.equal(resource.api.ca, CA);
  await pods.dispose(resource);
});

test("Kubernetes settings pin the API server, namespace, image and nodes", () => {
  const base = { apiServer: "https://10.0.0.1:6443/", namespace: "hurdle", image: IMAGE, nodeSelector: { workload: "app" } };
  const settings = normalizeKubernetesSettings({}, base);
  assert.deepEqual(settings, {
    ...base, apiServer: "https://10.0.0.1:6443", maxLifetimeMs: 3_600_000, cpu: "1", memory: "2Gi", ephemeralStorage: "4Gi",
  });
  assert.ok(Object.isFrozen(settings));
  const refused = (value, pattern) => assert.throws(() => normalizeKubernetesSettings(value, base), pattern);
  refused({ token: "x" }, /'token' is unknown/);
  refused({ apiServer: "http://10.0.0.1:6443" }, /https URL/);
  refused({ apiServer: "https://operator@10.0.0.1:6443" }, /https URL/);
  refused({ apiServer: "https://10.0.0.1:6443/api" }, /https URL/);
  refused({ namespace: "Hurdle" }, /DNS label/);
  refused({ image: "registry.test/hurdle-sandbox:latest" }, /pinned by digest/);
  refused({ caFile: "ca.pem" }, /absolute path/);
  refused({ nodeSelector: {} }, /nodeSelector/);
  refused({ nodeSelector: { workload: 1 } }, /nodeSelector/);
  refused({ maxLifetimeMs: 999 }, /maxLifetimeMs/);
  refused({ maxLifetimeMs: 93_600_001 }, /maxLifetimeMs must be an integer from 1000 to 93600000/);
  refused({ maxLifetimeMs: "3600000" }, /maxLifetimeMs/);
  assert.equal(normalizeKubernetesSettings({ maxLifetimeMs: 93_600_000 }, base).maxLifetimeMs, 93_600_000);
  refused({ cpu: "0" }, /cpu/);
  refused({ cpu: 2 }, /cpu/);
  refused({ memory: "2G" }, /memory/);
  refused({ cpu: "3" }, /cpu/);
  refused({ cpu: "2001m" }, /cpu/);
  refused({ memory: "4097Mi" }, /memory/);
  refused({ memory: "5Gi" }, /memory/);
  refused({ cpu: "100m" }, /cpu/);
  refused({ memory: "256Mi" }, /memory/);
  refused({ ephemeralStorage: "512Mi" }, /ephemeralStorage/);
  refused({ ephemeralStorage: "11Gi" }, /ephemeralStorage/);
  refused({ ephemeralStorage: "4G" }, /ephemeralStorage/);
  assert.equal(normalizeKubernetesSettings({ ephemeralStorage: "10Gi" }, base).ephemeralStorage, "10Gi");
  assert.equal(normalizeKubernetesSettings({ cpu: "2", memory: "4Gi" }, base).memory, "4Gi");
  assert.equal(normalizeKubernetesSettings({ cpu: "1500m", memory: "512Mi" }, base).cpu, "1500m");
  assert.deepEqual(
    normalizeKubernetesSettings({ nodeSelector: { "node-role.test/cpu": "true" } }, base).nodeSelector,
    { "node-role.test/cpu": "true" },
  );
});

test("the Kubernetes environment refuses an incomplete provider", () => {
  assert.throws(() => createKubernetesExecutionEnvironment({ provider: { acquire() {} } }), /requires a provider/);
});

// A Kubernetes pod's kernel has no legacy iptables, and its runtime's default
// AppArmor profile refuses the bind mount, so the controller names the sandbox
// kind and the server seals with nftables and stages the workspace in place.
test("Kubernetes sandbox setup seals with nftables and stages in place", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hurdle-sandbox-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const caPath = join(root, "guardian-ca.pem");
  await writeFile(caPath, CA);
  const setup = async (sandbox) => {
    const commands = [];
    const staged = [];
    const workload = {
      commands: { run: async (command) => { commands.push(command); return { exitCode: 0, stdout: "GUARDIAN_BRIDGE_READY", stderr: "" }; } },
      files: { write: async () => {} },
    };
    const operations = (name) => ({ stage: async () => { staged.push(name); } });
    const task = createSandboxTask({
      caPath, nodeRuntimeRoot: "/opt/hurdle", workload,
      operations: operations("together"), kubernetesOperations: operations("kubernetes"),
    });
    await task.run({ kind: "setup", hosts: ["api.together.ai"], ...(sandbox ? { sandbox } : {}) });
    await task.run({ kind: "stage", fixtures: [], workspaceFiles: [] });
    const firewall = commands.find((command) => command.includes("--dport 57468 -j DROP"));
    return { firewall, staged, task };
  };
  const kubernetes = await setup("kubernetes");
  assert.match(kubernetes.firewall, /\/usr\/sbin\/iptables-nft \/usr\/sbin\/ip6tables-nft;/);
  assert.deepEqual(kubernetes.staged, ["kubernetes"]);
  const together = await setup(undefined);
  assert.match(together.firewall, /\/usr\/sbin\/iptables-legacy \/usr\/sbin\/ip6tables-legacy;/);
  assert.deepEqual(together.staged, ["together"]);
  await assert.rejects(together.task.run({ kind: "setup", hosts: [], sandbox: "e2b" }), /Unknown sandbox kind/);
  // The kind is fixed at the one setup: a later one cannot switch it.
  await assert.rejects(together.task.run({ kind: "setup", hosts: ["api.together.ai"], sandbox: "kubernetes" }), /already ran/);
  await together.task.run({ kind: "stage", fixtures: [], workspaceFiles: [] });
  assert.deepEqual(together.staged, ["together", "together"]);
});
