import assert from "node:assert/strict";
import test from "node:test";

import { redactEvidenceText } from "../lib/evidence-redaction.mjs";
import * as redaction from "../lib/evidence-redaction.mjs";

test("known secret redaction consumes the entire printed prefix, not just its first eight characters", () => {
  const secret = "7b19d03af6482ce1950b6743aedef972";
  for (let length = 8; length <= secret.length; length += 1) {
    const text = `prefix=${secret.slice(0, length)}...\n`;
    assert.equal(redaction.redactSecretText(text, [secret]), "prefix=<REDACTED>...\n");
  }
});

test("known secret redaction picks the longest match across shared prefixes in either order", () => {
  const short = "shared-key";
  const long = "shared-key-with-more-credential-bytes";
  for (const secrets of [[short, long], [long, short]]) {
    assert.equal(
      redaction.redactSecretText(`${short} ${long} ${long.slice(0, 20)}`, secrets),
      "<REDACTED> <REDACTED> <REDACTED>",
    );
  }
});

test("known secret redaction leaves unrelated bytes and fragments below the threshold unchanged", () => {
  const secret = "7b19d03af6482ce1950b6743aedef972";
  const clean = '{ "n": 1e5, "text": "caf\\u00e9", "short": "7b19d03" }\n';
  assert.equal(redaction.redactSecretText(clean, [secret]), clean);
  assert.equal(redaction.redactSecretText(clean, ["", null, undefined]), clean);
  assert.equal(redaction.redactSecretText("tiny-token", ["tiny"]), "<REDACTED>-token");
});

test("known secret redaction handles escaped credentials and preserves surrounding binary bytes", () => {
  const secret = 'abcdefghi\n"more-secret-bytes';
  const encoded = JSON.stringify({ key: secret.slice(0, 20) });
  assert.deepEqual(JSON.parse(redaction.redactSecretText(encoded, [secret])), { key: "<REDACTED>" });
  const before = Buffer.from([0xff, 0x00, 0x80]);
  const after = Buffer.from([0xfe, 0x01]);
  assert.deepEqual(
    redaction.redactSecretBytes(Buffer.concat([before, Buffer.from(secret.slice(0, 20)), after]), [secret]),
    Buffer.concat([before, Buffer.from("<REDACTED>"), after]),
  );
});

test("known secret redaction handles JSON Unicode escapes embedded in diagnostic text", () => {
  const secret = "password123456789";
  const fullyEncoded = [...secret]
    .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");
  const cases = [
    ["diagnostic credential=p\\u0061ssword123456789", "diagnostic credential=<REDACTED>"],
    [`diagnostic credential=${fullyEncoded}`, "diagnostic credential=<REDACTED>"],
    ["diagnostic credential=p\\u0061ssword1234...", "diagnostic credential=<REDACTED>..."],
  ];

  for (const [text, expected] of cases) {
    assert.equal(redaction.redactSecretText(text, [secret]), expected);
  }
  assert.equal(
    redaction.redactSecretBytes(Buffer.from(`credential=${fullyEncoded}`), [secret]).toString("utf8"),
    "credential=<REDACTED>",
  );
  assert.equal(
    redaction.redactSecretText("diagnostic=not\\u0020a\\u0020credential", [secret]),
    "diagnostic=not\\u0020a\\u0020credential",
  );
  assert.equal(
    redaction.redactSecretText(
      "credential=1234567\\uD83D\\uDE00-test-credential",
      ["1234567😀-test-credential"],
    ),
    "credential=<REDACTED>",
  );
});

test("long credentials are redacted without enumerating every possible prefix", () => {
  const secret = `long-key-${"x".repeat(20_000)}`;
  assert.equal(redaction.redactSecretText(`${secret} ${secret.slice(0, 20)}`, [secret]), "<REDACTED> <REDACTED>");
  assert.equal(
    redaction.redactSecretText("repeated-key... ".repeat(10_000), ["absent-key-value", "repeated-key-value"]),
    "<REDACTED>... ".repeat(10_000),
  );
});

test("secret prefixes cannot consume JSON delimiters or leave half an escape", () => {
  for (const secret of ['abcdefgh"more-secret', 'abcdefgh\\more-secret']) {
    for (let length = 8; length <= secret.length; length += 1) {
      const text = JSON.stringify({ key: secret.slice(0, length), keep: true });
      assert.deepEqual(JSON.parse(redaction.redactSecretText(text, [secret])), { key: "<REDACTED>", keep: true });
      assert.deepEqual(JSON.parse(redaction.redactSecretBytes(Buffer.from(text), [secret])), { key: "<REDACTED>", keep: true });
    }
  }
});

test("secret redaction preserves valid nested JSON strings and unchanged formatting", () => {
  const secret = 'abcdefghi\\"secret';
  const text = '{ "keep": 1e5, "output": ' + JSON.stringify(JSON.stringify({ key: secret.slice(0, 12) })) + ' }\n';
  const redacted = redaction.redactSecretText(text, [secret]);
  assert.deepEqual(JSON.parse(JSON.parse(redacted).output), { key: "<REDACTED>" });
  assert.match(redacted, /^\{ "keep": 1e5, "output": /);
  assert.equal(redaction.redactSecretText(redacted, [secret]), redacted);
  assert.equal(redaction.redactSecretText('abcdefghê unchanged', ['abcdefghé-secret']), '<REDACTED>ê unchanged');
});

test("secret redaction also protects credentials printed as JSON numbers", () => {
  const secret = "123456789012345678901234567890";
  const output = '{"prefix":1234567890,"key":123456789012345678901234567890,"keep":1e5}';
  assert.equal(
    redaction.redactSecretText(output, [secret]),
    '{"prefix":"<REDACTED>","key":"<REDACTED>","keep":1e5}',
  );
});

test("the secret prefix threshold does not split a Unicode character", () => {
  const secret = "1234567😀-test-credential";
  assert.equal(redaction.redactSecretText(secret, [secret]), "<REDACTED>");
  assert.equal(redaction.redactSecretText("1234567😀...", [secret]), "<REDACTED>...");
});

const policy = Object.freeze({
  jsonFields: ["control_plane_nodes", "gpu_worker_nodes", "kube_config"],
});

test("evidence redaction removes declared fields from JSON and nested JSON strings", () => {
  const nested = JSON.stringify({
    type: "assistant",
    message: {
      text: JSON.stringify({
        cluster_id: "cluster-123",
        kube_config: "secret-kubeconfig",
        control_plane_nodes: [{ ip: "10.0.0.1", token: "node-secret" }],
      }),
    },
  });

  const redacted = redactEvidenceText(`${nested}\n`, policy);

  assert.doesNotMatch(redacted, /secret-kubeconfig|node-secret|10\.0\.0\.1/);
  assert.match(redacted, /cluster-123/);
  assert.match(redacted, /<REDACTED>/);
});

test("evidence redaction handles JSON embedded in otherwise plain text", () => {
  const redacted = redactEvidenceText(
    'Observed cluster: {"status":"Scheduled","gpu_worker_nodes":[{"ip":"10.0.0.2"}]} done.',
    policy,
  );

  assert.doesNotMatch(redacted, /10\.0\.0\.2/);
  assert.match(redacted, /Scheduled/);
  assert.match(redacted, /<REDACTED>/);
});

test("evidence redaction removes prefixed JSON nested inside JSONL strings", () => {
  const evidence = JSON.stringify({
    type: "item.completed",
    item: {
      aggregated_output: 'GET response: {"status":"Ready","kube_config":"prefixed-secret"}',
    },
  });

  const redacted = redactEvidenceText(evidence, policy);

  assert.doesNotMatch(redacted, /prefixed-secret/);
  assert.match(redacted, /Ready/);
  assert.match(redacted, /<REDACTED>/);
});

test("evidence redaction removes declared fields from Python repr and YAML output", () => {
  const evidence = [
    "Python response: {'status': 'Ready', 'kube_config': 'python-secret'}",
    "status: Ready",
    "control_plane_nodes:",
    "  - ip: 10.0.0.8",
    "gpu_worker_nodes: [{ip: 10.0.0.9}]",
  ].join("\n");

  const redacted = redactEvidenceText(evidence, policy);

  assert.doesNotMatch(redacted, /python-secret|10\.0\.0\.8|10\.0\.0\.9/);
  assert.match(redacted, /Ready/);
  assert.match(redacted, /<REDACTED>/);
});

test("evidence redaction removes YAML block scalars and indentless sequences", () => {
  const evidence = [
    "kube_config: |",
    "  apiVersion: v1",
    "  server: https://10.0.0.10",
    "control_plane_nodes:",
    "- ip: 10.0.0.11",
    '"gpu_worker_nodes":',
    "  - ip: 10.0.0.12",
    "  - ip: 10.0.0.13",
    "status: Ready",
  ].join("\n");

  const redacted = redactEvidenceText(evidence, policy);

  assert.doesNotMatch(redacted, /apiVersion|10\.0\.0\.1[0-3]/);
  assert.match(redacted, /status: Ready/);
});

test("evidence redaction removes comment-bearing YAML blocks", () => {
  const evidence = [
    '"gpu_worker_nodes": # provider nodes',
    "  - ip: COMMENT-SECRET",
    '"kube_config": | # provider config',
    "  apiVersion: SCALAR-SECRET",
    "status: Ready",
  ].join("\n");

  const redacted = redactEvidenceText(evidence, policy);

  assert.doesNotMatch(redacted, /COMMENT-SECRET|SCALAR-SECRET|apiVersion/);
  assert.match(redacted, /status: Ready/);
});

test("evidence redaction removes YAML sequence-entry mapping blocks", () => {
  const evidence = [
    '- "gpu_worker_nodes": # provider nodes',
    "  - ip: SEQUENCE-SECRET-1",
    "  - ip: SEQUENCE-SECRET-2",
    "- status: Ready",
  ].join("\n");

  const redacted = redactEvidenceText(evidence, policy);

  assert.doesNotMatch(redacted, /SEQUENCE-SECRET/);
  assert.match(redacted, /- status: Ready/);
});

test("evidence redaction decodes escaped JSON keys and multiline JSON whitespace", () => {
  const evidence = [
    JSON.stringify({
      output: 'Provider response: {"kube_\\u0063onfig":"unicode-secret"}',
    }),
    JSON.stringify({
      output: 'Provider response: {"kube_config"\n:\n"multiline-secret"}',
    }),
  ].join("\n");

  const redacted = redactEvidenceText(evidence, policy);

  assert.doesNotMatch(redacted, /unicode-secret|multiline-secret/);
  assert.match(redacted, /<REDACTED>/);
});

test("evidence redaction is inert without an explicit Task policy", () => {
  const evidence = '{"kube_config":"ordinary-task-output"}';
  assert.equal(redactEvidenceText(evidence), evidence);
});

// A Judge scores the bytes it is handed. Re-serializing a transcript rewrites
// escapes and number spellings even when nothing is removed, which would move a
// score purely because a Task declares a field. Redaction must therefore be
// byte-preserving whenever it takes nothing out.
const GPU_CLUSTER_REDACTION = Object.freeze({
  jsonFields: ["control_plane_nodes", "gpu_worker_nodes", "kube_config"],
});

test("redaction preserves transcript bytes when it removes nothing", () => {
  const transcript = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    "{\"type\":\"assistant\",\"text\":\"caf\\u00e9 at https:\\/\\/api.together.ai\"}",
    "{\"type\":\"metric\",\"n\":1e5}",
    JSON.stringify({ type: "result", subtype: "success", num_turns: 3 }),
  ].join("\n") + "\n";

  assert.equal(redactEvidenceText(transcript, GPU_CLUSTER_REDACTION), transcript);
});

test("escapes and number spellings survive a declared but absent field", () => {
  for (const line of [
    "{\"t\":\"caf\\u00e9\"}",
    "{\"p\":\"a\\/b\"}",
    "{\"n\":1e5}",
    "{\"t\": \"spaced\", \"n\": 2}",
  ]) {
    assert.equal(
      redactEvidenceText(line, GPU_CLUSTER_REDACTION),
      line,
      `expected ${line} to survive redaction unchanged`,
    );
  }
});

test("a declared field is still redacted when it is present", () => {
  const line = "{\"type\":\"tool\",\"kube_config\":\"apiVersion: v1\"}";
  const redacted = redactEvidenceText(line, GPU_CLUSTER_REDACTION);
  assert.notEqual(redacted, line);
  assert.ok(redacted.includes("<REDACTED>"));
  assert.ok(!redacted.includes("apiVersion"));
});

test("one redacted line does not reformat its untouched neighbours", () => {
  const clean = "{\"t\":\"caf\\u00e9\"}";
  const dirty = "{\"kube_config\":\"secret\"}";
  const out = redactEvidenceText([clean, dirty, clean].join("\n"), GPU_CLUSTER_REDACTION);
  const lines = out.split("\n");
  assert.equal(lines[0], clean);
  assert.equal(lines[2], clean);
  assert.ok(lines[1].includes("<REDACTED>"));
});
