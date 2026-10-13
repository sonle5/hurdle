"use client";

import { useState } from "react";
import type { ParsedMessage, MessageBlock } from "@/lib/sessions";
import { CodeBlock } from "@/components/CodeBlock";
import { Markdown } from "@/components/Markdown";

const TRUNCATE_CHARS = 800;

export function ConversationView({ messages }: { messages: ParsedMessage[] }) {
  const flow = messages.filter((m) => {
    if (m.role === "user" && m.msgType === "user") {
      if (m.blocks.some((b) => b.type === "tool_result")) return false;
      const text = m.rawText ?? m.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      if (text.includes("<system-reminder>") && !text.includes("<task-notification>")) return false;
    }
    return true;
  });

  // Build tool_result lookup
  const toolResults = new Map<string, unknown>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === "tool_result") {
        toolResults.set(b.tool_use_id, b);
      }
    }
  }

  return (
    <div className="space-y-10">
      {flow.map((m, i) => {
        const texts = m.blocks
          .filter((b): b is { type: "text"; text: string } => b.type === "text" && !!b.text.trim())
          .map((b) => b.text.trim());
        const tools = m.blocks
          .filter((b): b is MessageBlock & { type: "tool_use" } => b.type === "tool_use");
        const thinking = m.blocks
          .filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking" && !!b.thinking?.trim());

        if (!texts.length && !tools.length && !thinking.length) return null;

        const ts = m.timestamp
          ? new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
          : "";

        const isUser = m.role === "user";
        const allText = texts.join("");
        const isSkill = isUser && allText.startsWith("Base directory for this skill:");
        const isTaskNotif = isUser && allText.includes("<task-notification>");

        // Differentiated role labels: User = filled (most prominent — drives the
        // conversation), Skill = outlined, Assistant = plain text, System
        // = faint. Color stays monochrome; the *shape* of the label conveys
        // role.
        const kind: "user" | "assistant" | "skill" | "system" =
          isTaskNotif ? "system" : isSkill ? "skill" : isUser ? "user" : "assistant";
        const roleLabel = kind === "system" ? "System" : kind === "skill" ? "Skill" : kind === "user" ? "User" : "Assistant";
        const roleLabelClass = (
          kind === "user"      ? "bg-foreground text-background px-1.5 py-0.5 rounded-sm"
          : kind === "skill"   ? "border border-foreground/40 text-foreground px-1.5 py-0.5 rounded-sm"
          : kind === "system"  ? "text-fg-faint"
          : /* assistant */      "text-foreground"
        );

        // No borders or background tints on message blocks — separation comes
        // from whitespace (parent space-y-10) and the role label.

        return (
          <div
            key={m.uuid ?? i}
            id={`msg-${m.uuid ?? i}`}
            className="relative scroll-mt-4 group/msg"
          >
            {/* Anchor link — sits in the parent's left padding, hover-only. */}
            <a
              href={`#msg-${m.uuid ?? i}`}
              onClick={(e) => {
                e.preventDefault();
                const id = `msg-${m.uuid ?? i}`;
                window.history.replaceState(null, "", `#${id}`);
                document.getElementById(id)?.scrollIntoView({ behavior: "instant", block: "start" });
              }}
              aria-label="Anchor to this message"
              className="absolute -left-5 top-2 inline-flex -translate-y-1/2 items-center text-[11px] leading-none text-fg-faint/0 group-hover/msg:text-fg-faint hover:!text-fg-muted select-none transition-colors"
            >
              #
            </a>

            <div className="mb-3 flex min-h-4 items-center gap-2">
              <span className={`text-[12px] font-semibold leading-none ${roleLabelClass}`}>
                {roleLabel}
              </span>
              <span className="text-[11px] leading-none text-fg-faint tabular-nums">{ts}</span>
            </div>

            {/* Thinking */}
            {thinking.map((t, j) => (
              <TruncatedBlock key={`t-${j}`} content={t.thinking} label="Thinking" className="italic text-muted-foreground" />
            ))}

            {/* Text */}
            {isSkill ? (
              <SkillBlock texts={texts} />
            ) : (
              texts.map((t, j) => {
                if (t.includes("<task-notification>")) {
                  const status = t.match(/<status>(.*?)<\/status>/)?.[1] ?? "";
                  const summary = t.match(/<summary>(.*?)<\/summary>/)?.[1] ?? "";
                  return (
                    <p key={`txt-${j}`} className="text-xs text-muted-foreground bg-muted/30 rounded-md px-3 py-2 font-mono">
                      Task {status}: {summary}
                    </p>
                  );
                }
                return (
                  <div key={`txt-${j}`} className="mb-4 max-w-[75ch] text-sm leading-7 text-foreground/85">
                    <Markdown content={t} />
                  </div>
                );
              })
            )}

            {/* Tools */}
            {tools.map((t) => (
              <ToolBlock
                key={t.id}
                name={t.name}
                input={t.input}
                result={toolResults.get(t.id)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function SkillBlock({ texts }: { texts: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const full = texts.join("\n");
  const skillMatch = full.match(/\/skills\/([\w-]+)/);
  const skillName = skillMatch?.[1] ?? "skill";
  const preview = full.slice(0, 200);

  return (
    <div className="text-[12px] text-fg-muted">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-foreground">{skillName}</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[11px] text-foreground hover:opacity-70 transition-opacity underline-offset-2 underline"
        >
          {expanded ? "collapse" : "expand"}
        </button>
      </div>
      {expanded ? (
        <div className="rounded-md border border-rule bg-surface/40 px-3 py-2 max-h-96 overflow-y-auto">
          <Markdown content={full} />
        </div>
      ) : (
        <p className="truncate">{preview}…</p>
      )}
    </div>
  );
}

function TruncatedBlock({ content, label, className }: { content: string; label: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = content.length > TRUNCATE_CHARS;
  const display = !expanded && needsTruncation ? content.slice(0, TRUNCATE_CHARS) : content;

  return (
    <div className="mb-2 max-w-[75ch]">
      <div className="text-[12px] text-fg-faint mb-1">{label}</div>
      <pre className={`text-[12px] whitespace-pre-wrap leading-relaxed text-fg-muted ${className ?? ""}`}>{display}{!expanded && needsTruncation && "…"}</pre>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[11px] text-foreground hover:opacity-70 transition-opacity underline-offset-2 underline mt-1"
        >
          {expanded ? "Show less" : `Show more (${content.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

// Render tool input as structured key-value pairs instead of raw JSON
function renderToolInput(name: string, input: Record<string, unknown>): { primary: string; label: string; meta: { key: string; value: string }[] } {
  const meta: { key: string; value: string }[] = [];

  if (name === "Bash") {
    const cmd = String(input.command ?? "");
    if (input.description) meta.push({ key: "description", value: String(input.description) });
    if (input.timeout && input.timeout !== 120000) meta.push({ key: "timeout", value: `${input.timeout}ms` });
    return { primary: cmd, label: "$", meta };
  }

  if (name === "Read") {
    return { primary: String(input.file_path ?? ""), label: "file", meta: [
      ...(input.offset ? [{ key: "offset", value: String(input.offset) }] : []),
      ...(input.limit ? [{ key: "limit", value: String(input.limit) }] : []),
    ]};
  }

  if (name === "Write") {
    const content = String(input.content ?? "");
    return { primary: String(input.file_path ?? ""), label: "file", meta: [
      { key: "content", value: content.length > 200 ? content.slice(0, 200) + "…" : content },
    ]};
  }

  if (name === "Edit") {
    return { primary: String(input.file_path ?? ""), label: "file", meta: [
      ...(input.old_string ? [{ key: "old", value: String(input.old_string).slice(0, 150) }] : []),
      ...(input.new_string ? [{ key: "new", value: String(input.new_string).slice(0, 150) }] : []),
      ...(input.replace_all ? [{ key: "replace_all", value: "true" }] : []),
    ]};
  }

  if (name === "Grep") {
    return { primary: String(input.pattern ?? ""), label: "pattern", meta: [
      ...(input.path ? [{ key: "path", value: String(input.path) }] : []),
      ...(input.glob ? [{ key: "glob", value: String(input.glob) }] : []),
      ...(input.output_mode ? [{ key: "mode", value: String(input.output_mode) }] : []),
    ]};
  }

  if (name === "Glob") {
    return { primary: String(input.pattern ?? ""), label: "pattern", meta: [
      ...(input.path ? [{ key: "path", value: String(input.path) }] : []),
    ]};
  }

  if (name === "Skill") {
    return { primary: String(input.skill ?? ""), label: "skill", meta: [
      ...(input.args ? [{ key: "args", value: String(input.args) }] : []),
    ]};
  }

  if (name === "TaskCreate") {
    return { primary: String(input.subject ?? ""), label: "task", meta: [
      ...(input.description ? [{ key: "description", value: String(input.description).slice(0, 150) }] : []),
    ]};
  }

  if (name === "TaskUpdate") {
    return { primary: String(input.taskId ?? ""), label: "task", meta: [
      ...(input.status ? [{ key: "status", value: String(input.status) }] : []),
    ]};
  }

  if (name === "WebFetch") {
    return { primary: String(input.url ?? ""), label: "url", meta: [
      ...(input.prompt ? [{ key: "prompt", value: String(input.prompt).slice(0, 100) }] : []),
    ]};
  }

  if (name === "WebSearch") {
    return { primary: String(input.query ?? ""), label: "query", meta: [] };
  }

  if (name === "ToolSearch") {
    return { primary: String(input.query ?? ""), label: "query", meta: [] };
  }

  // Fallback: show as JSON
  return { primary: JSON.stringify(input, null, 2), label: "input", meta: [] };
}

function getResultText(result: unknown): string | null {
  const resultContent =
    result && typeof result === "object" && "content" in result
      ? (result as { content: unknown }).content
      : null;
  if (typeof resultContent === "string") return resultContent;
  if (Array.isArray(resultContent)) {
    return resultContent
      .map((r) =>
        typeof r === "string" ? r : r && typeof r === "object" && "text" in r ? (r as { text: string }).text : ""
      )
      .join("\n");
  }
  return null;
}

function ToolBlock({
  name,
  input,
  result,
}: {
  name: string;
  input: Record<string, unknown>;
  result: unknown;
}) {
  const [expandedOutput, setExpandedOutput] = useState(false);

  const { primary } = renderToolInput(name, input);
  const resultText = getResultText(result);

  const inputStr = JSON.stringify(input, null, 2);
  const inputJson = inputStr.length > TRUNCATE_CHARS ? inputStr.slice(0, TRUNCATE_CHARS) + "…" : inputStr;

  const outputTruncated = resultText ? resultText.length > TRUNCATE_CHARS : false;
  const displayOutput = resultText
    ? !expandedOutput && outputTruncated ? resultText.slice(0, TRUNCATE_CHARS) : resultText
    : null;

  const summaryText = primary.length > 80 ? primary.slice(0, 80) + "…" : primary;

  // Tool result errors get a red left border. Everything else stays monochrome.
  const isError =
    result != null
    && typeof result === "object"
    && "is_error" in result
    && (result as { is_error?: boolean }).is_error === true;

  return (
    <div className={`mb-3 border-l-2 pl-3 ml-1 ${isError ? "border-fail" : "border-rule"}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-mono font-medium text-foreground rounded-sm bg-foreground/[0.06] px-1.5 py-0.5">
          {name}
        </span>
        <span className="text-[11px] text-fg-muted font-mono truncate">{summaryText}</span>
        {isError && <span className="text-[12px] font-medium text-fail">Error</span>}
      </div>

      {/* Input */}
      <div className="mb-1.5">
        <div className="text-[12px] text-fg-faint mb-0.5">Input</div>
        <CodeBlock code={inputJson} lang="json" />
      </div>

      {/* Output */}
      {displayOutput !== null && (
        <div>
          <div className="text-[12px] text-fg-faint mb-0.5">Output</div>
          <CodeBlock code={displayOutput + (!expandedOutput && outputTruncated ? "…" : "")} />
          {outputTruncated && (
            <button
              onClick={() => setExpandedOutput(!expandedOutput)}
              className="text-[11px] text-foreground hover:opacity-70 transition-opacity underline-offset-2 underline mt-1"
            >
              {expandedOutput ? "Show less" : `Show more (${resultText!.length.toLocaleString()} chars)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
