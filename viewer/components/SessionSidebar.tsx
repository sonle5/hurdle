"use client";

import { useState } from "react";
import type { ParsedMessage } from "@/lib/sessions";
import Link from "next/link";
import { Activity, User, Bot, Terminal, FileText, Pencil, Search, Globe, Zap, ListChecks, CheckCircle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { TogetherCredit } from "@/components/shell/TogetherCredit";

const toolIcons: Record<string, typeof Terminal> = {
  Bash: Terminal,
  Read: FileText,
  Write: FileText,
  Edit: Pencil,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  Skill: Sparkles,
  Agent: Bot,
  TaskCreate: ListChecks,
  TaskUpdate: CheckCircle,
  ToolSearch: Search,
};

export function SessionSidebar({ messages }: { messages: ParsedMessage[] }) {
  const [filter, setFilter] = useState<"default" | "no-tools" | "user" | "all">("default");
  const filtered = messages.filter((m) => {
    if (m.role === "user" && m.msgType === "user") {
      if (m.blocks.some((b) => b.type === "tool_result")) return false;
      const text = m.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      if (text.includes("<system-reminder>") && !text.includes("<task-notification>")) return false;
    }
    if (filter === "user") return m.role === "user" && m.msgType === "user";
    if (filter === "no-tools") {
      if (m.role === "assistant") {
        return m.blocks.some((b) => b.type === "text" && b.text.trim());
      }
      return m.role === "user";
    }
    return true;
  });

  return (
    <div className="hidden h-full w-full min-w-0 flex-col bg-sidebar lg:flex">
      {/* Brand */}
      <div className="px-4 h-12 border-b border-rule flex items-center flex-shrink-0">
        <Link href="/" className="inline-flex items-center gap-1.5 font-mono text-sm font-semibold text-foreground">
          <Activity className="h-3.5 w-3.5 text-fg-muted" strokeWidth={2.25} />
          tae
        </Link>
      </div>
      {/* Filters */}
      <div className="px-3 py-2.5 border-b border-rule flex gap-1 flex-shrink-0">
        {(["default", "no-tools", "user", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={cn(
              "px-2.5 py-1.5 text-xs rounded-md border transition-colors",
              filter === f
                ? "bg-background border-foreground/40 text-foreground font-medium"
                : "border-transparent text-fg-muted hover:text-foreground hover:bg-foreground/5",
            )}
          >
            {f === "default" ? "Default" : f === "no-tools" ? "No-tools" : f === "user" ? "User" : "All"}
          </button>
        ))}
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {filtered.map((m, i) => (
          <SidebarEntry key={m.uuid ?? i} message={m} index={i} />
        ))}
        <div className="text-fg-faint mt-3 mb-2 text-center text-xs tabular-nums">
          {filtered.length} / {messages.length} entries
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-rule px-4 py-3">
        <TogetherCredit />
        <ThemeToggle />
      </div>
    </div>
  );
}

function SidebarEntry({ message, index }: { message: ParsedMessage; index: number }) {
  const isUser = message.role === "user";

  const scrollTo = () => {
    const id = `msg-${message.uuid ?? index}`;
    window.dispatchEvent(new CustomEvent("session-detail-tab", { detail: "transcript" }));
    window.history.replaceState(null, "", `#${id}`);
    let frames = 0;
    const scroll = () => {
      const target = document.getElementById(id);
      if (target) {
        target.scrollIntoView({ behavior: "instant", block: "start" });
        return;
      }
      if (frames++ < 10) requestAnimationFrame(scroll);
    };
    requestAnimationFrame(scroll);
  };

  const textBlocks = message.blocks.filter(
    (b) => b.type === "text" && b.text.trim()
  ) as { type: "text"; text: string }[];

  const toolBlocks = message.blocks.filter(
    (b) => b.type === "tool_use"
  ) as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }[];

  const firstText = textBlocks[0]?.text.trim() ?? "";
  const truncatedText = firstText.length > 60 ? firstText.slice(0, 60) + "…" : firstText;
  const isSkill = isUser && firstText.startsWith("Base directory for this skill:");
  const isTaskNotif = isUser && firstText.includes("<task-notification>");

  const RoleIcon = isTaskNotif ? CheckCircle : isSkill ? Sparkles : isUser ? User : Bot;

  return (
    <div className="px-1.5" onClick={scrollTo}>
      {/* User/Assistant label + text */}
      {(isUser || firstText) && (
        <div className="flex items-center gap-1.5 px-2 py-1 min-h-[40px] rounded-md cursor-pointer hover:bg-foreground/5">
          <RoleIcon className={cn("h-3.5 w-3.5 flex-shrink-0",
            isTaskNotif ? "text-fg-faint" :
            isSkill    ? "text-warn" :
            isUser     ? "text-info" :
                          "text-fg-muted",
          )} />
          <span className={cn("text-xs truncate",
            isTaskNotif ? "text-fg-faint" :
            isSkill    ? "text-warn font-medium" :
            isUser     ? "text-info font-medium" :
                          "text-foreground/80",
          )}>
            {isTaskNotif ? "system:" : isSkill ? "skill:" : isUser ? "user:" : "assistant:"}{" "}
            <span className="text-fg-muted font-normal">{truncatedText}</span>
          </span>
        </div>
      )}

      {/* Tool calls — always visible, indented */}
      {toolBlocks.map((block) => {
        let Icon = toolIcons[block.name] ?? Zap;
        let label = block.name.toLowerCase();
        let summary = "";
        let isSkillRead = false;
        if (block.name === "Bash") {
          const cmd = String(block.input.command ?? "");
          // Codex consults skills by shell-reading .agents/skills/together-<name>/…
          // (no on-stream "Skill" tool). Surface those as skill entries so the
          // left panel reaches parity with Claude Code's skill injections.
          const skillMatch = cmd.match(/\.agents\/skills\/(together-[a-z0-9-]+)/);
          if (skillMatch) {
            isSkillRead = true;
            Icon = Sparkles;
            label = "skill";
            summary = skillMatch[1];
          } else {
            summary = cmd.length > 40 ? cmd.slice(0, 40) + "…" : cmd;
          }
        } else if (["Read", "Write", "Edit", "Glob", "Grep"].includes(block.name)) {
          const p = String(block.input.file_path ?? block.input.path ?? block.input.pattern ?? "");
          const parts = p.split("/");
          summary = parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
        } else if (block.name === "Skill") {
          summary = String(block.input.skill ?? "");
        }

        return (
          <div
            key={block.id}
            className={cn(
              "flex items-center gap-1.5 pl-7 pr-2 py-0.5 rounded-md cursor-pointer hover:bg-foreground/5 text-xs",
              isSkillRead ? "text-warn" : "text-fg-muted",
            )}
          >
            <Icon className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{label}{summary && `: ${summary}`}</span>
          </div>
        );
      })}
    </div>
  );
}
