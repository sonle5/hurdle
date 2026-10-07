import { createInterface, emitKeypressEvents } from "node:readline";

// Secret input is never echoed or included in an error. Restore terminal state
// on completion, cancellation, and EOF.
export async function promptSetup({ message, secret = false }, io) {
  const input = io.stdin ?? process.stdin;
  const output = io.stdout;
  if (!input.isTTY || !output.isTTY) return null;
  if (!secret) {
    const reader = createInterface({ input, output });
    try {
      return await new Promise(resolve => {
        reader.once("close", () => resolve(null));
        reader.question(message, resolve);
      });
    } finally { reader.close(); }
  }
  output.write(message);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise(resolve => {
      let value = "";
      const finish = answer => {
        input.off("keypress", onKey);
        input.off("end", onEnd);
        output.write("\n");
        resolve(answer);
      };
      const onEnd = () => finish(null);
      const onKey = (text, key = {}) => {
        if ((key.ctrl && ["c", "d"].includes(key.name)) || key.name === "escape") return finish(null);
        if (["return", "enter"].includes(key.name)) return finish(value);
        if (key.name === "backspace") { value = value.slice(0, -1); return; }
        if (text && !key.ctrl && !key.meta && /^[\x21-\x7e]+$/.test(text)) value += text;
      };
      input.on("keypress", onKey);
      input.once("end", onEnd);
    });
  } finally {
    input.setRawMode(Boolean(wasRaw));
    input.pause();
  }
}
