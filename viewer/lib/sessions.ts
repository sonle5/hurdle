import { readSessionTokenUsage, summarizeSessionTokens } from "./session-usage.mjs";
import { withTaskPromptMessage } from "./session-prompt.mjs";

export type ToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };

export type ParsedMessage = {
  uuid: string;
  parentUuid: string | null;
  providerMessageId?: string;
  timestamp: string;
  role: "user" | "assistant";
  msgType: string;
  blocks: MessageBlock[];
  rawText?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model?: string;
};

export type SessionStats = {
  durationSec: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
    totalIn: number;
  };
  costUsd: number | null;
  costSource?: "reported" | "estimated" | "unavailable";
  firstTimestamp: string;
  lastTimestamp: string;
  skillInjections: number;
  injectedSkills: string[];
  mcpCalls: number;
  mcpMethods: string[];
  taskNotifications: number;
  effectiveUserMessages: number;
  interactions: number; // AskUserQuestion tool calls
  model: string | null;
  harnessVersion: string | null;
};

export type Session = {
  id: string;
  version: "v1" | "v2";
  run?: string; // "run1", "run2", etc.
  agent: "CC" | "Pi" | "CDX" | "OC";
  configId: "C1" | "C2" | "C3" | "C4" | "C5";
  configLabel: string;
  configFull: string;
  task: string;
  dirName: string;
  dirPath: string;
  messages: ParsedMessage[];
  stats: SessionStats;
  resultsMarkdown?: string;
  prompt?: string;
  shareUrl?: string;
  outcome?: {
    passed: boolean | null;
    notes?: string;
    skills?: string[];
  };
};

function detectSessionFormat(firstLine: string): "claude" | "pi" {
  const obj = JSON.parse(firstLine);
  // Pi sessions start with type: "session" with version/id/cwd
  if (obj.type === "session" && obj.cwd) return "pi";
  return "claude";
}

function parsePiSessionJsonl(lines: string[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of lines) {
    const obj = JSON.parse(line);
    if (obj.type !== "message") continue;

    const msg = obj.message || obj;
    const role = msg.role as string;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;

    const content = msg.content;
    const blocks: MessageBlock[] = [];
    let rawText: string | undefined;

    if (typeof content === "string") {
      rawText = content;
      blocks.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        switch (item.type) {
          case "text":
            blocks.push({ type: "text", text: item.text });
            break;
          case "thinking":
            blocks.push({ type: "thinking", thinking: item.thinking || item.text || "" });
            break;
          case "toolCall":
            blocks.push({
              type: "tool_use",
              id: item.id,
              name: item.name,
              input: item.arguments || item.input || {},
            });
            break;
          case "tool_use":
            blocks.push({
              type: "tool_use",
              id: item.id,
              name: item.name,
              input: item.input || {},
            });
            break;
          case "tool_result":
            blocks.push({
              type: "tool_result",
              tool_use_id: item.tool_use_id,
              content: item.content,
              is_error: item.is_error,
            });
            break;
        }
      }
    }

    // Map toolResult to user with tool_result blocks so they get filtered like Claude Code
    if (role === "toolResult") {
      const resultBlocks: MessageBlock[] = blocks.map((b) => {
        if (b.type === "text") {
          return { type: "tool_result" as const, tool_use_id: obj.parentId ?? "", content: b.text, is_error: false };
        }
        return b;
      });
      messages.push({
        uuid: obj.id,
        parentUuid: obj.parentId ?? null,
        timestamp: obj.timestamp,
        role: "user",
        msgType: "user",
        blocks: resultBlocks,
        rawText,
        usage: undefined,
        model: undefined,
      });
      continue;
    }
    // Map Pi's usage format to Claude Code's format
    const piUsage = msg.usage;
    const mappedUsage = piUsage ? {
      input_tokens: piUsage.input ?? piUsage.input_tokens ?? 0,
      output_tokens: piUsage.output ?? piUsage.output_tokens ?? 0,
      cache_read_input_tokens: piUsage.cacheRead ?? piUsage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: piUsage.cacheWrite ?? piUsage.cache_creation_input_tokens ?? 0,
    } : undefined;

    messages.push({
      uuid: obj.id,
      parentUuid: obj.parentId ?? null,
      timestamp: obj.timestamp,
      role: role as "user" | "assistant",
      msgType: role,
      blocks,
      rawText,
      usage: mappedUsage,
      model: msg.model,
    });
  }

  return messages;
}

// Historical transcript cost estimate; the Run's recorded metrics take precedence.
const PRICE_INPUT = 15;
const PRICE_OUTPUT = 75;
const PRICE_CACHE_READ = 1.5;
const PRICE_CACHE_CREATE = 18.75;

export function computeStats(messages: ParsedMessage[], reportedUsage: unknown = null): SessionStats {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  const toolBreakdown: Record<string, number> = {};
  let skillInjections = 0;
  const injectedSkills: string[] = [];
  let mcpCalls = 0;
  const mcpMethods: string[] = [];
  let taskNotifications = 0;
  let model: string | null = null;
  let firstTimestamp = "";
  let lastTimestamp = "";
  const tokens = summarizeSessionTokens(messages, reportedUsage);

  for (const m of messages) {
    if (m.timestamp) {
      if (!firstTimestamp) firstTimestamp = m.timestamp;
      lastTimestamp = m.timestamp;
    }

    if (m.role === "user" && m.msgType === "user") {
      // Skip tool_result blocks — not "real" user messages
      const hasToolResult = m.blocks.some((b) => b.type === "tool_result");
      if (!hasToolResult) {
        const textBlocks = m.blocks.filter((b) => b.type === "text") as { type: "text"; text: string }[];
        if (textBlocks.length > 0 || m.rawText) {
          userMessages++;
          const text = m.rawText ?? textBlocks.map((b) => b.text).join("");
          if (text.startsWith("Base directory for this skill:")) {
            skillInjections++;
            const skillMatch = text.match(/skills\/(together-[a-z-]+)/);
            if (skillMatch && !injectedSkills.includes(skillMatch[1])) injectedSkills.push(skillMatch[1]);
          } else if (text.includes("<task-notification>")) {
            taskNotifications++;
          }
        }
      }
    } else if (m.role === "assistant") {
      if (!model && m.model) model = m.model;
      assistantMessages++;
      for (const block of m.blocks) {
        if (block.type === "tool_use") {
          toolCalls++;
          toolBreakdown[block.name] = (toolBreakdown[block.name] || 0) + 1;
          if (block.name.startsWith("mcp__")) {
            mcpCalls++;
            if (!mcpMethods.includes(block.name)) mcpMethods.push(block.name);
          }
        }
      }
    }
  }

  const costUsd =
    (tokens.input * PRICE_INPUT +
      tokens.output * PRICE_OUTPUT +
      tokens.cacheRead * PRICE_CACHE_READ +
      tokens.cacheCreate * PRICE_CACHE_CREATE) /
    1_000_000;

  const durationSec =
    firstTimestamp && lastTimestamp
      ? Math.round(
          (new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()) / 1000
        )
      : 0;

  // Count AskUserQuestion as interactions
  const interactions = toolBreakdown["AskUserQuestion"] || 0;

  const effectiveUserMessages = userMessages - skillInjections - taskNotifications;

  return {
    durationSec,
    userMessages,
    assistantMessages,
    toolCalls,
    toolBreakdown,
    tokens,
    costUsd,
    firstTimestamp,
    lastTimestamp,
    skillInjections,
    injectedSkills,
    mcpCalls,
    mcpMethods,
    taskNotifications,
    effectiveUserMessages,
    interactions,
    model,
    harnessVersion: null,
  };
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

// Parse a session from raw JSONL string + metadata (for DB-backed detail pages)
export function parseSessionFromJsonl(
  jsonlContent: string,
  meta: {
    id: string;
    version: string;
    run: string;
    task: string;
    agent: string;
    configId: string;
    configLabel: string;
    configFull: string;
    configDir: string;
    result: string | null;
    note: string | null;
    skills: string[] | null;
    taskPrompt?: string | null;
    startedAt?: string | null;
  }
): Session {
  const lines = jsonlContent.trim().split("\n").filter(Boolean);
  // Reuse the existing parser by writing to a temp approach —
  // just inline the parsing logic from parseSessionJsonl
  const format = detectSessionFormat(lines[0]);
  let messages: ParsedMessage[];
  let reportedUsage: unknown = null;
  let reportedCost: number | null = null;
  if (format === "pi") {
    messages = parsePiSessionJsonl(lines);
  } else {
    // Claude format — same parsing as parseSessionJsonl but from string
    messages = [];
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj.type === "result") {
        // Final usage includes completed output counts absent from partial
        // assistant frames. Do not add these totals to per-message snapshots.
        reportedUsage = readSessionTokenUsage(obj.usage) ? obj.usage : null;
        reportedCost = typeof obj.total_cost_usd === "number" && Number.isFinite(obj.total_cost_usd) && obj.total_cost_usd >= 0 ? obj.total_cost_usd : null;
      }
      const msg = obj.message;
      if (!msg) continue;
      const role = msg.role as string;
      if (role !== "user" && role !== "assistant") continue;
      const content = msg.content;
      const blocks: MessageBlock[] = [];
      let rawText: string | undefined;
      if (typeof content === "string") {
        rawText = content;
        blocks.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== "object") continue;
          switch (item.type) {
            case "text":
              blocks.push({ type: "text", text: item.text });
              break;
            case "thinking":
              blocks.push({ type: "thinking", thinking: item.thinking || item.text || "" });
              break;
            case "tool_use":
              blocks.push({ type: "tool_use", id: item.id, name: item.name, input: item.input || {} });
              break;
            case "tool_result":
              blocks.push({ type: "tool_result", tool_use_id: item.tool_use_id, content: typeof item.content === "string" ? item.content : JSON.stringify(item.content) });
              break;
          }
        }
      }
      messages.push({
        uuid: obj.uuid,
        providerMessageId: typeof msg.id === "string" && msg.id ? msg.id : undefined,
        parentUuid: obj.parentUuid ?? null,
        timestamp: obj.timestamp,
        role: role as "user" | "assistant",
        msgType: obj.type,
        blocks,
        rawText,
        usage: msg.usage,
        model: msg.model,
      });
    }
  }
  messages = withTaskPromptMessage(messages, {
    prompt: meta.taskPrompt,
    timestamp: messages[0]?.timestamp ?? meta.startedAt ?? "",
  }) as ParsedMessage[];
  const stats = computeStats(messages, reportedUsage);
  if (reportedCost !== null) stats.costUsd = reportedCost;

  const outcome = {
    passed: meta.result === "pass" ? true : meta.result === "fail" ? false : null,
    notes: meta.note || undefined,
    skills: meta.skills || undefined,
  };

  // Extract prompt
  let prompt: string | undefined;
  for (const m of messages) {
    if (m.role === "user" && m.msgType === "user") {
      const hasToolResult = m.blocks.some((b) => b.type === "tool_result");
      if (hasToolResult) continue;
      const text = m.rawText ?? m.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      if (text.startsWith("Base directory for this skill:")) continue;
      if (text.includes("<system-reminder>")) continue;
      if (text.includes("<task-notification>")) continue;
      if (text.trim()) { prompt = text.trim(); break; }
    }
  }

  return {
    id: meta.id,
    version: meta.version as "v1" | "v2",
    run: meta.run,
    agent: meta.agent as "CC" | "Pi",
    configId: meta.configId as "C1" | "C2" | "C3" | "C4" | "C5",
    configLabel: meta.configLabel,
    configFull: meta.configFull,
    task: meta.task,
    dirName: meta.configDir,
    dirPath: "",
    messages,
    stats,
    prompt,
    outcome,
  };
}
