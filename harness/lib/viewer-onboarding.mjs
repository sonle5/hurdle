import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

function shellWord(value) {
  return /^[a-zA-Z0-9_./:@=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

// Only display metadata crosses into the read-only Viewer. Never pass runtime
// settings, the project environment, or provider credentials with this context.
export function validateViewerOnboarding(value) {
  const fields = ["projectDirectory", "commands", "setupCommand", "runtimeLabel"];
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== fields.length
      || Object.keys(value).some(key => !fields.includes(key))
      || fields.some(key => key === "commands" && value[key] === null ? false
        : typeof value[key] !== "string" || value[key].length > 32768
          || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value[key]))) {
    throw new TypeError("Viewer onboarding context is invalid");
  }
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}

export function createViewerOnboarding({ cwd, cliPath, sourceCheckout, suite, runtimeProfile, storeOverride = false }) {
  const prefix = sourceCheckout ? "hurdle" : "npx hurdle";
  const prelude = [`cd ${shellWord(cwd)}`];
  if (sourceCheckout) prelude.push(`alias hurdle=${shellWord(`node ${shellWord(cliPath)}`)}`);
  const defaultSuite = existsSync(resolve(cwd, "evals/example.suite.mjs"))
    ? "evals/example.suite.mjs" : "example.suite.mjs";
  const suiteArg = suite === defaultSuite ? "" : ` ${shellWord(suite)}`;
  let runtimeArg;
  // A standalone --store override may no longer match the saved Runtime.
  // Do not suggest a command that would write to a different results folder.
  if (runtimeProfile.sourcePath && !storeOverride) {
    runtimeArg = ` --runtime ${shellWord(relative(cwd, runtimeProfile.sourcePath) || runtimeProfile.sourcePath)}`;
  } else if (!runtimeProfile.sourcePath && runtimeProfile.environment.kind === "local") {
    runtimeArg = ` --environment local --store ${shellWord(relative(cwd, runtimeProfile.resultStore.root) || runtimeProfile.resultStore.root)}`;
  }
  return validateViewerOnboarding({
    projectDirectory: cwd,
    commands: runtimeArg === undefined ? null
      : [...prelude, "", `${prefix} validate${suiteArg}${runtimeArg}`, `${prefix} run${suiteArg}${runtimeArg}`].join("\n"),
    setupCommand: `${sourceCheckout ? `node ${shellWord(cliPath)}` : prefix} setup${suiteArg}`,
    runtimeLabel: runtimeProfile.environment.kind === "e2b" ? "E2B sandbox" : "Local",
  });
}
