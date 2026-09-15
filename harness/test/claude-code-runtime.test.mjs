import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CLAUDE_CODE_NODE_MAJOR,
  CLAUDE_CODE_NODE_VERSION,
  CLAUDE_CODE_VERSION,
  claudeCodeNodeInstallShell,
  claudeCodeInstallShell,
  claudeCodePackageSpec,
} from "../lib/claude-code-runtime.mjs";

test("Claude Code runtime is exact, Node 22+, and bounded against npm flakiness", () => {
  assert.equal(CLAUDE_CODE_VERSION, "2.1.221");
  assert.equal(CLAUDE_CODE_NODE_MAJOR, 22);
  assert.equal(CLAUDE_CODE_NODE_VERSION, "22.23.1");
  assert.equal(claudeCodePackageSpec(), "@anthropic-ai/claude-code@2.1.221");

  const script = claudeCodeInstallShell();
  assert.match(script, /expected_node_major=22/);
  assert.match(script, /@anthropic-ai\/claude-code@2\.1\.221/);
  assert.match(script, /for attempt in \$\(seq 1 3\)/);
  assert.match(script, /--fetch-retries=5/);
  assert.doesNotMatch(script, /@latest/);
  assert.throws(() => claudeCodeInstallShell({ attempts: 0 }), /integer from 1 to 5/);

  const nodeScript = claudeCodeNodeInstallShell();
  assert.match(nodeScript, /pinned_node_version=22\.23\.1/);
  assert.match(nodeScript, /n@10\.2\.0/);
  assert.match(nodeScript, /for attempt in \$\(seq 1 3\)/);
  assert.throws(() => claudeCodeNodeInstallShell({ attempts: 6 }), /integer from 1 to 5/);
});

test("the optional installer uses the pinned Claude runtime", () => {
  const installer = readFileSync(
    new URL("../bin/install-claude-code.mjs", import.meta.url),
    "utf-8",
  );


  assert.match(installer, /claudeCodeRuntimeInstallShell\(\)/);
});
