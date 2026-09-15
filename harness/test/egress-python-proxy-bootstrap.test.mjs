import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
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
  "python_proxy_bootstrap.py",
);

test("Python proxy bootstrap routes only Together aiohttp HTTP and WebSocket traffic", () => {
  const script = `
import asyncio
import importlib.util
import json
import os
import sys
import types

class ClientSession:
    def __init__(self, base_url=None):
        self._base_url = base_url

    async def _request(self, method, url, *args, **kwargs):
        return {
            "method": method,
            "url": url,
            "proxy_present": "proxy" in kwargs,
            "proxy": kwargs.get("proxy"),
        }

    def ws_connect(self, url, *args, **kwargs):
        return {
            "url": url,
            "proxy_present": "proxy" in kwargs,
            "proxy": kwargs.get("proxy"),
        }

aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientSession = ClientSession
sys.modules["aiohttp"] = aiohttp

original_init = ClientSession.__init__
os.environ["TAE_EGRESS_PROXY"] = "http://127.0.0.1:8080"

spec = importlib.util.spec_from_file_location("python_proxy_bootstrap", ${JSON.stringify(BOOTSTRAP)})
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)

async def main():
    session = ClientSession()
    based = ClientSession("https://api.together.ai/v1/")
    return {
        "init_unchanged": ClientSession.__init__ is original_init,
        "together_http": await session._request("GET", "https://api.together.xyz/v1/models"),
        "together_dotted": await session._request("GET", "https://API.TOGETHER.AI./v1/models"),
        "together_base_url": await based._request("POST", "chat/completions"),
        "unrelated_http": await session._request("GET", "https://example.com/data"),
        "lookalike_http": await session._request("GET", "https://api.together.ai.example.com/data"),
        "localhost_http": await session._request("GET", "http://127.0.0.1:8000/health"),
        "explicit_direct_http": await session._request("GET", "https://api.together.ai/v1/models", proxy=None),
        "together_ws": session.ws_connect("wss://api.together.ai/v1/realtime"),
        "unrelated_ws": session.ws_connect("wss://example.com/socket"),
        "explicit_direct_ws": session.ws_connect("wss://api.together.ai/v1/realtime", proxy=None),
    }

print(json.dumps(asyncio.run(main())))
`;

  const child = spawnSync("python3", ["-S", "-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PYTHONPATH: "",
      TAE_EGRESS_CA_BUNDLE: "",
      TAE_EGRESS_PROXY: "",
    },
  });

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  const proxy = "http://127.0.0.1:8080";

  assert.equal(result.init_unchanged, true);
  assert.equal(result.together_http.proxy, proxy);
  assert.equal(result.together_dotted.proxy, proxy);
  assert.equal(result.together_base_url.proxy, proxy);
  assert.equal(result.together_ws.proxy, proxy);

  for (const direct of [
    result.unrelated_http,
    result.lookalike_http,
    result.localhost_http,
    result.unrelated_ws,
  ]) {
    assert.equal(direct.proxy_present, false);
  }

  assert.deepEqual(result.explicit_direct_http, {
    method: "GET",
    url: "https://api.together.ai/v1/models",
    proxy_present: true,
    proxy: null,
  });
  assert.equal(result.explicit_direct_ws.proxy_present, true);
  assert.equal(result.explicit_direct_ws.proxy, null);
});

test("Python smoke instrumentation marks only urllib requests to exact Together API hosts", () => {
  const script = `
import importlib.util
import json
import urllib.request

spec = importlib.util.spec_from_file_location("python_proxy_bootstrap_smoke", ${JSON.stringify(BOOTSTRAP)})
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)

def marker(url):
    request = urllib.request.Request(url)
    headers = {key.lower(): value for key, value in request.header_items()}
    return headers.get("x-together-eval-egress-smoke-client")

print(json.dumps({
    "together": marker("https://api.together.xyz/v1/models"),
    "together_dotted": marker("https://API.TOGETHER.AI./v1/models"),
    "lookalike": marker("https://api.together.ai.example.com/v1/models"),
    "unrelated": marker("https://example.com/data"),
}))
`;

  const run = (enabled) => spawnSync("python3", ["-S", "-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PYTHONPATH: "",
      TAE_EGRESS_CA_BUNDLE: "",
      TAE_EGRESS_PROXY: "",
      TOGETHER_EGRESS_SMOKE: enabled ? "1" : "0",
    },
  });

  const enabled = run(true);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.deepEqual(JSON.parse(enabled.stdout), {
    together: "python-urllib",
    together_dotted: "python-urllib",
    lookalike: null,
    unrelated: null,
  });

  const disabled = run(false);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(JSON.parse(disabled.stdout), {
    together: null,
    together_dotted: null,
    lookalike: null,
    unrelated: null,
  });
});

test("Python proxy bootstrap routes websockets v12-v14 only for exact Together WSS hosts", () => {
  const script = `
import importlib.util
import json
import os
import sys
import tempfile
import types

attempts = []

def record_attempt(surface, uri, kwargs):
    attempts.append({"surface": surface, "uri": uri, "kwargs": kwargs})
    if uri.endswith("/attempt-error"):
        raise RuntimeError("expected attempt error")
    return "transport", "protocol"

class LegacyConnector:
    def __init__(self, surface, uri, kwargs):
        self.surface = surface
        self._uri = uri
        self.kwargs = kwargs
    async def _create_connection(self):
        return record_attempt(self.surface, self._uri, self.kwargs)

class AsyncioConnector:
    def __init__(self, uri, kwargs):
        self.uri = uri
        self.kwargs = kwargs
    async def create_connection(self):
        return record_attempt("asyncio", self.uri, self.kwargs)

def legacy_connect(uri, *args, **kwargs):
    if uri.endswith("/constructor-error"):
        raise RuntimeError("expected constructor error")
    return LegacyConnector("legacy", uri, kwargs)

def asyncio_connect(uri, *args, **kwargs):
    return AsyncioConnector(uri, kwargs)

websockets = types.ModuleType("websockets")
websockets.__path__ = []
websockets.__version__ = "13.1"
websockets.connect = legacy_connect
legacy = types.ModuleType("websockets.legacy")
legacy.__path__ = []
legacy_client = types.ModuleType("websockets.legacy.client")
legacy_client.connect = legacy_connect
asyncio_package = types.ModuleType("websockets.asyncio")
asyncio_package.__path__ = []
asyncio_client = types.ModuleType("websockets.asyncio.client")
asyncio_client.connect = asyncio_connect
client = types.ModuleType("websockets.client")
client.connect = legacy_connect
sys.modules.update({
    "websockets": websockets,
    "websockets.client": client,
    "websockets.legacy": legacy,
    "websockets.legacy.client": legacy_client,
    "websockets.asyncio": asyncio_package,
    "websockets.asyncio.client": asyncio_client,
})

bundle = tempfile.NamedTemporaryFile(delete=False)
bundle.close()
os.environ["TAE_EGRESS_CA_BUNDLE"] = bundle.name
os.environ["TAE_EGRESS_PROXY"] = "http://127.0.0.1:18082"

spec = importlib.util.spec_from_file_location("python_proxy_bootstrap_websockets", ${JSON.stringify(BOOTSTRAP)})
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)

class FakeSocket:
    def __init__(self):
        self.closed = False
    def close(self):
        self.closed = True

tunnels = []
def fake_tunnel(host, port):
    sock = FakeSocket()
    tunnels.append({"host": host, "port": port, "sock": sock})
    return sock

real_connect_guardian_tunnel = bootstrap._connect_guardian_tunnel
bootstrap._connect_guardian_tunnel = fake_tunnel
bootstrap.ssl.create_default_context = lambda **kwargs: {"created": kwargs}

caller_socket = FakeSocket()
caller_ssl = object()
connectors = [
    websockets.connect("wss://api.together.ai/v1/realtime"),
    client.connect("wss://api.together.ai/v1/audio/speech/websocket"),
    legacy_client.connect("wss://api.together.xyz/v1/models"),
    asyncio_client.connect("wss://api-inference.together.ai/v1/socket", ssl=caller_ssl),
    websockets.connect("wss://api.together.ai/v1/realtime", sock=caller_socket),
    websockets.connect("wss://example.com/socket"),
    websockets.connect("wss://api.together.ai.attacker.example/socket"),
    websockets.connect("ws://api.together.ai/socket"),
    websockets.connect("wss://api.together.ai:444/socket"),
]
attempt_error_connector = websockets.connect("wss://api.together.ai/attempt-error")
after_construction_tunnels = len(tunnels)
try:
    websockets.connect("wss://api.together.ai/constructor-error")
except RuntimeError as error:
    constructor_error = str(error)
else:
    constructor_error = None
constructor_error_tunnel_count = len(tunnels)

async def exercise():
    for connector in connectors:
        factory = getattr(
            connector,
            "create_connection",
            getattr(connector, "_create_connection", None),
        )
        await factory()
    try:
        await attempt_error_connector._create_connection()
    except RuntimeError as error:
        return str(error)
    return None

attempt_error = __import__("asyncio").run(exercise())
attempt_error_socket_closed = tunnels[-1]["sock"].closed

class RefusingSocket:
    def __init__(self):
        self.closed = False
    def settimeout(self, _timeout):
        pass
    def sendall(self, _request):
        pass
    def recv(self, _size):
        return b"HTTP/1.1 403 Forbidden\\r\\nContent-Length: 0\\r\\n\\r\\n"
    def close(self):
        self.closed = True

refusing_socket = RefusingSocket()
bootstrap.socket.create_connection = lambda *_args, **_kwargs: refusing_socket
try:
    real_connect_guardian_tunnel("api.together.ai", 443)
except RuntimeError as error:
    connect_error = str(error)
else:
    connect_error = None

safe_attempts = []
for call in attempts:
    kwargs = dict(call["kwargs"])
    if "sock" in kwargs:
        kwargs["sock"] = "caller" if kwargs["sock"] is caller_socket else "guardian"
    if "ssl" in kwargs:
        kwargs["ssl"] = "caller" if kwargs["ssl"] is caller_ssl else "guardian"
    safe_attempts.append({**call, "kwargs": kwargs})

print(json.dumps({
    "attempts": safe_attempts,
    "tunnels": [{"host": item["host"], "port": item["port"]} for item in tunnels],
    "after_construction_tunnels": after_construction_tunnels,
    "caller_socket_closed": caller_socket.closed,
    "constructor_error": constructor_error,
    "constructor_error_tunnel_count": constructor_error_tunnel_count,
    "attempt_error": attempt_error,
    "attempt_error_socket_closed": attempt_error_socket_closed,
    "connect_error": connect_error,
    "refusing_socket_closed": refusing_socket.closed,
}))
`;
  const child = spawnSync("python3", ["-S", "-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PYTHONPATH: "",
      TAE_EGRESS_CA_BUNDLE: "",
      TAE_EGRESS_PROXY: "",
    },
  });

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.tunnels, [
    { host: "api.together.ai", port: 443 },
    { host: "api.together.ai", port: 443 },
    { host: "api.together.xyz", port: 443 },
    { host: "api-inference.together.ai", port: 443 },
    { host: "api.together.ai", port: 443 },
  ]);
  assert.equal(result.after_construction_tunnels, 0);
  assert.deepEqual(result.attempts.slice(0, 4).map((call) => call.kwargs), [
    {
      sock: "guardian",
      server_hostname: "api.together.ai",
      ssl: "guardian",
    },
    {
      sock: "guardian",
      server_hostname: "api.together.ai",
      ssl: "guardian",
    },
    {
      sock: "guardian",
      server_hostname: "api.together.xyz",
      ssl: "guardian",
    },
    {
      sock: "guardian",
      server_hostname: "api-inference.together.ai",
      ssl: "caller",
    },
  ]);
  assert.equal(result.attempts[4].kwargs.sock, "caller");
  for (const direct of result.attempts.slice(5, 9)) {
    assert.equal(direct.kwargs.sock, undefined);
    assert.equal(direct.kwargs.ssl, undefined);
    assert.equal(direct.kwargs.server_hostname, undefined);
  }
  assert.equal(result.caller_socket_closed, false);
  assert.equal(result.constructor_error, "expected constructor error");
  assert.equal(result.constructor_error_tunnel_count, 0);
  assert.equal(result.attempt_error, "expected attempt error");
  assert.equal(result.attempt_error_socket_closed, true);
  assert.match(result.connect_error, /CONNECT failed: HTTP\/1\.1 403 Forbidden/);
  assert.equal(result.refusing_socket_closed, true);
});

test("Python proxy bootstrap opens a fresh guardian tunnel for each connector attempt", () => {
  const script = `
import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import types

attempts = []

class FakeConnector:
    def __init__(self, uri, kwargs):
        self.uri = uri
        self.kwargs = kwargs
    async def _create_connection(self):
        sock = self.kwargs.get("sock")
        attempts.append({
            "socket": id(sock) if sock is not None else None,
            "already_closed": bool(sock and sock.closed),
        })
        if sock is not None:
            sock.close()
        return "transport", "protocol"

def original_connect(uri, **kwargs):
    return FakeConnector(uri, kwargs)

websockets = types.ModuleType("websockets")
websockets.__path__ = []
websockets.__version__ = "13.1"
websockets.connect = original_connect
sys.modules["websockets"] = websockets

bundle = tempfile.NamedTemporaryFile(delete=False)
bundle.close()
os.environ["TAE_EGRESS_CA_BUNDLE"] = bundle.name
os.environ["TAE_EGRESS_PROXY"] = "http://127.0.0.1:18082"

spec = importlib.util.spec_from_file_location("python_proxy_bootstrap_reconnect", ${JSON.stringify(BOOTSTRAP)})
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)

class FakeSocket:
    def __init__(self):
        self.closed = False
    def close(self):
        self.closed = True

tunnels = []
def fake_tunnel(_host, _port):
    sock = FakeSocket()
    tunnels.append(sock)
    return sock

bootstrap._connect_guardian_tunnel = fake_tunnel
bootstrap.ssl.create_default_context = lambda **kwargs: {"created": kwargs}

abandoned = websockets.connect("wss://api.together.ai/abandoned")
after_abandoned_construction = len(tunnels)
connector = websockets.connect("wss://api.together.ai/reconnect")
after_connector_construction = len(tunnels)

async def exercise():
    await connector._create_connection()
    await connector._create_connection()

asyncio.run(exercise())
print(json.dumps({
    "after_abandoned_construction": after_abandoned_construction,
    "after_connector_construction": after_connector_construction,
    "tunnel_count": len(tunnels),
    "attempts": attempts,
    "distinct_attempt_sockets": len(set(item["socket"] for item in attempts)),
}))
`;
  const child = spawnSync("python3", ["-S", "-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PYTHONPATH: "",
      TAE_EGRESS_CA_BUNDLE: "",
      TAE_EGRESS_PROXY: "",
    },
  });

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result, {
    after_abandoned_construction: 0,
    after_connector_construction: 0,
    tunnel_count: 2,
    attempts: [
      { socket: result.attempts[0].socket, already_closed: false },
      { socket: result.attempts[1].socket, already_closed: false },
    ],
    distinct_attempt_sockets: 2,
  });
});

test("Python proxy bootstrap leaves v15 native clients untouched and wraps legacy imports", () => {
  const script = `
import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import types

attempts = []

class LegacyConnector:
    def __init__(self, uri, kwargs):
        self._uri = uri
        self.kwargs = kwargs
    async def _create_connection(self):
        attempts.append(self.kwargs)
        return "transport", "protocol"

class NativeConnector:
    def __init__(self, uri, kwargs):
        self.uri = uri
        self.kwargs = kwargs
    async def create_connection(self):
        return "native"

def legacy_connect(uri, **kwargs):
    return LegacyConnector(uri, kwargs)

def native_connect(uri, **kwargs):
    return NativeConnector(uri, kwargs)

legacy_connect.__module__ = "websockets.legacy.client"
native_connect.__module__ = "websockets.asyncio.client"

websockets = types.ModuleType("websockets")
websockets.__path__ = []
websockets.__version__ = "15.0"
websockets.connect = native_connect
client = types.ModuleType("websockets.client")
client.connect = legacy_connect
legacy = types.ModuleType("websockets.legacy")
legacy.__path__ = []
legacy_client = types.ModuleType("websockets.legacy.client")
legacy_client.connect = legacy_connect
asyncio_package = types.ModuleType("websockets.asyncio")
asyncio_package.__path__ = []
asyncio_client = types.ModuleType("websockets.asyncio.client")
asyncio_client.connect = native_connect
sys.modules.update({
    "websockets": websockets,
    "websockets.client": client,
    "websockets.legacy": legacy,
    "websockets.legacy.client": legacy_client,
    "websockets.asyncio": asyncio_package,
    "websockets.asyncio.client": asyncio_client,
})

bundle = tempfile.NamedTemporaryFile(delete=False)
bundle.close()
os.environ["TAE_EGRESS_CA_BUNDLE"] = bundle.name
os.environ["TAE_EGRESS_PROXY"] = "http://127.0.0.1:18082"

spec = importlib.util.spec_from_file_location("python_proxy_bootstrap_v15_surfaces", ${JSON.stringify(BOOTSTRAP)})
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)

class FakeSocket:
    def close(self):
        pass

tunnels = []
def fake_tunnel(host, port):
    tunnels.append({"host": host, "port": port})
    return FakeSocket()

bootstrap._connect_guardian_tunnel = fake_tunnel
bootstrap.ssl.create_default_context = lambda **kwargs: {"created": kwargs}

connector = client.connect("wss://api.together.ai/v1/realtime")
after_construction_tunnels = len(tunnels)
asyncio.run(connector._create_connection())
attempt_kwargs = dict(attempts[0])
attempt_kwargs["sock"] = "guardian"
attempt_kwargs["ssl"] = "guardian"

print(json.dumps({
    "top_identity_preserved": websockets.connect is native_connect,
    "asyncio_identity_preserved": asyncio_client.connect is native_connect,
    "client_adapter": bool(getattr(client.connect, "_together_guardian_websocket", False)),
    "legacy_adapter": bool(getattr(legacy_client.connect, "_together_guardian_websocket", False)),
    "after_construction_tunnels": after_construction_tunnels,
    "tunnels": tunnels,
    "attempt_kwargs": attempt_kwargs,
}))
`;
  const child = spawnSync("python3", ["-S", "-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PYTHONPATH: "",
      TAE_EGRESS_CA_BUNDLE: "",
      TAE_EGRESS_PROXY: "",
    },
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    top_identity_preserved: true,
    asyncio_identity_preserved: true,
    client_adapter: true,
    legacy_adapter: true,
    after_construction_tunnels: 0,
    tunnels: [{ host: "api.together.ai", port: 443 }],
    attempt_kwargs: {
      ssl: "guardian",
      sock: "guardian",
      server_hostname: "api.together.ai",
    },
  });
});

test("Python proxy bootstrap leaves v11 and the v15 native surface untouched", () => {
  const script = `
import importlib.util
import json
import os
import sys
import tempfile
import types

def original_connect(uri, **kwargs):
    return {"uri": uri, "kwargs": kwargs}

bundle = tempfile.NamedTemporaryFile(delete=False)
bundle.close()
os.environ["TAE_EGRESS_CA_BUNDLE"] = bundle.name
os.environ["TAE_EGRESS_PROXY"] = "http://127.0.0.1:18082"

results = {}
for version in ("11.0", "15.0"):
    websockets = types.ModuleType("websockets")
    websockets.__path__ = []
    websockets.__version__ = version
    websockets.connect = original_connect
    sys.modules["websockets"] = websockets
    spec = importlib.util.spec_from_file_location(
        f"python_proxy_bootstrap_websockets_{version.replace('.', '_')}",
        ${JSON.stringify(BOOTSTRAP)},
    )
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    results[version] = {
        "identity_preserved": websockets.connect is original_connect,
        "result": websockets.connect("wss://api.together.ai/v1/realtime"),
    }
print(json.dumps(results))
`;
  const child = spawnSync("python3", ["-S", "-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PYTHONPATH: "",
      TAE_EGRESS_CA_BUNDLE: "",
      TAE_EGRESS_PROXY: "",
    },
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    "11.0": {
      identity_preserved: true,
      result: {
        uri: "wss://api.together.ai/v1/realtime",
        kwargs: {},
      },
    },
    "15.0": {
      identity_preserved: true,
      result: {
        uri: "wss://api.together.ai/v1/realtime",
        kwargs: {},
      },
    },
  });
});
