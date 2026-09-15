import { spawn as nodeSpawn } from "node:child_process";

const READY_PATTERN = /\bready\s+in\b/i;
const READY_TIMEOUT_MS = 30_000;
const READINESS_CAPTURE_MAX_CHARACTERS = 64 * 1024;
const CANONICAL_STORE_KEYS = new Set([
  "TAE_RESULT_STORE_MODE",
  "TAE_RESULT_STORE_ROOT",
  "TAE_RESULT_STORE_DATABASE_URL",
]);
const VIEWER_PROCESS_ENV_KEYS = new Set([
  "CI",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NODE_ENV",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "WINDIR",
]);

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function startupFailureReason(output) {
  if (/EADDRINUSE|address already in use/i.test(output)) return "port-in-use";
  if (/unable to acquire lock|another next dev server is already running/i.test(output)) {
    return "viewer-lock-held";
  }
  return null;
}

function canonicalStoreEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Viewer Store selection is invalid");
  }
  const keys = Object.keys(value).sort();
  const mode = value.TAE_RESULT_STORE_MODE;
  const required = mode === "local"
    ? ["TAE_RESULT_STORE_MODE", "TAE_RESULT_STORE_ROOT"]
    : mode === "postgres"
      ? ["TAE_RESULT_STORE_DATABASE_URL", "TAE_RESULT_STORE_MODE"]
      : null;
  if (
    !required
    || keys.length !== required.length
    || keys.some((key, index) => key !== required[index])
    || keys.some((key) => !CANONICAL_STORE_KEYS.has(key) || !nonblank(value[key]))
  ) {
    throw new TypeError("Viewer Store selection is invalid");
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function viewerEnvironment(env, storeEnvironment) {
  const selected = canonicalStoreEnvironment(storeEnvironment);
  const viewerEnv = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (VIEWER_PROCESS_ENV_KEYS.has(key)) viewerEnv[key] = value;
  }
  return { ...viewerEnv, TAE_VIEWER_READ_ONLY: "1", ...selected };
}

function launchOptions({ cwd, port, env, storeEnvironment }) {
  if (!nonblank(cwd) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Viewer launcher options are invalid");
  }
  return {
    cwd,
    detached: process.platform !== "win32",
    env: viewerEnvironment(env, storeEnvironment),
    stdio: ["ignore", "pipe", "pipe"],
  };
}

function signalOwnedViewer(child, signal) {
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return child.kill(signal);
    if (process.platform === "win32") {
      // taskkill includes descendants; never invoke through a shell.
      const killer = nodeSpawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 1000 });
      killer.on("error", () => {});
      return true;
    }
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return false;
  }
}

function ownedViewerGroupExists(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1 || process.platform === "win32") return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function viewerInvocation({ port }) {
  return {
    command: "npm",
    args: ["--prefix", "viewer", "run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)],
  };
}

/**
 * Runs the first-party Viewer in the foreground from its source checkout. The caller owns display of the ready URL; this
 * boundary never opens a browser or reads Result Stores.
 */
export function launchViewer({
  storeEnvironment,
  port = 3000,
  cwd,
  env = process.env,
  spawn = nodeSpawn,
  processTarget = process,
  readinessTimeoutMs = READY_TIMEOUT_MS,
  shutdownGraceMs = 250,
  shutdownTimeoutMs = 1500,
  onReady = () => {},
} = {}) {
  if (typeof spawn !== "function" || typeof onReady !== "function") {
    throw new TypeError("Viewer launcher options are invalid");
  }
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 1) {
    throw new TypeError("Viewer launcher options are invalid");
  }
  if (![shutdownGraceMs, shutdownTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)
      || shutdownTimeoutMs <= shutdownGraceMs) throw new TypeError("Viewer shutdown deadlines are invalid");
  const options = launchOptions({ cwd, port, env, storeEnvironment });
  const invocation = viewerInvocation({ port });
  const url = `http://127.0.0.1:${port}`;
  let child;
  try {
    child = spawn(invocation.command, invocation.args, options);
  } catch {
    return Promise.resolve(Object.freeze({ kind: "failed", exitCode: 1 }));
  }
  if (!child || typeof child.once !== "function" || typeof child.kill !== "function") {
    return Promise.resolve(Object.freeze({ kind: "failed", exitCode: 1 }));
  }

  return new Promise((resolve) => {
    let ready = false;
    let interruptedSignal = null;
    let settled = false;
    let stopping = false;
    let closeOutcome = null;
    let forceKillTimer;
    let shutdownTimer;
    const decoder = new TextDecoder();
    let readinessText = "";
    const appendReadinessText = (chunk) => {
      readinessText = `${readinessText}${decoder.decode(chunk, { stream: true })}`
        .slice(-READINESS_CAPTURE_MAX_CHARACTERS);
    };
    const timeout = setTimeout(() => stop("SIGTERM"), readinessTimeoutMs);
    const onSigint = () => interrupt("SIGINT");
    const onSigterm = () => interrupt("SIGTERM");
    const cleanUp = () => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      clearTimeout(shutdownTimer);
      child.stdout?.off?.("data", onStdout);
      child.stderr?.off?.("data", onStderr);
      processTarget?.off?.("SIGINT", onSigint);
      processTarget?.off?.("SIGTERM", onSigterm);
    };
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      cleanUp();
      resolve(Object.freeze(outcome));
    };
    const stop = (signal) => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(timeout);
      forceKillTimer = setTimeout(() => {
        signalOwnedViewer(child, "SIGKILL");
      }, shutdownGraceMs);
      shutdownTimer = setTimeout(() => {
        if (closeOutcome && !ownedViewerGroupExists(child)) finish(closeOutcome);
        else {
          // Do not retain open pipes/listeners forever or claim confirmed disposal.
          child.stdout?.destroy?.();
          child.stderr?.destroy?.();
          child.unref?.();
          finish({ kind: "failed", exitCode: 1, reason: "disposal-unconfirmed" });
        }
      }, shutdownTimeoutMs);
      signalOwnedViewer(child, signal);
    };
    const interrupt = (signal) => {
      if (interruptedSignal || settled) return;
      interruptedSignal = signal;
      stop(signal);
    };
    const finishClosed = (outcome) => {
      closeOutcome = outcome;
      if (ownedViewerGroupExists(child)) stop("SIGTERM");
      else finish(outcome);
    };
    const onStdout = (chunk) => {
      if (ready || stopping) return;
      appendReadinessText(chunk);
      if (!READY_PATTERN.test(readinessText)) return;
      ready = true;
      readinessText = "";
      clearTimeout(timeout);
      onReady(url);
    };
    const onStderr = (chunk) => {
      if (!ready) appendReadinessText(chunk);
    };
    child.stdout?.on?.("data", onStdout);
    child.stderr?.on?.("data", onStderr);
    child.once("error", () => finishClosed({ kind: "failed", exitCode: 1, ...(ready ? { url } : {}) }));
    // npm may exit before a Next descendant closes inherited pipes.
    child.once("exit", () => stop("SIGTERM"));
    child.once("close", (code, signal) => {
      if (interruptedSignal) {
        finishClosed({
          kind: "interrupted",
          signal: interruptedSignal,
          exitCode: signalExitCode(interruptedSignal),
          ...(ready ? { url } : {}),
        });
        return;
      }
      if (ready && code === 0 && signal === null) {
        finishClosed({ kind: "stopped", exitCode: 0, url });
        return;
      }
      const reason = ready ? null : startupFailureReason(readinessText);
      finishClosed({
        kind: "failed",
        exitCode: 1,
        ...(ready ? { url } : {}),
        ...(reason ? { reason } : {}),
      });
    });
    processTarget?.on?.("SIGINT", onSigint);
    processTarget?.on?.("SIGTERM", onSigterm);
  });
}
