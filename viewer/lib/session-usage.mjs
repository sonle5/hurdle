const fields = {
  input: "input_tokens",
  output: "output_tokens",
  cacheRead: "cache_read_input_tokens",
  cacheCreate: "cache_creation_input_tokens",
};

/** @typedef {{ input: number, output: number, cacheRead: number, cacheCreate: number, totalIn: number }} TokenUsage */
const count = value => Number.isSafeInteger(value) && value >= 0;

function codexTokens(usage) {
  if (![usage?.input_tokens, usage?.output_tokens, usage?.cached_input_tokens].every(count)
    || usage.cached_input_tokens > usage.input_tokens) return null;
  return { input: usage.input_tokens - usage.cached_input_tokens, output: usage.output_tokens,
    cacheRead: usage.cached_input_tokens, cacheCreate: 0, totalIn: usage.input_tokens };
}

// Only usage and tool counts leave this parser; never tool inputs or message text.
export function readTranscriptAgentUsage(transcript, adapterId) {
  const unavailable = { tokenUsage: null, totalTokens: null, toolCalls: null };
  if (!transcript || !["claude-code", "codex"].includes(adapterId)) return unavailable;
  let frames;
  try { frames = transcript.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return unavailable; }
  const tools = new Set();
  if (adapterId === "codex") {
    const usage = frames.filter(frame => frame?.type === "turn.completed").at(-1)?.usage;
    const tokenUsage = codexTokens(usage);
    frames.forEach((frame, index) => {
      if (frame?.type === "item.completed" && ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(frame.item?.type)) {
        tools.add(frame.item.id || index);
      }
    });
    return { tokenUsage, totalTokens: tokenUsage ? tokenUsage.totalIn + tokenUsage.output
      : [usage?.input_tokens, usage?.output_tokens].every(count) ? usage.input_tokens + usage.output_tokens : null,
    toolCalls: frames.some(frame => frame?.type === "item.completed") ? tools.size : null };
  }
  const messages = frames.filter(frame => frame?.message?.role === "assistant").map(frame => ({
    role: "assistant", providerMessageId: frame.message.id, uuid: frame.uuid, usage: frame.message.usage,
  }));
  const reported = frames.filter(frame => frame?.type === "result").at(-1)?.usage;
  const tokenUsage = readSessionTokenUsage(reported)
    ?? (messages.some(message => readSessionTokenUsage(message.usage)) ? summarizeSessionTokens(messages) : null);
  frames.forEach((frame, index) => {
    if (frame?.message?.role !== "assistant" || !Array.isArray(frame.message.content)) return;
    frame.message.content.forEach((block, blockIndex) => {
      if (block?.type === "tool_use") tools.add(block.id || `${index}:${blockIndex}`);
    });
  });
  return { tokenUsage, totalTokens: tokenUsage ? tokenUsage.totalIn + tokenUsage.output : null,
    toolCalls: messages.length ? tools.size : null };
}

export function projectAgentUsage(record, observed = {}) {
  if (record.state !== "complete") return { tokenUsage: null, totalTokens: null, toolCalls: null };
  const common = record.metrics?.common ?? {};
  const adapterId = record.snapshot.agent.adapterId;
  const adapter = record.metrics?.adapters?.[adapterId] ?? {};
  let tokenUsage = null;
  if (adapterId === "claude-code" && [adapter.cacheReadInputTokens, adapter.cacheCreationInputTokens].every(count)) {
    tokenUsage = readSessionTokenUsage({ input_tokens: common.inputTokens, output_tokens: common.outputTokens,
      cache_read_input_tokens: adapter.cacheReadInputTokens, cache_creation_input_tokens: adapter.cacheCreationInputTokens });
  } else if (adapterId === "codex") {
    tokenUsage = codexTokens({ input_tokens: common.inputTokens, output_tokens: common.outputTokens,
      cached_input_tokens: adapter.cachedInputTokens });
  }
  tokenUsage ??= observed.tokenUsage ?? null;
  const totalTokens = tokenUsage ? tokenUsage.totalIn + tokenUsage.output
    : count(common.totalTokens) ? common.totalTokens
      : adapterId === "codex" && [common.inputTokens, common.outputTokens].every(count) ? common.inputTokens + common.outputTokens
        : observed.totalTokens ?? null;
  return { tokenUsage, totalTokens, toolCalls: count(common.toolCalls) ? common.toolCalls : observed.toolCalls ?? null };
}

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
