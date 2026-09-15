function textFromMessage(message) {
  if (typeof message?.rawText === "string" && message.rawText.trim()) {
    return message.rawText.trim();
  }
  if (!Array.isArray(message?.blocks)) return "";
  return message.blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function isVisibleUserPrompt(message) {
  if (message?.role !== "user" || message?.msgType !== "user") return false;
  if (message.blocks?.some((block) => block?.type === "tool_result")) return false;
  const text = textFromMessage(message);
  if (!text) return false;
  if (text.startsWith("Base directory for this skill:")) return false;
  if (text.includes("<system-reminder>") && !text.includes("<task-notification>")) return false;
  if (text.includes("<task-notification>")) return false;
  return true;
}

/**
 * @param {Array<Record<string, any>>} messages
 * @param {{ prompt?: string | null, timestamp?: string | null, uuid?: string }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function withTaskPromptMessage(messages, {
  prompt,
  timestamp,
  uuid = "canonical-task-prompt",
} = {}) {
  if (!Array.isArray(messages)) {
    throw new TypeError("Session messages must be an array");
  }
  if (typeof prompt !== "string" || !prompt.trim()) return messages;
  if (messages.some(isVisibleUserPrompt)) return messages;

  const normalizedPrompt = prompt.trim();
  return [{
    uuid,
    parentUuid: null,
    timestamp: typeof timestamp === "string" ? timestamp : "",
    role: "user",
    msgType: "user",
    blocks: [{ type: "text", text: normalizedPrompt }],
    rawText: normalizedPrompt,
  }, ...messages];
}
