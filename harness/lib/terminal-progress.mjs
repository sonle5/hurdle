import { paintTerminal as paint } from "./terminal-output.mjs";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\u001b[2K";

export function createTerminalProgress({
  stream,
  isTTY = Boolean(stream?.isTTY),
  useColor = isTTY && !process.env.NO_COLOR,
  intervalMs = 80,
  showElapsed = false,
  now = Date.now,
} = {}) {
  if (!stream || typeof stream.write !== "function") {
    throw new TypeError("Quickstart progress requires a writable stream");
  }
  let active = null;
  let frame = 0;
  let timer = null;
  let startedAt = 0;

  const labelText = (label) => {
    if (typeof label !== "string" || !label.trim()) {
      throw new TypeError("Terminal progress label is invalid");
    }
    return label.trim();
  };

  // CLEAR_LINE erases only the cursor's row, so a live line that wraps leaves fragments
  // behind. Shorten it from the middle to keep both the subject and the current phase.
  const fit = (label, reserved) => {
    const columns = stream.columns;
    if (!Number.isSafeInteger(columns) || columns <= 0) return label;
    const room = columns - 1 - reserved;
    if (label.length <= room) return label;
    if (room < 2) return "";
    const head = Math.ceil((room - 1) / 2);
    return `${label.slice(0, head)}…${label.slice(label.length - (room - 1 - head))}`;
  };
  const render = () => {
    if (!active || !isTTY) return;
    const glyph = paint(FRAMES[frame % FRAMES.length], "cyan", useColor);
    const elapsed = showElapsed ? `  ${Math.max(0, Math.floor((now() - startedAt) / 1000))}s` : "";
    stream.write(`${CLEAR_LINE}${glyph} ${fit(active, 2 + elapsed.length)}${elapsed}`);
    frame += 1;
  };
  const clearTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const settle = (symbol, color, label, duration = "") => {
    clearTimer();
    if (isTTY) stream.write(CLEAR_LINE);
    const suffix = duration ? `  ${duration}` : "";
    stream.write(`${paint(symbol, color, useColor)} ${label}${suffix}\n`);
    active = null;
  };
  const start = (label) => {
    clearTimer();
    active = labelText(label);
    startedAt = now();
    frame = 0;
    if (!isTTY) {
      stream.write(`- ${active}\n`);
      return;
    }
    render();
    timer = setInterval(render, intervalMs);
    timer.unref?.();
  };

  return Object.freeze({
    start,
    update(label) {
      const value = labelText(label);
      if (!active) {
        start(value);
        return;
      }
      active = value;
      if (!isTTY) {
        stream.write(`- ${active}\n`);
        return;
      }
      render();
    },
    detail(label) {
      const value = labelText(label);
      if (!isTTY) {
        stream.write(`  ${value}\n`);
        return;
      }
      stream.write(`${CLEAR_LINE}  ${value}\n`);
      render();
    },
    succeed(label, duration) {
      settle("✓", "green", label, duration);
    },
    warn(label, duration) {
      settle("!", "yellow", label, duration);
    },
    fail(label, duration) {
      settle("✗", "red", label, duration);
    },
    stop() {
      clearTimer();
      if (active && isTTY) stream.write(CLEAR_LINE);
      active = null;
    },
  });
}
