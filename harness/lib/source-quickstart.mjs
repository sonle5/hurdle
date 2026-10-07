import { resolve } from "node:path";
import { defaultLocalStoreRoot } from "./project-paths.mjs";
import { paintTerminal } from "./terminal-output.mjs";
import { stripVTControlCharacters } from "node:util";

const QUICKSTART_TASK = "copy-message";
const GENERIC_NONZERO_PREFIX = "The evaluated agent process did not exit cleanly:";
const FALLBACK_REASON =
  "The starter evaluation did not complete. Open its Transcript in the Viewer for details.";
export function renderQuickstartHeader({ isTTY = false, useColor = isTTY } = {}) {
  return paintTerminal("Hurdle", "bold", isTTY && useColor && !process.env.NO_COLOR);
}

export function createQuickstartViewerOutput({ stream, onReady }) {
  let pending = "", ready = false;
  return {
    isTTY: Boolean(stream.isTTY),
    write(chunk) {
      pending += String(chunk);
      while (pending.includes("\n")) {
        const newline = pending.indexOf("\n");
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const text = stripVTControlCharacters(line);
        // The source quickstart already printed the shared heading.
        if (text === "Hurdle") continue;
        if (text === "✓ Viewer ready" && !ready) { ready = true; onReady(); }
        stream.write(`${line}\n`);
      }
    },
  };
}

export function projectQuickstartRunIssue(value) {
  const lines = String(value ?? "").split("\n");
  const completed = lines.find((line) => (
    /[!✗]\s+\[\d+\/\d+\]\s+[^·]+·[^·]+·[^·]+·\s+(?:fail|incomplete|unknown)\b/iu
      .test(line)
  ));
  const task = completed
    ? completed.match(/\[\d+\/\d+\]\s+([^·]+?)\s+·/u)?.[1]?.trim() || QUICKSTART_TASK
    : QUICKSTART_TASK;
  const reason = lines
    .map((line) => line.match(/^\s{2}[a-z][a-z0-9._-]{0,127}:\s+(.+)$/u)?.[1]?.trim())
    .find(Boolean);
  return {
    task,
    reason: reason?.startsWith(GENERIC_NONZERO_PREFIX)
      ? reason.slice(GENERIC_NONZERO_PREFIX.length).trim() || reason
      : reason || FALLBACK_REASON,
  };
}

export async function runSourceQuickstart({
  cwd,
  prepareDependencies = async () => 0,
  runCli,
  onStatus = () => {},
}) {
  if (
    typeof cwd !== "string"
    || !cwd
    || typeof prepareDependencies !== "function"
    || typeof runCli !== "function"
    || typeof onStatus !== "function"
  ) {
    throw new TypeError("Source quickstart options are invalid");
  }
  onStatus({ phase: "prepare", state: "start" });
  const preparationExitCode = await prepareDependencies();
  onStatus({ phase: "prepare", state: "complete", exitCode: preparationExitCode });
  if (preparationExitCode !== 0) return preparationExitCode;

  const storeRoot = defaultLocalStoreRoot(cwd);
  onStatus({ phase: "run", state: "start" });
  const runExitCode = await runCli([
    "run",
    resolve(cwd, "examples/copy-message/example.suite.mjs"),
    "--store", storeRoot,
    "--experiment-version", "local-quickstart",
  ]);
  onStatus({ phase: "run", state: "complete", exitCode: runExitCode });
  if ([130, 143].includes(runExitCode)) return runExitCode;

  onStatus({ phase: "view", state: "start" });
  const viewerExitCode = await runCli(["view", "--store", storeRoot]);
  onStatus({ phase: "view", state: "complete", exitCode: viewerExitCode });
  return viewerExitCode === 0 ? runExitCode : viewerExitCode;
}
