import assert from "node:assert/strict";
import test from "node:test";

import {
  createCaptureRequest,
  normalizeEgressCollections,
} from "../lib/egress-evidence.mjs";

const observedAt = "2026-08-22T10:00:00.000Z";
const provenance = {
  producer: "controlled-target-secret-observer",
  authority: "environment",
  lifecyclePhase: "execution",
  capturedAt: observedAt,
  trust: "environment-observed",
};

function httpEvent(overrides = {}) {
  return {
    kind: "http-request",
    sequence: 0,
    observedAt,
    method: "POST",
    scheme: "https",
    host: "api.example.com",
    path: "/v1/chat/target-secret",
    statusCode: 200,
    durationMs: 1,
    selectedFields: {
      "x-selected": "target-secret",
      "x-dropped": "must-not-persist",
    },
    ...overrides,
  };
}

function websocketEvent(overrides = {}) {
  return {
    kind: "websocket-session",
    sequence: 1,
    observedAt,
    scheme: "wss",
    host: "api.example.com",
    path: "/v1/realtime",
    statusCode: 101,
    durationMs: 2,
    framesSent: 1,
    bytesSent: 12,
    framesReceived: 2,
    bytesReceived: 24,
    selectedFields: {},
    ...overrides,
  };
}

test("network egress normalization emits one redacted discriminated stream", () => {
  const normalized = normalizeEgressCollections({
    collections: [{
      status: "captured",
      requests: [httpEvent(), websocketEvent()],
      provenance,
    }],
    selectedFieldNames: ["x-selected"],
    redactText: (value) => String(value).replaceAll("target-secret", "<REDACTED>"),
  });

  assert.deepEqual(normalized[0].requests.map(({ kind }) => kind), [
    "http-request",
    "websocket-session",
  ]);
  assert.equal(normalized[0].requests[0].path, "/v1/chat/<REDACTED>");
  assert.deepEqual(normalized[0].requests[0].selectedFields, {
    "x-selected": "<REDACTED>",
  });
  assert.equal(normalized[0].provenance.producer, "controlled-<REDACTED>-observer");
  assert.doesNotMatch(JSON.stringify(normalized), /target-secret|must-not-persist/);
});

test("network egress normalization rejects malformed session contracts", () => {
  const cases = [
    ["unknown kind", [httpEvent({ kind: "voice-session" })]],
    ["missing kind", [httpEvent({ kind: undefined })]],
    ["method on session", [httpEvent(), websocketEvent({ method: "GET" })]],
    ["query persistence", [httpEvent({ path: "/v1/chat?secret=1" })]],
    ["unsafe counter", [httpEvent(), websocketEvent({ bytesReceived: 2 ** 54 })]],
    ["payload-bearing field", [httpEvent({ requestBody: "must-not-persist" })]],
    ["cross-variant field", [httpEvent(), websocketEvent({ method: undefined })]],
    ["non-contiguous sequence", [httpEvent({ sequence: 2 })]],
  ];
  for (const [name, requests] of cases) {
    assert.throws(() => normalizeEgressCollections({
      collections: [{ status: "captured", requests, provenance }],
      selectedFieldNames: [],
      redactText: String,
    }), /invalid (?:captured egress|egress request)/, name);
  }
});

test("network egress provenance is closed before persistence", () => {
  assert.throws(() => normalizeEgressCollections({
    collections: [{
      status: "captured",
      requests: [httpEvent()],
      provenance: {
        ...provenance,
        debugCredential: "target-secret",
      },
    }],
    selectedFieldNames: [],
    redactText: (value) => String(value).replaceAll("target-secret", "<REDACTED>"),
  }), /invalid egress provenance/);
});

test("capture requests carry explicit protocols without product semantics", () => {
  assert.deepEqual(createCaptureRequest({
    egress: {
      relevantHosts: ["api.example.com"],
      selectedFields: ["x-cluster"],
      protocols: ["https", "wss"],
    },
  }), {
    mode: "network-egress-metadata-v1",
    protocols: ["https", "wss"],
    routes: [{ host: "api.example.com", selectedFields: ["x-cluster"] }],
  });
});
