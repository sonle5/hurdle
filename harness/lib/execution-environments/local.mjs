import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";

import {
  createBoundedControllerCapture,
  DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
} from "../controller-transcript.mjs";
import {
  executeAgent,
  withExecutionCredentialValues,
} from "../execution-envelope.mjs";
import {
  deepFreeze,
  RunSelectionInputError,
  sha256,
} from "../run-model.mjs";

const TOTAL_ARTIFACT_LIMIT = 64 * 1024 * 1024;

// Interpreter startup can take seconds on a busy machine; a probe killed mid-start
// can miss its quiescence window and needlessly block the Run.
const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 10_000;

async function captureToolVersions(workspace, plan, signal, timeoutMs) {
  const root = await mkdtemp(join(workspace, ".versions-"));
  const env = {
    ...(typeof plan.env?.PATH === "string" ? { PATH: plan.env.PATH } : {}),
    HOME: root,
    PIP_REQUIRE_VIRTUALENV: "true",
    PIP_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  try {
    const results = await Promise.all([
      ["runner", plan.command], ["node", "node"], ["python", "python3"], ["pip", "pip3"],
    ].map(async ([name, command]) => {
      const result = await executeProcess(root, {
        command, args: ["--version"], env, timeoutMs,
      }, 4_096, signal);
      const text = result.stdout.text.trim();
      const version = result.exitCode === 0 && result.stdout.complete && result.quiescent
        && !result.timedOut && !result.captureOverflow && !result.spawnError && !signal?.aborted
        ? text.match(/(?:^|\s)v?(\d{1,4}\.\d{1,4}(?:\.\d{1,8})?(?:[-+][a-zA-Z0-9.-]{1,32})?)(?=$|\s)/)?.[1] ?? null
        : null;
      return { name, version, quiescent: result.quiescent };
    }));
    return {
      versions: Object.fromEntries(results.map(({ name, version }) => [name, version])),
      quiescent: results.every(({ quiescent }) => quiescent),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function safeWorkspacePath(path) {
  if (
    typeof path !== "string"
    || path.includes("\\")
    || posix.isAbsolute(path)
    || posix.normalize(path) !== path
  ) {
    return false;
  }
  return !path.split("/").some((segment) => (
    segment === "" || segment === "." || segment === ".."
  ));
}

function workspaceFile(workspace, relativePath) {
  if (!safeWorkspacePath(relativePath)) {
    throw new TypeError(`Workspace path '${relativePath}' is invalid`);
  }
  const absolutePath = resolve(workspace, ...relativePath.split("/"));
  const relativePathFromRoot = absolutePath.slice(workspace.length + 1);
  if (
    !absolutePath.startsWith(`${workspace}${sep}`)
    || isAbsolute(relativePathFromRoot)
  ) {
    throw new TypeError(`Workspace path '${relativePath}' escapes the workspace`);
  }
  return absolutePath;
}

async function stageFixtures(workspace, fixtures) {
  for (const fixture of fixtures) {
    const destination = workspaceFile(workspace, fixture.workspacePath);
    const bytes = await readFile(fixture.pinnedPath);
    if (Number.isSafeInteger(fixture.maxBytes) && bytes.byteLength > fixture.maxBytes) {
      throw new Error(
        `Pinned fixture '${fixture.source}' exceeds its ${fixture.maxBytes}-byte limit`,
      );
    }
    if (sha256(bytes) !== fixture.sha256) {
      throw new Error(`Pinned fixture '${fixture.source}' failed verification`);
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    const staged = await readFile(destination);
    if (sha256(staged) !== fixture.sha256) {
      throw new Error(`Staged fixture '${fixture.workspacePath}' failed verification`);
    }
  }
}

async function stageWorkspaceFiles(workspace, files = []) {
  for (const file of files) {
    const destination = workspaceFile(workspace, file.path);
    const bytes = file.source.kind === "pinned"
      ? await readFile(file.source.pinnedPath)
      : Buffer.from(file.source.bytes);
    if (sha256(bytes) !== file.source.sha256) {
      throw new Error(`Workspace file '${file.path}' failed verification`);
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return false;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupExists(pid) {
  if (!pid || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function settlesWithin(promise, milliseconds) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), milliseconds);
    promise.then(() => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

async function executeProcess(workspace, launchPlan, captureMaxBytes, signal = null) {
  if (signal?.aborted) throw new Error("Local process was cancelled before launch.");
  const stdout = createBoundedControllerCapture(captureMaxBytes);
  const stderr = createBoundedControllerCapture(captureMaxBytes);
  const startedAt = new Date();
  let timedOut = false;
  let captureOverflow = false;
  let spawnError = null;
  let terminationRequested = false;
  let forceKillTimer = null;
  let terminationTimer = null;
  let processControlFailed = false;
  let resolveTerminationDeadline;
  const terminationDeadline = new Promise(resolvePromise => { resolveTerminationDeadline = resolvePromise; });

  const child = spawn(launchPlan.command, launchPlan.args ?? [], {
    cwd: workspace,
    env: launchPlan.env ?? {},
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const signalGroup = (signalName) => {
    try { return signalProcessGroup(child, signalName); }
    catch { processControlFailed = true; return false; }
  };
  const groupExists = () => {
    try { return processGroupExists(child.pid); }
    catch { processControlFailed = true; return true; }
  };

  const requestTermination = () => {
    if (terminationRequested) return;
    terminationRequested = true;
    signalGroup("SIGTERM");
    forceKillTimer = setTimeout(() => {
      signalGroup("SIGKILL");
    }, 250);
    terminationTimer = setTimeout(() => {
      resolveTerminationDeadline({ code: null, signal: null, unconfirmed: true });
    }, 1_250);
  };
  const onAbort = () => requestTermination();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  // Stream decoding keeps multibyte characters intact across chunk boundaries.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (!stdout.append(chunk)) {
      captureOverflow = true;
      requestTermination();
    }
  });
  child.stderr.on("data", (chunk) => {
    if (!stderr.append(chunk)) {
      captureOverflow = true;
      requestTermination();
    }
  });
  child.stdin.on("error", () => {});
  child.stdin.end(launchPlan.stdin ?? "");

  const timeout = setTimeout(() => {
    timedOut = true;
    requestTermination();
  }, launchPlan.timeoutMs ?? 55 * 60 * 1000);

  const closePromise = new Promise((resolvePromise) => {
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  const exitPromise = new Promise((resolvePromise) => {
    child.once("error", (error) => {
      spawnError = error;
      resolvePromise({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  const exited = await Promise.race([exitPromise, terminationDeadline]);
  processControlFailed ||= exited.unconfirmed === true;
  signal?.removeEventListener("abort", onAbort);
  clearTimeout(timeout);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  if (terminationTimer) clearTimeout(terminationTimer);

  let quiescent = true;
  if (groupExists()) {
    signalGroup("SIGTERM");
    await wait(100);
    if (groupExists()) {
      signalGroup("SIGKILL");
      await wait(100);
    }
    quiescent = !groupExists();
  }
  const streamsClosed = await settlesWithin(closePromise, 1_000);
  quiescent &&= streamsClosed && !processControlFailed;
  if (!quiescent) {
    // The failure remains an integrity blocker. Do not let unconfirmed process
    // handles pin the controller after its bounded termination attempts.
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }

  return {
    stdout: stdout.snapshot(),
    stderr: stderr.snapshot(),
    exitCode: exited.code,
    signal: exited.signal,
    timedOut,
    captureOverflow,
    spawnError: spawnError?.message ?? null,
    quiescent,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  };
}

async function readDeclaredArtifact(workspace, declaration) {
  const segments = declaration.path.split("/");
  let current = workspace;
  try {
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        return { status: "rejected", reason: "symlink" };
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        return { status: "rejected", reason: "parent_not_directory" };
      }
      if (index === segments.length - 1 && !stat.isFile()) {
        return { status: "rejected", reason: "not_regular_file" };
      }
      if (index === segments.length - 1 && stat.nlink !== 1) {
        return { status: "rejected", reason: "hard_link" };
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "rejected", reason: "unreadable" };
  }

  const absolutePath = workspaceFile(workspace, declaration.path);
  const handle = await open(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { status: "rejected", reason: "not_regular_file" };
    if (stat.nlink !== 1) return { status: "rejected", reason: "hard_link" };
    if (stat.size > declaration.maxBytes) {
      return { status: "rejected", reason: "too_large" };
    }
    const bytes = await handle.readFile();
    let textEncoding;
    if (declaration.kind === "text") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        textEncoding = "utf8";
      } catch {
        textEncoding = "invalid_utf8";
      }
    }
    return {
      status: "captured",
      bytes,
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      ...(textEncoding ? { textEncoding } : {}),
    };
  } catch (error) {
    if (error?.code === "ELOOP") return { status: "rejected", reason: "symlink" };
    throw error;
  } finally {
    await handle.close();
  }
}

async function collectArtifacts(workspace, declarations) {
  const artifacts = [];
  let capturedBytes = 0;
  for (const declaration of declarations) {
    const result = await readDeclaredArtifact(workspace, declaration);
    const capturedAt = new Date().toISOString();
    if (result.status === "captured") {
      capturedBytes += result.sizeBytes;
      if (capturedBytes > TOTAL_ARTIFACT_LIMIT) {
        artifacts.push({
          ...declaration,
          status: "rejected",
          reason: "total_limit_exceeded",
          capturedAt,
        });
        continue;
      }
    }
    artifacts.push({ ...declaration, ...result, capturedAt });
  }
  return artifacts;
}

function aggregateProcesses(turns) {
  if (turns.length === 0) return null;
  const stdoutText = turns.map(({ stdout }) => stdout.text).join("");
  const stderrText = turns.map(({ stderr }) => stderr.text).join("");
  const last = turns.at(-1);
  return {
    stdout: {
      text: stdoutText,
      complete: turns.every(({ stdout }) => stdout.complete),
      capturedBytes: turns.reduce((sum, { stdout }) => sum + stdout.capturedBytes, 0),
      totalBytes: turns.reduce((sum, { stdout }) => sum + stdout.totalBytes, 0),
      droppedBytes: turns.reduce((sum, { stdout }) => sum + stdout.droppedBytes, 0),
    },
    stderr: {
      text: stderrText,
      complete: turns.every(({ stderr }) => stderr.complete),
      capturedBytes: turns.reduce((sum, { stderr }) => sum + stderr.capturedBytes, 0),
      totalBytes: turns.reduce((sum, { stderr }) => sum + stderr.totalBytes, 0),
      droppedBytes: turns.reduce((sum, { stderr }) => sum + stderr.droppedBytes, 0),
    },
    exitCode: last.exitCode,
    signal: last.signal,
    timedOut: turns.some(({ timedOut }) => timedOut),
    captureOverflow: turns.some(({ captureOverflow }) => captureOverflow),
    spawnError: turns.find(({ spawnError }) => spawnError)?.spawnError ?? null,
    quiescent: turns.every(({ quiescent }) => quiescent),
    startedAt: turns[0].startedAt,
    endedAt: last.endedAt,
    durationMs: turns.reduce((sum, { durationMs }) => sum + durationMs, 0),
    turnCount: turns.length,
  };
}

export function createLocalExecutionEnvironment({
  captureMaxBytes = DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
  versionProbeTimeoutMs = DEFAULT_VERSION_PROBE_TIMEOUT_MS,
} = {}) {
  return Object.freeze({
    id: "local",
    capabilities: Object.freeze(["environment.isolated-workspace"]),
    captureCapabilities: Object.freeze({
      protocols: Object.freeze([]),
      selectedFields: false,
    }),
    normalizeSettings(settings = {}) {
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        throw new RunSelectionInputError(
          "local environment settings must be an object",
        );
      }
      return deepFreeze(structuredClone(settings));
    },
    describeCapacity() {
      return deepFreeze({ maximumContinuousLifetimeMs: null });
    },
    async execute(envelope) {
      return withExecutionCredentialValues(envelope, async (credentialValues) => {
        const { fixtures, outputArtifacts } = envelope;
        const workspace = await mkdtemp(join(tmpdir(), "hurdle-local-run-"));
        await mkdir(workspace, { recursive: true, mode: 0o700 });
        let processResult = null;
        let toolVersions = null;
        let artifacts = [];
        const integrityIssues = [];
        const cancellationRequested = () => {
          if (!envelope.signal?.aborted) return false;
          integrityIssues.push({
            code: "environment.cancelled",
            phase: "execute",
            effect: "incomplete",
            message: "Local execution was cancelled before starting the next Agent process.",
          });
          return true;
        };
        try {
          const privateHome = join(workspace, ".home");
          await mkdir(privateHome, { recursive: true, mode: 0o700 });
          const coordinated = await executeAgent(envelope, async (program) => {
            const turns = [];
            let agentElapsedMs = 0;
            let plan = program?.initialPlan;
            if (
              !plan
              || !Number.isSafeInteger(program.maxTurns)
              || program.maxTurns < 1
              || program.maxTurns > 16
              || !Number.isSafeInteger(program.maxElapsedMs)
              || program.maxElapsedMs < 1
            ) {
              throw new TypeError("Local agent execution program is invalid");
            }
            if (plan.versionProbe === true) {
              const captured = await captureToolVersions(workspace, plan, envelope.signal, versionProbeTimeoutMs);
              toolVersions = captured.versions;
              if (!captured.quiescent) {
                integrityIssues.push({
                  code: "environment.version-probe-not-quiescent",
                  phase: "execute",
                  effect: "incomplete",
                  message: "A tool-version process could not be stopped before Agent execution.",
                });
                return { process: null };
              }
              if (cancellationRequested()) return { process: null };
            }
            await stageFixtures(workspace, fixtures);
            for (let ordinal = 1; ordinal <= program.maxTurns; ordinal += 1) {
              if (agentElapsedMs >= program.maxElapsedMs) {
                integrityIssues.push({
                  code: "environment.agent-elapsed-limit",
                  phase: "execute",
                  effect: "incomplete",
                  message: "Agent execution exceeded its elapsed-time limit.",
                });
                break;
              }
              const remainingMs = program.maxElapsedMs - agentElapsedMs;
              await stageWorkspaceFiles(workspace, plan.workspaceFiles ?? []);
              if (cancellationRequested()) break;
              const turn = await executeProcess(workspace, {
                ...plan,
                timeoutMs: Math.min(plan.timeoutMs ?? remainingMs, remainingMs),
                env: {
                  ...(plan.env ?? {}),
                  ...credentialValues,
                  HOME: privateHome,
                  // Require an explicit venv for ordinary pip installs. Local
                  // is not an OS sandbox; deliberate bypasses remain possible.
                  PIP_REQUIRE_VIRTUALENV: "true",
                },
              }, captureMaxBytes, envelope.signal);
              turns.push(turn);
              agentElapsedMs += turn.durationMs;
              // An interrupted Agent's partial work is not evidence of failure.
              const cancelled = envelope.signal?.aborted === true;
              if (cancelled) {
                integrityIssues.push({
                  code: "environment.cancelled",
                  phase: "execute",
                  effect: "incomplete",
                  message: "Local execution was cancelled before the Agent process completed.",
                });
              }
              const elapsedLimitReached = !cancelled && agentElapsedMs >= program.maxElapsedMs;
              if (elapsedLimitReached) {
                integrityIssues.push({
                  code: "environment.agent-elapsed-limit",
                  phase: "execute",
                  effect: "incomplete",
                  message: "Agent execution exceeded its elapsed-time limit.",
                });
              }
              if (!turn.quiescent) {
                integrityIssues.push({
                  code: "environment.not-quiescent",
                  phase: "seal",
                  effect: "incomplete",
                  message: "The evaluated process group could not be stopped before evidence sealing.",
                });
                break;
              }
              if (cancelled || elapsedLimitReached) break;
              const directive = await program.onTurn(deepFreeze({
                ordinal,
                process: turn,
              }));
              if (directive?.kind !== "continue") break;
              if (ordinal >= program.maxTurns || !directive.nextPlan) {
                integrityIssues.push({
                  code: "environment.agent-turn-limit",
                  phase: "execute",
                  effect: "incomplete",
                  message: "Agent continuation exceeded its turn limit.",
                });
                break;
              }
              plan = directive.nextPlan;
            }
            if (integrityIssues.length === 0) {
              artifacts = await collectArtifacts(workspace, outputArtifacts);
            }
            return {
              process: aggregateProcesses(turns),
              artifacts,
              integrityIssues,
              egressCollections: [{
                status: "unavailable",
                reason: "unsupported-platform",
                requests: [],
                provenance: {
                  producer: "local-execution-environment",
                  authority: "environment",
                  lifecyclePhase: "execution",
                  capturedAt: new Date().toISOString(),
                  trust: "environment-observed",
                },
              }],
            };
          });
          processResult = coordinated?.process ?? null;
        } finally {
          try {
            await rm(workspace, { recursive: true, force: true });
          } catch {
            integrityIssues.push({
              code: "environment.dispose-failed",
              phase: "dispose",
              effect: "incomplete",
              message: "The local workspace could not be disposed.",
            });
          }
        }
        return Object.freeze({
          process: processResult ? deepFreeze(processResult) : null,
          toolVersions: toolVersions ? deepFreeze(toolVersions) : null,
          artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze(artifact))),
          integrityIssues: deepFreeze(integrityIssues),
          egressCollections: deepFreeze([{
            status: "unavailable",
            reason: "unsupported-platform",
            requests: [],
            provenance: {
              producer: "local-execution-environment",
              authority: "environment",
              lifecyclePhase: "execution",
              capturedAt: new Date().toISOString(),
              trust: "environment-observed",
            },
          }]),
        });
      });
    },
  });
}
