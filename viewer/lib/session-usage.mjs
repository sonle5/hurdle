const fields = {
  input: "input_tokens",
  output: "output_tokens",
  cacheRead: "cache_read_input_tokens",
  cacheCreate: "cache_creation_input_tokens",
};

/** @param {unknown} usage */
export function readSessionTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const [key, field] of Object.entries(fields)) {
    const value = usage[field] ?? (key.startsWith("cache") ? 0 : undefined);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    tokens[key] = value;
  }
  return { ...tokens, totalIn: tokens.input + tokens.cacheRead + tokens.cacheCreate };
}

/** @param {unknown} [reportedUsage] */
export function summarizeSessionTokens(messages, reportedUsage = null) {
  const reported = readSessionTokenUsage(reportedUsage);
  if (reported) return reported;
  // Claude can emit one frame per content block with the same message ID.
  // Usage snapshots belong to the API message, not each displayed block.
  const byMessage = new Map();
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    const usage = readSessionTokenUsage(message.usage);
    if (!usage) continue;
    const id = [message.providerMessageId, message.uuid].find(value => typeof value === "string" && value.length > 0) ?? index;
    const previous = byMessage.get(id);
    byMessage.set(id, previous
      ? Object.fromEntries(Object.keys(fields).map(key => [key, Math.max(previous[key], usage[key])]))
      : usage);
  }
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalIn: 0 };
  for (const usage of byMessage.values()) {
    for (const key of Object.keys(fields)) tokens[key] += usage[key];
  }
  tokens.totalIn = tokens.input + tokens.cacheRead + tokens.cacheCreate;
  return tokens;
}
