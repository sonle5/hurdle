import { terminalStatus } from "./terminal-output.mjs";

// One JSON document per invocation; credential values and backend errors never
// enter this report. Human output retains the shared terminal formatting.
export function createSetupOutput(io, { json = false, target = null } = {}) {
  const result = {
    schemaVersion: 1, command: "setup", target, ok: false, exitCode: 1,
    runtimePath: null, executionEnvironment: null, resultStore: null,
    requiredCredentials: [], missingCredentials: [], checks: [], nextCommands: [], error: null,
  };
  const silent = { isTTY: false, write() {} };
  return {
    result,
    io: json ? { ...io, stdout: silent, stderr: silent } : io,
    check(status, message, code = null) {
      result.checks.push({ status, code, message });
      if (!json) io.stdout.write(terminalStatus(status, message, io.stdout));
    },
    finish(exitCode, error = null) {
      result.ok = exitCode === 0;
      result.exitCode = exitCode;
      result.error = error;
      if (json) io.stdout.write(`${JSON.stringify(result)}\n`);
      else if (error) io.stdout.write(terminalStatus("fail", `hurdle [${error.code}] ${error.message}`, io.stdout));
      return exitCode;
    },
  };
}
