#!/usr/bin/env node
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFrameworkCli } from "../bin/hurdle.mjs";
import { checkAgentReadiness } from "../lib/agent-readiness.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import { createKitchenSinkAgent } from "./kitchen-sink-agent.mjs";

const block = [
  " _   _  _   _  ____   ____   _      _____ ",
  "| | | || | | ||  _ \\ |  _ \\ | |    | ____|",
  "| |_| || | | || |_) || | | || |    |  _|  ",
  "|  _  || |_| ||  _ < | |_| || |___ | |___ ",
  "|_| |_| \\___/ |_| \\_\\|____/ |_____||_____|",
].join("\n");
const brands = [
  { name: "1 · Compact hurdle", art: "    _______\n___|       |___  hurdle\n" },
  { name: "2 · Block wordmark", art: block },
  { name: "3 · Track wordmark", art: "       __      __\n______|  |____|  |______\n        h u r d l e\n" },
];
const [command = "brand", selected] = process.argv.slice(2);
if (command === "brand") {
  const options = selected ? brands.filter((_, index) => String(index + 1) === selected) : brands;
  if (!options.length) throw new Error("Choose brand 1, 2, or 3.");
  for (const option of options) console.log(`\n${option.name}\n\n${option.art}\n`);
} else if (["readiness", "view"].includes(command)) {
  console.log("Preview only: no provider request, agent, or Viewer starts.");
  const root = await mkdtemp(join(tmpdir(), "hurdle-cli-preview-"));
  try {
    const initialized = await initializeSuite({ destination: join(root, "evals") });
    if (!initialized.ok) throw new Error("Preview starter could not be initialized.");
    const cli = createFrameworkCli({
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "preview-not-a-real-key" },
      environmentSource: "preview",
      checkAgentReadiness: input => checkAgentReadiness(input, {
        probeCli: async () => true,
        fetch: async () => new Response("", { status: selected === "fail" ? 401 : 200 }),
      }),
      launchViewer: async ({ onReady }) => {
        onReady("http://127.0.0.1:3000");
        return { kind: "stopped", exitCode: 0 };
      },
    });
    process.exitCode = await cli.main([command === "readiness" ? "validate" : "view"], {
      cwd: root, stdout: process.stdout, stderr: process.stderr,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
} else if (command === "run") {
  console.log("Preview only: a scripted agent stands in for Claude Code, so nothing is billed.");
  console.log("Results are temporary; add --view to browse them before they are removed.");
  const root = await mkdtemp(join(tmpdir(), "hurdle-kitchen-sink-"));
  try {
    await cp(new URL("../../examples/kitchen-sink/", import.meta.url), join(root, "kitchen-sink"), { recursive: true });
    const cli = createFrameworkCli({
      env: {},
      environmentSource: "preview",
      checkAgentReadiness: async () => ({
        ok: true,
        checks: [{ status: "pass", message: "Scripted agent stands in for Claude Code." }],
      }),
      createAgentAdapter: () => createKitchenSinkAgent({ delayMs: 700 }),
    });
    process.exitCode = await cli.main(["run", "kitchen-sink/example.suite.mjs", ...(selected === "--view" ? ["--view"] : [])], {
      cwd: root, stdout: process.stdout, stderr: process.stderr,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
} else {
  throw new Error("Usage: node harness/experiments/preview-cli.mjs <brand [1|2|3]|readiness [fail]|view|run [--view]>");
}
