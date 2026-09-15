import assert from "node:assert/strict";
import test from "node:test";
import {
  SDK_CONTROLLER_FRAME_PREFIX,
  appendControllerTranscript,
  canRetryWithoutControllerTranscript,
  createBoundedControllerCapture,
  decodeControllerJsonl,
  extractControllerAttempt,
  extractSdkControllerTranscript,
  normalizeControllerJsonl,
  normalizePrintControllerTranscript,
  parseClaudeControllerMetadata,
} from "../lib/controller-transcript.mjs";

test("normalizes print stream JSON and reads the selected result metadata", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }),
    JSON.stringify({
      type: "assistant",
      session_id: "session-1",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", session_id: "session-1", result: "done" }),
  ].join("\n");

  assert.equal(parseClaudeControllerMetadata(stream).session_id, "session-1");
  const decoded = decodeControllerJsonl(stream);
  assert.equal(decoded.frames.length, 3);
  assert.equal(normalizeControllerJsonl(stream), decoded.transcript);
  assert.equal(normalizePrintControllerTranscript(stream), decoded.transcript);
  assert.throws(
    () => normalizePrintControllerTranscript(`${stream}\nnot-json\n`),
    { code: "CONTROLLER_TRANSCRIPT_INVALID_FRAME" },
  );
});

test("extracts only token-bound full SDK frames", () => {
  const token = "controller-secret";
  const fullMessage = {
    type: "user",
    session_id: "session-2",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "exit_code=0\nreal output",
      }],
    },
  };
  const stderr = [
    "ordinary warning",
    `${SDK_CONTROLLER_FRAME_PREFIX}wrong-token:${JSON.stringify({ type: "assistant" })}`,
    `${SDK_CONTROLLER_FRAME_PREFIX}${token}:${JSON.stringify(fullMessage)}`,
  ].join("\n");

  assert.deepEqual(
    JSON.parse(extractSdkControllerTranscript(stderr, token).trim()),
    fullMessage,
  );
});

test("incremental SDK capture ignores chunked pretty-printed metadata", () => {
  const token = "controller-secret";
  const frame = {
    type: "assistant",
    session_id: "session-chunked",
    message: { content: [{ type: "text", text: "working" }] },
  };
  const stdoutCapture = createBoundedControllerCapture();
  const stderrCapture = createBoundedControllerCapture();
  stdoutCapture.append("{\n  \"runner\": \"sdk\",\n");
  stderrCapture.append(
    `${SDK_CONTROLLER_FRAME_PREFIX}${token}:${JSON.stringify(frame)}\n`,
  );

  assert.deepEqual(
    extractControllerAttempt({
      runner: "sdk",
      stdout: stdoutCapture.snapshot().text,
      stderr: stderrCapture.snapshot().text,
      sdkToken: token,
      final: false,
    }),
    {
      metadata: null,
      transcript: `${JSON.stringify(frame)}\n`,
    },
  );

  stdoutCapture.append("  \"session_id\": \"session-chunked\"\n}\n");
  assert.equal(
    extractControllerAttempt({
      runner: "sdk",
      stdout: stdoutCapture.snapshot().text,
      stderr: stderrCapture.snapshot().text,
      sdkToken: token,
      final: true,
    }).metadata.session_id,
    "session-chunked",
  );
});

test("final SDK capture keeps token-bound transcript when metadata is truncated", () => {
  const token = "controller-secret";
  const frame = {
    type: "result",
    subtype: "success",
    session_id: "session-truncated-metadata",
    result: "done",
  };

  assert.deepEqual(
    extractControllerAttempt({
      runner: "sdk",
      stdout: "{\n  \"runner\": \"sdk\",\n  \"result\": \"truncated",
      stderr: `${SDK_CONTROLLER_FRAME_PREFIX}${token}:${JSON.stringify(frame)}\n`,
      sdkToken: token,
      final: true,
    }),
    {
      metadata: null,
      transcript: `${JSON.stringify(frame)}\n`,
    },
  );
});

test("buckets resumed controller segments by session and fails closed on capture overflow", () => {
  const store = new Map();
  appendControllerTranscript(store, "session-3", "{\"type\":\"assistant\",\"turn\":1}\n");
  appendControllerTranscript(store, "session-3", "{\"type\":\"assistant\",\"turn\":2}\n");
  appendControllerTranscript(store, "session-other", "{\"type\":\"assistant\",\"turn\":1}\n");
  assert.match(store.get("session-3"), /"turn":1[\s\S]*"turn":2/);
  assert.doesNotMatch(store.get("session-3"), /session-other/);

  const capture = createBoundedControllerCapture(5);
  capture.append("1234");
  capture.append("56");
  assert.deepEqual(capture.snapshot(), {
    text: "1234",
    bytes: 4,
    complete: false,
    droppedBytes: 2,
    maxBytes: 5,
  });
});

test("only a recoverable prompt-overflow attempt may omit controller frames", () => {
  assert.equal(canRetryWithoutControllerTranscript({
    promptOverflow: true,
    willRetry: true,
  }), true);
  assert.equal(canRetryWithoutControllerTranscript({
    promptOverflow: true,
    willRetry: false,
  }), false);
  assert.equal(canRetryWithoutControllerTranscript({
    promptOverflow: false,
    willRetry: true,
  }), false);
});
