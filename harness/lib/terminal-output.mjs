export const TERMINAL_COLORS = Object.freeze({
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  reset: "\u001b[0m",
});

export function terminalUsesColor(stream) {
  return Boolean(stream?.isTTY) && !process.env.NO_COLOR;
}

export function paintTerminal(value, color, enabled) {
  return enabled ? `${TERMINAL_COLORS[color]}${value}${TERMINAL_COLORS.reset}` : value;
}

export function terminalFact(label, value, { color = null, useColor = false } = {}) {
  const key = paintTerminal(label.padEnd(9), "dim", useColor);
  const text = color ? paintTerminal(value, color, useColor) : value;
  return `  ${key} ${text}\n`;
}

export function terminalHeader(stream) {
  return `\n${paintTerminal("Hurdle", "bold", terminalUsesColor(stream))}\n\n`;
}

export function terminalStatus(status, text, stream) {
  const [symbol, color] = { pass: ["✓", "green"], fail: ["✗", "red"], warning: ["!", "yellow"], skip: ["–", "dim"] }[status];
  return `${paintTerminal(symbol, color, terminalUsesColor(stream))} ${text}\n`;
}

export function terminalNote(text, stream) {
  return `  ${paintTerminal(text, "dim", terminalUsesColor(stream))}\n`;
}

export function terminalNext(commands, stream) {
  const useColor = terminalUsesColor(stream);
  return "\n" + commands.map((command, index) => terminalFact(index ? "" : "Next", command, { useColor })).join("") + "\n";
}

// Safe to paste into POSIX shells, including paths containing shell expansions.
export function quoteCommandArgument(value) {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function suiteCommand(command, suite, { view = false } = {}) {
  const argument = suite === "evals/example.suite.mjs"
    ? "" : ` ${quoteCommandArgument(suite)}`;
  return `npx hurdle ${command}${argument}${view ? " --view" : ""}`;
}
