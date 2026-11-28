import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { operatorModelPolicy } from "../lib/execution-environments/together-guardian.mjs";

const guardianPath = new URL("../verify/proxy/generic_guardian.py", import.meta.url);

const REAL = "composer_gateway_REAL_0123456789";
const STAND_IN = "tae_surrogate_STANDIN_9876543210";

// Loads the addon with a stubbed mitmproxy module and a faked resolver, so the
// checks are deterministic and need no network.
const PRELUDE = String.raw`
import json, os, runpy, socket, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {}, stream=False)

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy

ANSWERS = {"api.openai.com": ["104.18.0.1"], "api.anthropic.com": ["160.79.104.10"], "pypi.org": ["151.101.0.223"]}
def getaddrinfo(host, port, **kwargs):
    if host not in ANSWERS:
        raise socket.gaierror("no answer")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port or 0)) for ip in ANSWERS[host]]
socket.getaddrinfo = getaddrinfo

addon = runpy.run_path(os.environ["GUARDIAN_PATH"])["addons"][0]
REAL, STAND_IN = os.environ["REAL"], os.environ["STAND_IN"]
USAGE = os.path.join(os.path.dirname(os.environ["TAE_EGRESS_LOG"]), "model-usage.jsonl")

def flow(flow_id, host, path="/v1/responses", scheme="https", port=443, client="client-1"):
    request = types.SimpleNamespace(pretty_host=host, host=host, path=path, method="post", scheme=scheme,
        port=port, headers={"authorization": "Bearer " + STAND_IN}, stream=False, authority="")
    return types.SimpleNamespace(id=flow_id, request=request, response=None,
        client_conn=types.SimpleNamespace(id=client))

def connect(client, address):
    server = types.SimpleNamespace(id="server-" + client + str(address), address=address, error=None, sni=None)
    addon.server_connect(types.SimpleNamespace(server=server, client=types.SimpleNamespace(id=client)))
    return server

def respond(value, body, content_type="application/json", chunks=None):
    # Model routes are streamed: the body reaches the Agent through the stream callable.
    value.response = Response.make(200, b"", {"content-type": content_type, "x-request-id": "req-1"})
    addon.responseheaders(value)
    assert callable(value.response.stream)
    for chunk in (chunks or [body]) + [b""]:
        value.response.stream(chunk)
    addon.response(value)

def usage_lines():
    if not os.path.exists(USAGE):
        return []
    with open(USAGE) as handle:
        return [json.loads(line) for line in handle]

def journal():
    with open(os.environ["TAE_EGRESS_LOG"]) as handle:
        return [json.loads(line) for line in handle]
`;

const SUBSTITUTIONS = JSON.stringify([
  { surrogate: STAND_IN, value: REAL, hosts: ["api.openai.com", "api.anthropic.com"], headerNames: ["authorization", "x-api-key"] },
]);

function run(t, script, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "tae-upstreams-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return spawnSync("python3", ["-c", PRELUDE + script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      TAE_EGRESS_LOG: join(root, "requests.jsonl"),
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_SUBSTITUTIONS: SUBSTITUTIONS,
      TAE_EGRESS_INTERCEPT_ALL: "1",
      TAE_EGRESS_UPSTREAMS: JSON.stringify({ "api.openai.com": "http://127.0.0.1:4100/codex" }),
      REAL,
      STAND_IN,
      ...env,
    },
  });
}

function runAddon(t, script, env) {
  const result = run(t, script, env);
  assert.equal(result.status, 0, result.stderr);
}

test("an invalid upstream map or ceiling refuses start", (t) => {
  const invalid = [
    "not json",
    "[]",
    JSON.stringify({ "pypi.org": "http://127.0.0.1:4100" }),
    JSON.stringify({ "api.example.com": "http://127.0.0.1:4100" }),
    JSON.stringify({ "api.openai.com": "ftp://127.0.0.1:4100" }),
    JSON.stringify({ "api.openai.com": "http://10.0.0.5:4100" }),
    JSON.stringify({ "api.openai.com": "http://composer.internal:4100" }),
    JSON.stringify({ "api.openai.com": "http://localhost:4100" }),
    JSON.stringify({ "api.openai.com": "http://127.0.0.1" }),
    JSON.stringify({ "api.openai.com": "http://operator@127.0.0.1:4100" }),
    JSON.stringify({ "api.openai.com": "http://127.0.0.1:4100/codex?x=1" }),
    JSON.stringify({ "api.openai.com": "http://127.0.0.1:4100/codex#x" }),
    JSON.stringify({ "api.openai.com": 4100 }),
  ];
  for (const upstreams of invalid) {
    const result = run(t, "", { TAE_EGRESS_UPSTREAMS: upstreams });
    assert.notEqual(result.status, 0, upstreams);
    assert.match(result.stderr, /invalid upstream map/, upstreams);
  }
  for (const ceiling of ["0", "-1", "1e6", "ten"]) {
    const result = run(t, "", { TAE_EGRESS_TOKEN_CEILING: ceiling });
    assert.match(result.stderr, /invalid token ceiling/, ceiling);
  }
  const unmapped = run(t, "", { TAE_EGRESS_UPSTREAMS: "", TAE_EGRESS_TOKEN_CEILING: "100" });
  assert.match(unmapped.stderr, /token ceiling needs a model route/);
  runAddon(t, "", { TAE_EGRESS_UPSTREAMS: JSON.stringify({ "api.openai.com": "https://[::1]:4100/codex" }) });
});

test("a destination the sandbox names on loopback is still refused while the map is set", (t) => {
  runAddon(t, String.raw`
for host in ["127.0.0.1", "::1", "10.0.0.5"]:
    connect_flow = flow("connect-" + host, host)
    addon.http_connect(connect_flow)
    assert connect_flow.response.status_code == 403, host
    plain = flow("plain-" + host, host, scheme="http", port=4100)
    addon.requestheaders(plain)
    assert plain.response is not None and plain.response.status_code == 403, host
# Without a rewritten model request, the upstream itself cannot be dialed.
server = connect("client-2", ("127.0.0.1", 4100))
assert server.error == "destination is not a public address", server.error
`, { TAE_EGRESS_INTERCEPT_ALL: "1" });
  // localhost resolves on the controller; refusal must not depend on that.
  runAddon(t, String.raw`
ANSWERS["localhost"] = ["127.0.0.1"]
value = flow("named", "localhost", scheme="http", port=4100)
addon.requestheaders(value)
assert value.response.status_code == 403
`);
});

test("only the declared host is forwarded to its upstream, with its credential swapped", (t) => {
  runAddon(t, String.raw`
model = flow("model", "api.openai.com")
addon.requestheaders(model)
assert model.response is None
request = model.request
assert (request.scheme, request.host, request.port, request.path) == ("http", "127.0.0.1", 4100, "/codex/v1/responses")
assert request.headers["host"] == "127.0.0.1:4100"
assert request.headers["authorization"] == "Bearer " + REAL
server = connect("client-1", ("127.0.0.1", 4100))
assert server.error is None and server.address == ("127.0.0.1", 4100)
# The same client cannot reach another loopback port.
other = connect("client-1", ("127.0.0.1", 4101))
assert other.error == "destination is not a public address"
respond(model, b'{"usage": {"input_tokens": 3, "output_tokens": 4}}')
# The journal keeps the route the Agent named.
row = journal()[-1]
assert (row["scheme"], row["host"], row["path"], row["statusCode"]) == ("https", "api.openai.com", "/v1/responses", 200), row
assert usage_lines()[-1]["upstream"] == "http://127.0.0.1:4100"

# A credential host with no map entry keeps its public route.
anthropic = flow("anthropic", "api.anthropic.com", path="/v1/messages")
addon.requestheaders(anthropic)
assert anthropic.response is None
assert (anthropic.request.host, anthropic.request.port, anthropic.request.path) == ("api.anthropic.com", 443, "/v1/messages")
# Any other host is never forwarded to an upstream.
other_host = flow("pypi", "pypi.org", path="/simple/")
addon.requestheaders(other_host)
assert other_host.request.host == "pypi.org"
# A declared host over plaintext is refused rather than forwarded.
plain = flow("plain", "api.openai.com", scheme="http", port=80)
addon.requestheaders(plain)
assert plain.response.status_code == 403 and plain.request.host == "api.openai.com"
`);
});

test("the ceiling counts model tokens and refuses later model requests with 429", (t) => {
  runAddon(t, String.raw`
first = flow("first", "api.openai.com")
addon.requestheaders(first)
respond(first, json.dumps({"usage": {"input_tokens": 60, "output_tokens": 30,
    "input_tokens_details": {"cached_tokens": 20}}}).encode())
lines = usage_lines()
assert lines == [{"kind": "model-usage", "v": 1, "at": lines[0]["at"], "host": "api.openai.com", "status": 200,
    "input_tokens": 60, "output_tokens": 30, "cache_read_tokens": 20, "cache_creation_tokens": 0,
    "run_tokens_total": 90, "ceiling": 100, "request_id": "req-1", "upstream": "http://127.0.0.1:4100"}], lines

# Chat Completions usage also counts and reaches the ceiling.
second = flow("second", "api.openai.com", path="/v1/chat/completions")
addon.requestheaders(second)
respond(second, json.dumps({"usage": {"prompt_tokens": 7, "completion_tokens": 5}}).encode())
lines = usage_lines()
assert lines[1]["run_tokens_total"] == 102
assert lines[2]["kind"] == "model-ceiling" and lines[2]["run_tokens_total"] == 102 and lines[2]["ceiling"] == 100

third = flow("third", "api.openai.com")
addon.requestheaders(third)
assert third.response.status_code == 429
assert third.request.headers["authorization"] == "Bearer " + STAND_IN
assert len(usage_lines()) == 3
# Other hosts are not model routes and still pass.
other = flow("other", "pypi.org", path="/simple/")
addon.requestheaders(other)
assert other.response is None
# The usage log never enters the sealed journal.
assert all(row["kind"] == "http-request" for row in journal())
`, { TAE_EGRESS_TOKEN_CEILING: "100" });
});

test("streamed usage is counted from the final usage event", (t) => {
  runAddon(t, String.raw`
openai = flow("openai", "api.openai.com")
addon.requestheaders(openai)
completed = json.dumps({"type": "response.completed", "response": {"usage": {"input_tokens": 11, "output_tokens": 9}}})
event = ("event: response.output_text.delta\ndata: {\"delta\": \"hi\"}\n\nevent: response.completed\ndata: " + completed + "\n\n").encode()
respond(openai, None, "text/event-stream", [event[:50], event[50:93], event[93:]])
assert usage_lines()[-1]["input_tokens"] == 11 and usage_lines()[-1]["run_tokens_total"] == 20
`);
  runAddon(t, String.raw`
claude = flow("claude", "api.anthropic.com", path="/v1/messages")
addon.requestheaders(claude)
assert (claude.request.host, claude.request.path) == ("127.0.0.1", "/claude/v1/messages")
start = json.dumps({"type": "message_start", "message": {"usage": {"input_tokens": 5, "output_tokens": 1,
    "cache_read_input_tokens": 100, "cache_creation_input_tokens": 10}}})
delta = json.dumps({"type": "message_delta", "usage": {"output_tokens": 40}})
body = ("event: message_start\r\ndata: " + start + "\r\n\r\nevent: message_delta\r\ndata: " + delta + "\r\n\r\n").encode()
respond(claude, None, "text/event-stream; charset=utf-8", [body[:30], body[30:]])
row = usage_lines()[-1]
assert (row["input_tokens"], row["output_tokens"], row["cache_read_tokens"], row["cache_creation_tokens"]) == (5, 40, 100, 10), row
assert row["run_tokens_total"] == 155, row
`, { TAE_EGRESS_UPSTREAMS: JSON.stringify({ "api.anthropic.com": "http://127.0.0.1:4100/claude" }) });
});

test("the controller passes only the operator's model policy variables to the Guardian", () => {
  const upstreams = JSON.stringify({ "api.openai.com": "http://127.0.0.1:4100/codex" });
  assert.deepEqual(operatorModelPolicy({
    TAE_EGRESS_UPSTREAMS: upstreams,
    TAE_EGRESS_TOKEN_CEILING: "2000000",
    TAE_EGRESS_SUBSTITUTIONS: "[]",
    OPENAI_API_KEY: "host-only",
  }), { TAE_EGRESS_UPSTREAMS: upstreams, TAE_EGRESS_TOKEN_CEILING: "2000000" });
  assert.deepEqual(operatorModelPolicy({}), {});
});
