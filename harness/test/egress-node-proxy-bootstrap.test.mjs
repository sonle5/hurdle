import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

process.env.TAE_EGRESS_CAPTURE_HOSTS = JSON.stringify([
  "api.together.ai",
  "api.together.xyz",
  "api-inference.together.ai",
]);

const BOOTSTRAP = join(
  import.meta.dirname,
  "..",
  "verify",
  "proxy",
  "node_proxy_bootstrap.cjs",
);
const HARNESS_NODE_MODULES = join(
  import.meta.dirname,
  "..",
  "node_modules",
);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runNode(args, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("Node proxy bootstrap routes a real Together WebSocket handshake through the proxy", async (t) => {
  let directConnections = 0;
  let proxyRequest = "";
  const directServer = createServer((socket) => {
    directConnections += 1;
    socket.destroy();
  });
  const proxyServer = createServer((socket) => {
    socket.on("data", (chunk) => {
      proxyRequest += chunk.toString("latin1");
      if (proxyRequest.includes("\r\n\r\n")) {
        socket.end("HTTP/1.1 502 Expected Test Response\r\nContent-Length: 0\r\n\r\n");
      }
    });
  });
  t.after(async () => {
    await Promise.all([close(directServer), close(proxyServer)]);
  });
  await Promise.all([listen(directServer), listen(proxyServer)]);

  const directPort = directServer.address().port;
  const proxyPort = proxyServer.address().port;
  const script = `
const WebSocket = require("ws");
const socket = new WebSocket("wss://api.together.ai:${directPort}/v1/realtime", {
  headers: { Authorization: "Bearer sandbox-visible-key" },
  lookup(_hostname, options, callback) {
    if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  },
});
socket.once("error", () => process.exit(0));
setTimeout(() => process.exit(2), 3_000);
`;
  const child = await runNode(["--require", BOOTSTRAP, "-e", script], {
    env: {
      ...process.env,
      NODE_PATH: [HARNESS_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(delimiter),
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(directConnections, 0, "real ws bypassed the proxy and opened a direct TLS connection");
  assert.match(proxyRequest, new RegExp(`^CONNECT api\\.together\\.ai:${directPort} HTTP/1\\.1\\r\\n`));

  const proxyRequestAfterTogether = proxyRequest;
  const unrelatedScript = script.replace("api.together.ai", "example.com");
  const unrelated = await runNode(["--require", BOOTSTRAP, "-e", unrelatedScript], {
    env: {
      ...process.env,
      NODE_PATH: [HARNESS_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(delimiter),
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(directConnections, 1, "an unrelated WebSocket should retain its direct route");
  assert.equal(proxyRequest, proxyRequestAfterTogether, "the selective proxy must ignore unrelated WebSockets");
});

test("Node proxy bootstrap routes Together fetch and https traffic only", () => {
  const dir = mkdtempSync(join(tmpdir(), "egress-node-proxy-"));
  try {
    const modules = join(dir, "node_modules");
    const bootstrap = join(dir, "node_proxy_bootstrap.cjs");
    copyFileSync(BOOTSTRAP, bootstrap);
    mkdirSync(join(modules, "undici"), { recursive: true });
    mkdirSync(join(modules, "https-proxy-agent"), { recursive: true });

    writeFileSync(join(modules, "undici", "index.js"), `
const direct = { dispatch() { global.__undiciRoutes.push("direct"); return "direct"; } };
let current = direct;
class ProxyAgent {
  dispatch() { global.__undiciRoutes.push("proxy"); return "proxy"; }
  close() {}
  destroy() {}
}
exports.getGlobalDispatcher = () => direct;
exports.ProxyAgent = ProxyAgent;
exports.setGlobalDispatcher = (value) => { current = value; };
exports.currentDispatcher = () => current;
`);
    writeFileSync(join(modules, "https-proxy-agent", "index.js"), `
class HttpsProxyAgent {
  addRequest() { global.__httpsRoutes.push("proxy"); return "proxy"; }
  destroy() {}
}
exports.HttpsProxyAgent = HttpsProxyAgent;
`);

    const script = `
global.__undiciRoutes = [];
global.__httpsRoutes = [];
const undici = require("undici");
const https = require("node:https");
undici.currentDispatcher().dispatch({ origin: "https://api.together.ai" }, {});
undici.currentDispatcher().dispatch({ origin: "https://example.com" }, {});
undici.currentDispatcher().dispatch({ origin: "https://docs.together.ai" }, {});
https.globalAgent.addRequest({}, { hostname: "api.together.xyz" });
console.log(JSON.stringify({ undici: global.__undiciRoutes, https: global.__httpsRoutes }));
`;
    const child = spawnSync(process.execPath, ["--require", bootstrap, "-e", script], {
      encoding: "utf-8",
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        NODE_PATH: modules,
        HTTPS_PROXY: "http://127.0.0.1:8080",
        HTTP_PROXY: "http://127.0.0.1:8080",
      },
    });

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      undici: ["proxy", "direct", "direct"],
      https: ["proxy"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Node smoke instrumentation marks only built-in fetch requests to exact Together API hosts", () => {
  const dir = mkdtempSync(join(tmpdir(), "egress-node-smoke-marker-"));
  try {
    const modules = join(dir, "node_modules");
    mkdirSync(join(modules, "undici"), { recursive: true });
    mkdirSync(join(modules, "https-proxy-agent"), { recursive: true });
    writeFileSync(join(modules, "undici", "index.js"), `
const direct = { dispatch() {}, close() {}, destroy() {} };
class ProxyAgent { dispatch() {} close() {} destroy() {} }
exports.getGlobalDispatcher = () => direct;
exports.ProxyAgent = ProxyAgent;
exports.setGlobalDispatcher = () => {};
`);
    writeFileSync(join(modules, "https-proxy-agent", "index.js"), `
class HttpsProxyAgent { addRequest() {} destroy() {} }
exports.HttpsProxyAgent = HttpsProxyAgent;
`);

    const script = `
const calls = [];
global.fetch = async (input, init) => {
  const request = new Request(input, init);
  calls.push({
    url: request.url,
    marker: request.headers.get("x-together-eval-egress-smoke-client"),
  });
  return { status: 200 };
};
require(${JSON.stringify(BOOTSTRAP)});

(async () => {
  await fetch("https://api.together.xyz/v1/models");
  await fetch("https://API.TOGETHER.AI./v1/models");
  await fetch("https://api.together.ai.example.com/v1/models");
  await fetch("https://example.com/data");
  console.log(JSON.stringify(calls));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

    const run = (enabled) => spawnSync(process.execPath, ["-e", script], {
      encoding: "utf-8",
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        NODE_PATH: modules,
        HTTPS_PROXY: "http://127.0.0.1:8080",
        HTTP_PROXY: "http://127.0.0.1:8080",
        TOGETHER_EGRESS_SMOKE: enabled ? "1" : "0",
      },
    });

    const enabled = run(true);
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.deepEqual(JSON.parse(enabled.stdout).map(({ marker }) => marker), [
      "node-fetch",
      "node-fetch",
      null,
      null,
    ]);

    const disabled = run(false);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.deepEqual(JSON.parse(disabled.stdout).map(({ marker }) => marker), [null, null, null, null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
