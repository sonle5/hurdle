import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTHROPIC_JSON_JUDGE_ID,
  createAnthropicJsonJudge,
} from "../lib/judges/anthropic-json.mjs";

function streamingResponse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

test("Anthropic JSON Judge exposes the fixed v2 capability", () => {
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    fetch: async () => { throw new Error("not invoked"); },
  });

  assert.equal(judge.id, ANTHROPIC_JSON_JUDGE_ID);
  assert.equal(judge.model, "claude-test-model");
  assert.deepEqual(judge.inputSchemaVersions, [2]);
  assert.equal(judge.maxTimeoutMs, 120_000);
  assert.equal(judge.maxInputBytes, 1_048_576);
  assert.equal(judge.maxOutputBytes, 4_096);
  assert.ok(Object.isFrozen(judge));
});

test("Anthropic JSON Judge sends the fixed evidence-only Messages protocol and reads streamed JSON", async () => {
  const requests = [];
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    async fetch(url, options) {
      requests.push({ url, options });
      return streamingResponse([
        {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: JSON.stringify({
              outcome: "pass",
              summary: "Evidence satisfies the rubric.",
            }),
          },
        },
        { type: "message_stop" },
      ]);
    },
  });

  const decision = await judge.judge({ schemaVersion: 2, run: { id: "run_1" } });

  assert.deepEqual(decision, {
    outcome: "pass",
    summary: "Evidence satisfies the rubric.",
  });
  assert.equal(requests.length, 1);
  const [{ url, options }] = requests;
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(options.method, "POST");
  assert.equal(options.headers["x-api-key"], "test-anthropic-key");
  assert.equal(options.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(options.body);
  assert.equal(body.model, "claude-test-model");
  assert.equal(body.stream, true);
  assert.equal("temperature" in body, false);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.deepEqual(JSON.parse(body.messages[0].content), { schemaVersion: 2, run: { id: "run_1" } });
  assert.match(body.system, /evidence-only/i);
  assert.match(body.system, /untrusted/i);
  assert.match(body.system, /exactly two keys/i);
  assert.equal("tools" in body, false);
});

test("Anthropic JSON Judge accepts only the exact decision and keeps provider failures secret-safe", async () => {
  const secret = "anthropic-provider-secret";
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: secret,
    async fetch() {
      return streamingResponse([
        {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: JSON.stringify({ outcome: "pass", summary: "Looks good.", extra: true }),
          },
        },
        { type: "message_stop" },
      ]);
    },
  });
  await assert.rejects(
    judge.judge({ schemaVersion: 2 }),
    (error) => error.message === "Anthropic JSON Judge returned invalid output"
      && !error.message.includes(secret),
  );

  const failedJudge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: secret,
    async fetch() {
      throw new Error(`upstream rejected ${secret}`);
    },
  });
  await assert.rejects(
    failedJudge.judge({ schemaVersion: 2 }),
    (error) => error.message === "Anthropic JSON Judge provider failed"
      && !error.message.includes(secret),
  );

  const streamedFailureJudge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: secret,
    async fetch() {
      return streamingResponse([{ type: "error", error: { message: secret } }]);
    },
  });
  await assert.rejects(
    streamedFailureJudge.judge({ schemaVersion: 2 }),
    (error) => error.message === "Anthropic JSON Judge provider failed"
      && !error.message.includes(secret),
  );
});

test("Anthropic JSON Judge bounds its wire data and forwards cancellation to fetch", async () => {
  let fetchCalls = 0;
  const boundedJudge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    async fetch() {
      fetchCalls += 1;
      throw new Error("should not fetch oversized request");
    },
  });
  await assert.rejects(
    boundedJudge.judge({ schemaVersion: 2, evidence: "x".repeat(1_048_576) }),
    /request exceeds its limit/,
  );
  assert.equal(fetchCalls, 0);

  let escapedFetchCalls = 0;
  const escapedInputJudge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    async fetch() {
      escapedFetchCalls += 1;
      return streamingResponse([
        {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: JSON.stringify({ outcome: "pass", summary: "Bounded input accepted." }),
          },
        },
        { type: "message_stop" },
      ]);
    },
  });
  const escapedDecision = await escapedInputJudge.judge({
    schemaVersion: 2,
    evidence: "\\".repeat(500_000),
  });
  assert.equal(escapedFetchCalls, 1);
  assert.equal(escapedDecision.outcome, "pass");

  let receivedSignal = null;
  const controller = new AbortController();
  const cancelledJudge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    fetch(_url, options) {
      receivedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  });
  const pending = cancelledJudge.judge({ schemaVersion: 2 }, { signal: controller.signal });
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(pending, /provider failed/);
  assert.equal(receivedSignal, controller.signal);
});

test("Anthropic JSON Judge fails closed on a provider error event", async () => {
  let streamCancelled = false;
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    async fetch() {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({
              type: "content_block_delta",
              delta: {
                type: "text_delta",
                text: JSON.stringify({ outcome: "pass", summary: "Must not survive." }),
              },
            })}\n\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "overloaded_error", message: "try later" },
            })}\n\n`,
          ));
        },
        cancel() {
          streamCancelled = true;
        },
      }));
    },
  });

  await assert.rejects(judge.judge({ schemaVersion: 2 }), /provider failed/);
  assert.equal(streamCancelled, true);
});
