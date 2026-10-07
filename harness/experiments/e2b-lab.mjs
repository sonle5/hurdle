#!/usr/bin/env node
// Source-only experiment. Preparation and recipe preview never allocate E2B resources.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as cli } from "../bin/tae.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import { createRuntimeConfig } from "../lib/runtime-init.mjs";
import { loadProjectEnvironment } from "../lib/project-environment.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const lab = resolve(repository, ".tae/e2b-lab");
const runtimePath = join(lab, ".tae/runtime/e2b.json");
const [command = "help", ...args] = process.argv.slice(2);
const defaultTemplate = "hurdle-claude-code-dev:v1";
const script = "node harness/experiments/e2b-lab.mjs";
const credentialsPath = join(lab, ".env.local");
const colors = { red: "\u001b[31m", green: "\u001b[32m", bold: "\u001b[1m", dim: "\u001b[2m" };

function paint(text, color, stream = process.stdout) {
  return stream.isTTY && !process.env.NO_COLOR ? `${colors[color]}${text}\u001b[0m` : text;
}

function header(stream = process.stdout) {
  stream.write(`${paint("Hurdle · E2B", "bold", stream)}\n\n`);
}

function fact(label, value) {
  console.log(`  ${paint(label.padEnd(9), "dim")} ${value}`);
}

function requireE2bKey() {
  const { environment } = loadProjectEnvironment(lab);
  if (!environment.E2B_API_KEY?.trim()) {
    const error = new Error("E2B_API_KEY is missing.");
    error.code = "E2B_KEY_MISSING";
    throw error;
  }
  return environment.E2B_API_KEY;
}

async function prepare() {
  let template = defaultTemplate;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--template" || !args[1].trim()) {
      throw new Error("prepare accepts only --template NAME.");
    }
    template = args[1];
  }
  await mkdir(resolve(lab, ".."), { recursive: true });
  await mkdir(lab); // Refuse to overwrite an existing experiment, including credentials.
  const initialized = await initializeSuite({ destination: join(lab, "evals") });
  if (!initialized.ok) throw new Error("Starter could not be created.");
  const runtime = structuredClone(createRuntimeConfig("e2b", { template }));
  delete runtime.judge;
  runtime.environment.settings.maxLifetimeMs = 300_000;
  runtime.viewer.port = 3002;
  await mkdir(join(lab, ".tae/runtime"), { recursive: true });
  await writeFile(runtimePath, JSON.stringify(runtime, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(lab, ".env.example"), "E2B_API_KEY=\nANTHROPIC_API_KEY=\n# CLAUDE_CODE_OAUTH_TOKEN=\n", { flag: "wx" });
  await writeFile(join(lab, ".gitignore"), ".env.local\n.tae/\n", { flag: "wx" });
  header();
  console.log(`${paint("✓", "green")} Lab prepared\n`);
  fact("Directory", lab);
  fact("Template", template);
  fact("Task", "copy-message · one run · no Judge");
  console.log(`\n  Next: add E2B_API_KEY and your Claude credentials to\n  ${credentialsPath}\n\n  Then run: ${script} template --build`);
}

async function templateRecipe() {
  if (args.length > 1 || args.some(arg => !["--build", "--dockerfile"].includes(arg))) throw new Error("template accepts --build or --dockerfile.");
  const building = args.includes("--build");
  // Check setup before loading the SDK or printing build/progress information.
  const apiKey = building ? requireE2bKey() : null;
  const { Template, defaultBuildLogger } = await import("e2b");
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  const templateName = runtime.environment.settings.workloadTemplate;
  const recipe = Template()
    .fromImage("node:22-bookworm")
    .runCmd("apt-get update && apt-get install -y python3 iproute2 curl ca-certificates && rm -rf /var/lib/apt/lists/*", { user: "root" })
    .runCmd("npm install --global @anthropic-ai/claude-code@2.1.288", { user: "root" })
    .runCmd("node --version && claude --version && /usr/bin/python3 --version", { user: "root" });
  header();
  fact("Template", templateName);
  fact("Installs", "Node 22 · Python 3 · Claude Code 2.1.288");
  fact("Capacity", "2 CPUs · 2048 MB");
  if (!building) {
    if (args.includes("--dockerfile")) console.log(`\n${Template.toDockerfile(recipe)}`);
    console.log(`\n  Preview only · no E2B resources started.\n  Build: ${script} template --build`);
    return;
  }
  console.log("\n  Building on E2B · may be billed.\n");
  const built = await Template.build(recipe, templateName, {
    apiKey,
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });
  console.log(`\n${paint("✓", "green")} Template ready\n`);
  fact("ID", built.templateId);
  console.log(`\n  Next: ${script} validate`);
}

try {
  if (command === "prepare") await prepare();
  else if (command === "template") await templateRecipe();
  else if (["validate", "run", "view"].includes(command)) {
    if (command === "run" || (command === "validate" && !args.includes("--offline"))) requireE2bKey();
    if (command === "run") console.log("E2B · one task · two sandboxes · 5-minute lifetime each\nAgent and E2B usage may be billed.\n");
    process.exitCode = await cli([command, "--runtime", runtimePath, ...args], {
      cwd: lab, stdout: process.stdout, stderr: process.stderr,
    });
  } else {
    header();
    console.log(`Usage: ${script} <command>\n\n  prepare [--template NAME]  Create a local lab\n  template                   Preview the template\n  template --dockerfile      Show the Dockerfile\n  template --build           Build on E2B\n  validate [--offline]        Check the lab\n  run [--view]               Run one evaluation\n  view                       Open the results\n\nBuilds and runs may be billed. Preparation and previews are local.`);
  }
} catch (error) {
  const stream = process.stderr;
  header(stream);
  if (error.code === "E2B_KEY_MISSING") {
    stream.write(`${paint("✗", "red", stream)} ${error.message}\n\n  Create or edit this file and add your key:\n  ${credentialsPath}\n\n  You can also export E2B_API_KEY in this terminal.\n  Values in .env.local override exported values.\n\n  Retry: ${script} ${[command, ...args].join(" ")}\n  No E2B resources started.\n`);
  } else if (error.code === "EEXIST") stream.write(`${paint("✗", "red", stream)} Lab already exists; it was not overwritten.\n\n  ${lab}\n  Next: ${script} template\n`);
  else if (error.code === "ERR_MODULE_NOT_FOUND") stream.write(`${paint("✗", "red", stream)} E2B dependencies are missing.\n\n  Run: npm run setup:backends\n`);
  else stream.write(`${paint("✗", "red", stream)} ${error.message}\n`);
  process.exitCode = 1;
}
