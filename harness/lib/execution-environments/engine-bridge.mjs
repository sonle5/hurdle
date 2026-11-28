import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

// The controller side of the sandbox's `nexus-compiler` shim. The Agent runs
// the shim; its argv and stdin cross the socket on an engine stream and are
// run here, on the controller host, as an operator-configured command prefix
// (such as `kubectl exec ... -- python3 -m nexus_compiler`) plus the argv this
// bridge validated. Credentials the prefix needs stay in this process's
// environment; the sandbox sees only the call's stdout, stderr and exit code.
//
// The operator picks the profile and the pinned values; nothing the Agent
// sends can choose them. A pinned flag the Agent repeats or gives another
// value is refused, not replaced. Every call, refusals included, is one line
// of `engine-calls.jsonl`.

export const DEFAULT_STDIN_MAX_BYTES = 1024 * 1024;
export const DEFAULT_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_STATUS_MIN_INTERVAL_MS = 5_000;
const KILL_GRACE_MS = 5_000;
const MAX_REQUEST_LINE_BYTES = 64 * 1024;

// Response frames to the shim: a type byte, a 4-byte big-endian length, then
// the body. The exit frame is last and carries {exit_code, refused}.
export const FRAME = Object.freeze({ stdout: 1, stderr: 2, exit: 3 });

const value = (check) => ({ takes: true, check });
const flag = { takes: false };
const any = value((text) => !text.startsWith("-"));
const positiveInteger = value((text) => /^[1-9][0-9]*$/.test(text));
const positiveNumber = value((text) => /^[0-9]+(\.[0-9]+)?$/.test(text) && Number(text) > 0);

// Per verb: its argv head, then its flags in the order the run argv lists
// them. `pin` names the operator value a pinned flag always carries.
const VERBS = Object.freeze({
  submit: {
    head: ["engine", "submit"],
    flags: {
      "--engine-id": { pin: "engineId" },
      "--tier": value((text) => text === "fast" || text === "slow"),
      "--forward": value((text) => text === "-"),
      "--root": { pin: "root" },
    },
  },
  status: { head: ["engine", "status"], flags: { "--root": { pin: "root" } } },
  records: { head: ["engine", "records"], flags: { "--root": { pin: "root" }, "--hold": flag } },
  lock: {
    head: ["lock"],
    flags: {
      "--task": { pin: "task" },
      "--start-root": { pin: "startRoot" },
      "--model-dir": { pin: "modelDir" },
      "--runtime": { pin: "runtime" },
      "--reproduce": flag,
      "--repeats": positiveInteger,
      "--measure": flag,
      "--hours": positiveNumber,
      "--depths": value((text) => /^[0-9]+(,[0-9]+)*$/.test(text)),
    },
  },
  check: {
    head: ["check"],
    flags: {
      "--lock": any,
      "--model-dir": { pin: "modelDir" },
      "--runtime": { pin: "runtime" },
    },
  },
});

export const PROFILES = Object.freeze({
  loop: Object.freeze({ verbs: ["submit", "status", "records"], pins: ["root", "engineId"] }),
  setup: Object.freeze({
    verbs: ["lock", "check", "status", "records"],
    pins: ["root", "task", "startRoot", "modelDir", "runtime"],
  }),
});

function nonEmptyString(text) {
  return typeof text === "string" && text.length > 0 && !text.includes("\0");
}

export function normalizeEngineBridgeConfig({
  profile,
  command,
  env = process.env,
  pins = {},
  budgetHours = null,
  stdinMaxBytes = DEFAULT_STDIN_MAX_BYTES,
  outputMaxBytes = DEFAULT_OUTPUT_MAX_BYTES,
  statusMinIntervalMs = DEFAULT_STATUS_MIN_INTERVAL_MS,
  ...rest
} = {}) {
  if (Object.keys(rest).length) throw new TypeError(`Unknown engine bridge setting: ${Object.keys(rest)[0]}`);
  if (!Object.hasOwn(PROFILES, profile)) throw new TypeError("Engine bridge profile must be loop or setup");
  if (!Array.isArray(command) || command.length === 0 || !command.every(nonEmptyString))
    throw new TypeError("Engine bridge command must be a non-empty argv prefix");
  for (const name of PROFILES[profile].pins)
    if (!nonEmptyString(pins[name])) throw new TypeError(`Engine bridge ${profile} profile requires pin ${name}`);
  if (budgetHours !== null && !(Number.isFinite(budgetHours) && budgetHours >= 0))
    throw new TypeError("Engine bridge budgetHours must be a non-negative number");
  for (const [name, bound] of Object.entries({ stdinMaxBytes, outputMaxBytes, statusMinIntervalMs }))
    if (!Number.isSafeInteger(bound) || bound < 0) throw new TypeError(`Engine bridge ${name} must be a non-negative integer`);
  return Object.freeze({
    profile, command: Object.freeze([...command]), env, pins: Object.freeze({ ...pins }),
    budgetHours, stdinMaxBytes, outputMaxBytes, statusMinIntervalMs,
  });
}

function refusal(code, verb = null) {
  return { refused: code, verb };
}

// Names the call's verb from its head, or refuses it for this profile.
function verbOf(profile, argv) {
  const verb = argv[0] === "engine" ? argv[1] : argv[0];
  if (!Object.hasOwn(VERBS, verb) || !PROFILES[profile].verbs.includes(verb)) return null;
  return VERBS[verb].head.every((word, index) => argv[index] === word) ? verb : null;
}

// Validates the Agent's argv and returns the argv to run, or a refusal.
export function resolveEngineArgv(config, argv) {
  if (!Array.isArray(argv) || !argv.every((word) => typeof word === "string" && !word.includes("\0")))
    return refusal("verb-not-allowed");
  const verb = verbOf(config.profile, argv);
  if (!verb) return refusal("verb-not-allowed");
  const { head, flags } = VERBS[verb];
  const given = new Map();
  const words = argv.slice(head.length);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const equals = word.indexOf("=");
    const name = word.startsWith("--") && equals > 0 ? word.slice(0, equals) : word;
    const spec = Object.hasOwn(flags, name) ? flags[name] : null;
    if (!spec) return refusal("flag-not-allowed", verb);
    const takes = spec.pin !== undefined || spec.takes;
    let text = null;
    if (equals > 0 && name !== word) {
      if (!takes) return refusal("flag-not-allowed", verb);
      text = word.slice(equals + 1);
    } else if (takes) {
      if (index + 1 >= words.length) return refusal("flag-not-allowed", verb);
      text = words[++index];
    }
    if (given.has(name)) return refusal(spec.pin !== undefined ? "pinned-flag" : "flag-not-allowed", verb);
    if (spec.pin !== undefined) {
      if (text !== config.pins[spec.pin]) return refusal("pinned-flag", verb);
    } else if (takes && !spec.check(text)) {
      return refusal("flag-not-allowed", verb);
    }
    given.set(name, text);
  }
  const run = [...head];
  for (const [name, spec] of Object.entries(flags)) {
    if (spec.pin !== undefined) run.push(name, config.pins[spec.pin]);
    else if (name === "--hold") run.push(name);
    else if (given.has(name)) run.push(...(spec.takes ? [name, given.get(name)] : [name]));
  }
  return { verb, argv: run, hours: given.has("--hours") ? Number(given.get("--hours")) : null };
}

// Follows a tar stream block by block and reports when its end-of-archive
// marker, two zero header blocks, has passed. Entry bodies are skipped by
// their header's size, so a body of zeros is not mistaken for the marker.
export function createTarEndScanner() {
  let pending = Buffer.alloc(0);
  let skip = 0;
  let zeros = 0;
  let ended = false;
  return {
    get ended() { return ended; },
    push(chunk) {
      if (ended) return true;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (!ended && pending.length - offset >= 512) {
        const block = pending.subarray(offset, offset + 512);
        offset += 512;
        if (skip > 0) { skip -= 1; continue; }
        if (block.every((byte) => byte === 0)) {
          zeros += 1;
          if (zeros === 2) ended = true;
          continue;
        }
        zeros = 0;
        const field = block.subarray(124, 136);
        // GNU base-256 sizes set the top bit; anything that large is past the cap.
        const size = field[0] & 0x80
          ? Number.MAX_SAFE_INTEGER
          : Number.parseInt(field.toString("latin1").replace(/[\0 ]+$/, "").trim() || "0", 8);
        skip = Number.isFinite(size) ? Math.ceil(size / 512) : Number.MAX_SAFE_INTEGER;
      }
      pending = pending.subarray(offset);
      return ended;
    },
  };
}

function hex(hash) {
  return hash.digest("hex");
}

function frame(type, body) {
  const head = Buffer.allocUnsafe(5);
  head[0] = type;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

function hold(output, pending) {
  if (typeof pending?.then !== "function") return;
  output.pause();
  pending.then(() => output.resume());
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  timer.unref?.();
  child.once("exit", () => clearTimeout(timer));
}

export function createEngineBridge(settings, { spawnProcess = spawn, now = () => new Date() } = {}) {
  const config = normalizeEngineBridgeConfig(settings);
  const lines = [];
  const inFlight = new Set();
  const children = new Set();
  let lastStatusAt = null;
  let remainingHours = config.budgetHours;
  let closed = false;

  function append(entry) {
    lines.push(`${JSON.stringify({ v: 1, seq: lines.length + 1, profile: config.profile, ...entry })}\n`);
  }

  // One call: `stdin` is its bytes, or null when the shim sent more than the
  // bound. `onStdout`/`onStderr` receive output as it arrives; one that
  // returns a promise holds the process's output until it settles. Resolves
  // with {exitCode, refused} once the call's line is logged.
  async function call({ argv, stdin, stdinBytes = stdin?.length ?? 0, stdinSha256 }, { onStdout = () => {}, onStderr = () => {}, signal } = {}) {
    const startedAt = now().toISOString();
    const base = {
      stdin_bytes: stdinBytes,
      stdin_sha256: stdinSha256 ?? hex(createHash("sha256").update(stdin ?? Buffer.alloc(0))),
    };
    // A refused call ran nothing; its line records the argv it would have run
    // once that is known, otherwise the Agent's own argv.
    const refuse = (code, verb, logged = argv) => {
      const words = Array.isArray(logged) && logged.every((word) => typeof word === "string") ? logged : [];
      append({
        verb, argv: words, started_at: startedAt, ended_at: now().toISOString(),
        exit_code: null, refused: code, ...base,
        stdout_bytes: 0, stdout_sha256: hex(createHash("sha256")), stderr_bytes: 0, truncated: false,
      });
      return { exitCode: null, refused: code };
    };
    const resolved = resolveEngineArgv(config, argv);
    if (resolved.refused) return refuse(resolved.refused, resolved.verb);
    const { verb } = resolved;
    // The run is ending: nothing new starts.
    if (closed) return refuse("in-flight", verb, resolved.argv);
    if (stdin === null) return refuse("stdin-too-large", verb, resolved.argv);
    if (inFlight.has(verb)) return refuse("in-flight", verb, resolved.argv);
    const startedMs = Date.parse(startedAt);
    if (verb === "status" && lastStatusAt !== null && startedMs - lastStatusAt < config.statusMinIntervalMs)
      return refuse("rate-limited", verb, resolved.argv);
    if (resolved.hours !== null && remainingHours !== null && resolved.hours > remainingHours)
      return refuse("budget", verb, resolved.argv);
    if (verb === "status") lastStatusAt = startedMs;
    // Hours are spent when the call starts: the GPU session is booked whether
    // or not the call later succeeds.
    if (resolved.hours !== null && remainingHours !== null) remainingHours -= resolved.hours;
    inFlight.add(verb);
    try {
      return await run(verb, resolved.argv, stdin, startedAt, base, { onStdout, onStderr, signal });
    } finally {
      inFlight.delete(verb);
    }
  }

  function run(verb, argv, stdin, startedAt, base, { onStdout, onStderr, signal }) {
    return new Promise((resolve) => {
      const stdoutHash = createHash("sha256");
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let refused = null;
      let settled = false;
      const tar = verb === "records" ? createTarEndScanner() : null;
      let child;
      const finish = (exitCode) => {
        if (settled) return;
        settled = true;
        children.delete(child);
        signal?.removeEventListener("abort", abort);
        if (!refused && tar && !tar.ended) refused = "unterminated-tar";
        const code = refused ? null : exitCode;
        append({
          verb, argv, started_at: startedAt, ended_at: now().toISOString(),
          exit_code: code, refused, ...base,
          stdout_bytes: stdoutBytes, stdout_sha256: hex(stdoutHash), stderr_bytes: stderrBytes,
          truncated: refused === "output-cap",
        });
        resolve({ exitCode: code, refused });
      };
      const abort = () => { if (child) stopChild(child); };
      try {
        child = spawnProcess(config.command[0], [...config.command.slice(1), ...argv], {
          shell: false, env: config.env, stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        return finish(null);
      }
      children.add(child);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || closed) abort();
      child.stdin.on("error", () => {});
      // `records --hold` exits only once its stdin ends, which is when the
      // whole archive has arrived here; the other verbs get the shim's stdin.
      if (!tar) child.stdin.end(stdin);
      const overCap = () => { refused ??= "output-cap"; stopChild(child); };
      child.stdout.on("data", (chunk) => {
        if (refused) return;
        const room = config.outputMaxBytes - stdoutBytes;
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        stdoutBytes += kept.length;
        stdoutHash.update(kept);
        if (kept.length) hold(child.stdout, onStdout(kept));
        if (kept.length < chunk.length) return overCap();
        if (tar?.push(kept)) child.stdin.end();
      });
      child.stderr.on("data", (chunk) => {
        if (refused) return;
        const room = config.outputMaxBytes - stderrBytes;
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        stderrBytes += kept.length;
        if (kept.length) hold(child.stderr, onStderr(kept));
        if (kept.length < chunk.length) overCap();
      });
      child.once("error", () => finish(null));
      child.once("close", (exitCode) => finish(exitCode));
    });
  }

  // Serves one engine stream: the shim's `{"argv":[...]}` line, then its stdin
  // until FIN. The answer is stdout and stderr frames, then the exit frame,
  // then FIN. The stream closing before the call ends stops its process.
  function handle(stream) {
    stream.on("error", () => {});
    const controller = new AbortController();
    stream.once("close", () => controller.abort());
    let head = Buffer.alloc(0);
    let request = null;
    const hash = createHash("sha256");
    const parts = [];
    let bytes = 0;
    let overflow = false;
    let started = false;
    // A slow socket holds back the process's output rather than buffering it.
    const send = (type, body) => {
      if (stream.destroyed || !stream.writable || stream.write(frame(type, body))) return undefined;
      return new Promise((resume) => {
        const done = () => { stream.off("drain", done); stream.off("close", done); resume(); };
        stream.once("drain", done);
        stream.once("close", done);
      });
    };
    const start = () => {
      if (started) return;
      started = true;
      stream.removeListener("data", onData);
      stream.resume();
      const argv = Array.isArray(request?.argv) ? request.argv : null;
      call({
        argv, stdin: overflow ? null : Buffer.concat(parts), stdinBytes: bytes, stdinSha256: hex(hash),
      }, {
        onStdout: (chunk) => send(FRAME.stdout, chunk),
        onStderr: (chunk) => send(FRAME.stderr, chunk),
        signal: controller.signal,
      }).then(({ exitCode, refused }) => {
        send(FRAME.exit, Buffer.from(JSON.stringify({ exit_code: exitCode, refused })));
        if (!stream.destroyed) stream.end();
      });
    };
    const takeStdin = (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
      if (bytes > config.stdinMaxBytes) {
        overflow = true;
        return start();
      }
      parts.push(chunk);
    };
    const onData = (chunk) => {
      if (request) return takeStdin(chunk);
      head = Buffer.concat([head, chunk]);
      const index = head.indexOf(0x0a);
      if (index < 0) {
        if (head.length > MAX_REQUEST_LINE_BYTES) start();
        return;
      }
      try { request = JSON.parse(head.subarray(0, index).toString("utf8")) ?? {}; } catch { request = {}; }
      const rest = head.subarray(index + 1);
      head = Buffer.alloc(0);
      if (rest.length) takeStdin(rest);
    };
    stream.on("data", onData);
    stream.once("end", start);
  }

  return Object.freeze({
    config,
    call,
    handle,
    log: () => Buffer.from(lines.join("")),
    get remainingHours() { return remainingHours; },
    // Stops every call still running and waits for their processes to exit.
    async close() {
      closed = true;
      await Promise.all([...children].map((child) => new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once("close", done);
        stopChild(child);
      })));
    },
  });
}
