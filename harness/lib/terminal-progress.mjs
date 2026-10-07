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

  const render = () => {
    if (!active || !isTTY) return;
    const glyph = paint(FRAMES[frame % FRAMES.length], "cyan", useColor);
    const elapsed = showElapsed ? `  ${Math.max(0, Math.floor((now() - startedAt) / 1000))}s` : "";
    stream.write(`${CLEAR_LINE}${glyph} ${active}${elapsed}`);
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
