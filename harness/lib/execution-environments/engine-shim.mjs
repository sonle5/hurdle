import net from "node:net";

// The sandbox half of the `nexus-compiler` shim (bin/nexus-compiler.mjs). It
// connects to the sandbox server's loopback engine port, sends
// `{"argv":[...]}` and a newline, then its stdin, then ends its half. The
// answer is frames of a type byte and a 4-byte big-endian length: stdout (1),
// stderr (2), and last the exit (3), `{"exit_code", "refused"}`.

export const ENGINE_PORT = 18084;
const FRAME_HEAD = 5;
const STDOUT = 1;
const STDERR = 2;
const EXIT = 3;
// A refused call ran nothing; 2 is what argparse returns for bad usage.
const REFUSED_EXIT = 2;

// Only a call that reads stdin (`--forward -`) forwards it; others end their
// half at once, so a caller's open stdin cannot hold them.
function readsStdin(argv) {
  return argv.includes("-") || argv.some((word) => /^--[a-z-]+=-$/.test(word));
}

function write(output, bytes) {
  return new Promise((done) => {
    if (output.write(bytes)) done();
    else output.once("drain", done);
  });
}

export function connectEngineShim({ argv, stdin, stdout, stderr, port = ENGINE_PORT, host = "127.0.0.1" }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code, message = null) => {
      if (settled) return;
      settled = true;
      if (message) stderr.write(`nexus-compiler: ${message}\n`);
      socket.destroy();
      resolve(code);
    };
    const socket = net.createConnection({ host, port, allowHalfOpen: true });
    socket.once("error", (error) => finish(REFUSED_EXIT, `the engine bridge is unavailable (${error.code ?? error.message})`));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ argv })}\n`);
      if (readsStdin(argv)) stdin.pipe(socket);
      else socket.end();
    });
    let pending = Buffer.alloc(0);
    let draining = Promise.resolve();
    socket.on("data", (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= FRAME_HEAD) {
        const length = pending.readUInt32BE(1);
        if (pending.length < FRAME_HEAD + length) break;
        const type = pending[0];
        const body = pending.subarray(FRAME_HEAD, FRAME_HEAD + length);
        pending = pending.subarray(FRAME_HEAD + length);
        if (type === EXIT) {
          let result = {};
          try { result = JSON.parse(body.toString("utf8")); } catch { /* reported below */ }
          draining.then(() => {
            if (result.refused) finish(REFUSED_EXIT, `the engine bridge refused this call (${result.refused})`);
            else if (Number.isSafeInteger(result.exit_code)) finish(result.exit_code);
            else finish(REFUSED_EXIT, "the engine call ended without an exit code");
          });
          return;
        }
        const output = type === STDOUT ? stdout : type === STDERR ? stderr : null;
        if (!output) return finish(REFUSED_EXIT, "the engine bridge sent an unknown frame");
        // A slow reader of the shim's output holds back the call's output.
        socket.pause();
        draining = draining.then(() => write(output, body)).then(() => socket.resume());
      }
    });
    socket.once("end", () => draining.then(() => finish(REFUSED_EXIT, "the engine bridge closed before the call ended")));
  });
}
