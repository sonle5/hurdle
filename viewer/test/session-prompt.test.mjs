import assert from "node:assert/strict";
import test from "node:test";

import { withTaskPromptMessage } from "../lib/session-prompt.mjs";

test("prepends the snapshotted task prompt when a controller transcript does not echo it", () => {
  const messages = [{
    uuid: "assistant-1",
    parentUuid: null,
    timestamp: "2026-08-25T19:28:31.000Z",
    role: "assistant",
    msgType: "assistant",
    blocks: [{ type: "text", text: "I will inspect the fixture." }],
  }];

  const result = withTaskPromptMessage(messages, {
    prompt: "Read `fixtures/message.txt` and write it to `answer.txt`.",
    timestamp: "2026-08-25T19:28:30.000Z",
  });

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    uuid: "canonical-task-prompt",
    parentUuid: null,
    timestamp: "2026-08-25T19:28:30.000Z",
    role: "user",
    msgType: "user",
    blocks: [{
      type: "text",
      text: "Read `fixtures/message.txt` and write it to `answer.txt`.",
    }],
    rawText: "Read `fixtures/message.txt` and write it to `answer.txt`.",
  });
  assert.equal(result[1], messages[0]);
});

test("does not duplicate a real initial user prompt", () => {
  const messages = [{
    uuid: "user-1",
    parentUuid: null,
    timestamp: "2026-08-25T19:28:30.000Z",
    role: "user",
    msgType: "user",
    blocks: [{ type: "text", text: "Copy the fixture." }],
    rawText: "Copy the fixture.",
  }];

  assert.equal(withTaskPromptMessage(messages, {
    prompt: "Copy the fixture.",
    timestamp: "2026-08-25T19:28:29.000Z",
  }), messages);
});

test("does not mistake tool results for the initial user prompt", () => {
  const messages = [{
    uuid: "tool-result-1",
    parentUuid: null,
    timestamp: "2026-08-25T19:28:31.000Z",
    role: "user",
    msgType: "user",
    blocks: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
  }];

  const result = withTaskPromptMessage(messages, {
    prompt: "Copy the fixture.",
    timestamp: "2026-08-25T19:28:30.000Z",
  });

  assert.equal(result.length, 2);
  assert.equal(result[0].role, "user");
  assert.equal(result[0].rawText, "Copy the fixture.");
});
