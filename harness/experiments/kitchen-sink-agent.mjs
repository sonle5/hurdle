#!/usr/bin/env node
// A scripted stand-in for Claude Code that steers each kitchen-sink Task to its
// designed result. Source-only: it powers the free preview and its test, and is
// never used for a real evaluation.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const MODEL = "scripted-preview";
const SESSION = "kitchen-sink-preview";

export function createKitchenSinkAgent({ delayMs = 0 } = {}) {
  return Object.freeze({
    id: "claude-code",
    capabilities: Object.freeze(["agent.selected-context"]),
    normalizeSettings({ requestedModel, settings }) {
      return { requestedModel: requestedModel ?? null, settings: settings ?? {} };
    },
    createLaunchPlan({ prompt, resources = { skills: [], mcpServers: [] } }) {
      return {
        command: process.execPath,
        args: [SCRIPT],
        env: { KITCHEN_SINK_DELAY_MS: String(delayMs) },
        stdin: prompt,
        timeoutMs: 30_000,
        // Skills land where Claude Code reads them, so the script can tell
        // which Condition it runs under.
        workspaceFiles: resources.skills.flatMap((skill) => skill.files.map((file) => ({
          path: `.claude/skills/${skill.name}/${file.relativePath}`,
          source: { kind: "selected-resource", handle: file.handle, sha256: file.sha256 },
        }))),
      };
    },
    decodeControllerEvidence({ stdout }) {
      const frames = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const result = frames.findLast((frame) => frame.type === "result");
      return {
        transcript: `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
        observedModel: result?.model ?? null,
        sessionId: result?.session_id ?? null,
        metrics: { common: {}, adapter: {} },
      };
    },
  });
}

const STYLED_NOTES = `# Hurdle 2.4.0 (Kestrel)

## Added

- Added check results under each completed run in \`hurdle run\`.

## Fixed

- Fixed stray progress fragments in narrow terminals.

## Changed

- Changed run reasons to dim text so check results stand out.

Shipped by the Hurdle crew.
`;

// What an Agent plausibly writes when it has never seen the house style.
const PLAIN_NOTES = `# Release Notes: v2.4.0

### New
- \`hurdle run\` now lists every check under each completed run.

### Fixes
- The progress spinner no longer leaves fragments in narrow terminals.
- Reasons under a run are dimmed so check results stand out.
`;

const SUMMARY = `# Release planning 2.4.0: summary

- **Decision:** ship the CLI check results and the spinner fix together in
  2.4.0, so the release notes tell one story.
- **Why:** users want check results without opening the Viewer, and support
  has three tickets about stray spinner lines in narrow terminals.
- **Design:** keep passing checks short and show a reason only when a check
  does not pass, so long lists do not bury failures.
- **Spinner:** the stray lines come from a wrapping bug; the fix keeps the live
  line within the terminal width.

## Action items

- Priya: land the CLI check output and the spinner fix by Friday.
- Marco: review the terminal colors in light and dark themes.
- Ana: reply to the three support tickets once 2.4.0 is out.
`;

// Each Task is recognized by its starter files; the delay factor staggers
// completion so concurrent runs finish out of order, as real ones do.
const TASKS = [
  {
    matches: () => existsSync("fixtures/order.json"),
    delay: 1,
    perform() {
      const order = JSON.parse(readFileSync("fixtures/order.json", "utf8"));
      const total = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      writeFileSync("total.json", `${JSON.stringify({ order: order.order, total })}\n`);
      return `Order ${order.order} totals ${total}.`;
    },
  },
  {
    matches: () => existsSync("fixtures/changes.txt"),
    delay: 1.6,
    perform() {
      const styled = existsSync(".claude/skills/house-style/SKILL.md");
      writeFileSync("RELEASE_NOTES.md", styled ? STYLED_NOTES : PLAIN_NOTES);
      return styled ? "Wrote RELEASE_NOTES.md in the house style." : "Wrote RELEASE_NOTES.md.";
    },
  },
  {
    matches: () => existsSync("src/slugify.js"),
    delay: 1.3,
    perform() {
      writeFileSync("src/slugify.js", [
        "export function slugify(title) {",
        '  return title.trim().toLowerCase().replace(/\\s+/g, "-");',
        "}",
        "",
      ].join("\n"));
      // Two lines on purpose: the advisory one-line-reply check fails while the run passes.
      return "Fixed: slugify now replaces every run of whitespace, not only the first space.\nThe test passes.";
    },
  },
  {
    matches: (prompt) => prompt.includes("report.txt"),
    delay: 0.7,
    perform() {
      writeFileSync("report.txt", `${Array.from({ length: 5000 }, (_, index) => index + 1).join("\n")}\n`);
      return "Wrote report.txt with 5000 lines.";
    },
  },
  {
    matches: () => existsSync("fixtures/meeting-notes.md"),
    delay: 1.1,
    perform() {
      writeFileSync("summary.md", SUMMARY);
      return "Wrote summary.md.";
    },
  },
];

async function main() {
  const prompt = readFileSync(0, "utf8");
  const task = TASKS.find(({ matches }) => matches(prompt));
  const delayMs = Number(process.env.KITCHEN_SINK_DELAY_MS) || 0;
  if (task && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * task.delay));
  const reply = task ? task.perform() : "This scripted agent has no behavior for this Task.";
  const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
  emit({ type: "system", subtype: "init", session_id: SESSION, model: MODEL });
  emit({
    type: "assistant",
    message: { id: "msg_preview", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: reply }] },
    parent_tool_use_id: null,
    session_id: SESSION,
  });
  emit({ type: "result", subtype: "success", is_error: false, session_id: SESSION, model: MODEL, num_turns: 1, result: reply });
}

if (process.argv[1] && realpathSync(process.argv[1]) === SCRIPT) await main();
