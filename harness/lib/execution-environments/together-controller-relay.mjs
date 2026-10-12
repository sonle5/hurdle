import { createRequire } from "node:module";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = 2 * MAX_FRAME_BYTES;

// No payload logging or persistence: the controller only moves opaque frames.
// Evidence and real credentials stay in the separate Guardian VM.
export async function startTogetherControllerRelay({ workloadUrl, guardianUrl, cellToken, signal }) {
  const WebSocket = createRequire(import.meta.url)("ws");
  if (signal?.aborted) throw Object.assign(new Error("Together relay cancelled"), { name: "AbortError" });
  const sockets = new Set();
  const ids = new Set();
  let failure = null, stopping = false, expectedShutdown = false;
  // Keep preview routes alive while the Agent is thinking or using tools.
  // Protocol ping/pong frames never enter the TCP data stream or journal.
  const heartbeat = setInterval(() => {
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 20000).unref();
  const options = { headers: { "x-together-egress-cell-token": cellToken },
    handshakeTimeout: 10000, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES };
  const fail = (reason = "transport-closed") => {
    if (!expectedShutdown && !stopping) failure ||= new Error(`Together controller relay lost its authenticated transport (${typeof reason === "string" ? reason : "transport-error"})`);
    close();
  };
  function socket(url) {
    const ws = new WebSocket(url, options);
    sockets.add(ws);
    ws.once("close", () => sockets.delete(ws));
    return ws;
  }
  function close() {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", fail);
    for (const ws of sockets) ws.terminate();
    sockets.clear();
  }
  function connectFlow(id) {
    // Register both directions immediately, before either handshake completes.
    const left = socket(guardianUrl), right = socket(`${workloadUrl}/relay/${id}`);
    let finished = false;
    let timer;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ids.delete(id);
      left.terminate(); right.terminate();
    };
    function forward(source, target) {
      const pending = [];
      let queued = 0, paused = false, ended = false, opened = false;
      source.once("open", () => { opened = true; });
      const send = data => {
        target.send(data, { binary: true, compress: false }, error => {
          // An Agent may abort a response while a write callback is pending.
          // That socket can still report OPEN; isolate the cancelled flow.
          if (error) return cleanup();
          if (paused && target.bufferedAmount <= MAX_BUFFER_BYTES / 2) {
            paused = false; source.resume();
          }
        });
        if (target.bufferedAmount > MAX_BUFFER_BYTES && !paused) {
          paused = true; source.pause();
        }
      };
      source.on("message", (data, binary) => {
        if (!binary) return fail("non-binary-frame");
        if (finished) return;
        if (target.readyState === WebSocket.OPEN) send(data);
        else if (target.readyState === WebSocket.CONNECTING) {
          queued += data.length;
          if (queued > MAX_BUFFER_BYTES) return fail();
          pending.push(data);
          if (!paused) { paused = true; source.pause(); }
        } else cleanup();
      });
      target.once("open", () => {
        for (const data of pending) send(data);
        pending.length = 0; queued = 0;
        if (paused && target.bufferedAmount <= MAX_BUFFER_BYTES / 2) { paused = false; source.resume(); }
        if (ended) target.close(1000);
      });
      source.once("close", () => {
        ended = true;
        // The close frame follows all previously queued data. Preserve EOF
        // ordering rather than terminating the other leg at TCP shutdown.
        if (target.readyState === WebSocket.OPEN) target.close(1000);
        if (target.readyState === WebSocket.CLOSED) cleanup();
        else timer ||= setTimeout(cleanup, 30000).unref();
      });
      source.once("error", () => opened ? cleanup() : fail("channel-error"));
      source.once("unexpected-response", () => fail("channel-upgrade"));
    }
    forward(left, right); forward(right, left);
  }
  const control = socket(`${workloadUrl}/control`);
  control.on("message", (data, binary) => {
    let value;
    try { if (binary || data.length > 1024) throw new Error(); value = JSON.parse(data.toString()); }
    catch { return fail(); }
    if (value.kind !== "open" || !/^[a-f0-9]{32}$/.test(value.id) || ids.has(value.id) || ids.size >= 128) return fail();
    ids.add(value.id); connectFlow(value.id);
  });
  control.once("close", () => fail("control-closed"));
  control.once("error", () => fail("control-error"));
  signal?.addEventListener("abort", fail, { once: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Together relay handshake timed out")), 12000);
      const done = error => { clearTimeout(timer); control.removeListener("open", opened); control.removeListener("close", closed); control.removeListener("error", closed); error ? reject(error) : resolve(); };
      const opened = () => done();
      const closed = () => done(failure ?? new Error("Together relay handshake failed"));
      control.once("open", opened); control.once("close", closed); control.once("error", closed);
    });
    if (failure || stopping) throw failure ?? new Error("Together relay cancelled");
    return { assertHealthy() { if (failure || stopping) throw failure ?? new Error("Together relay closed"); },
      allowShutdown() { expectedShutdown = true; }, close };
  } catch (error) { close(); throw error; }
}
