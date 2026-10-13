"use client";

import { useState } from "react";
import type { ParsedMessage } from "@/lib/sessions";
import { User, Bot, Terminal, FileText, Pencil, Search, Globe, Zap, ListChecks, CheckCircle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { SidebarFooter } from "@/components/shell/SidebarFooter";
import { SidebarToggle } from "@/components/shell/ResizableSidebarShell";
import { Brand } from "@/components/shell/Brand";

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

export function SessionSidebar({ messages, collapsed, onCollapsedChange }: {
  messages: ParsedMessage[];
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
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

  if (collapsed) {
    return (
      <div className="hidden h-full w-full flex-col items-center gap-1 bg-sidebar lg:flex">
        <div className="mt-2 flex h-12 w-full shrink-0 items-center justify-center">
          <Brand collapsed />
        </div>
        <SidebarToggle collapsed={collapsed} onCollapsedChange={onCollapsedChange} />
      </div>
    );
  }

  return (
    <div className="hidden h-full w-full min-w-0 flex-col bg-sidebar lg:flex">
      {/* Brand — same row and alignment as the app rail. */}
      <div className="mt-2 flex h-12 flex-shrink-0 items-center justify-between pl-5 pr-3">
        <Brand />
        <SidebarToggle collapsed={collapsed} onCollapsedChange={onCollapsedChange} />
      </div>
      {/* Filters — one segmented control; the chosen view is a raised segment. */}
      <div className="flex-shrink-0 px-3 pb-2 pt-1">
        <div className="flex rounded-lg bg-sidebar-accent p-0.5">
          {(["default", "no-tools", "user", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={cn(
                "h-6 flex-auto whitespace-nowrap rounded-md px-2 text-xs transition-colors",
                filter === f
                  ? "bg-background font-medium text-foreground shadow-xs ring-1 ring-rule"
                  : "text-fg-muted hover:text-foreground",
              )}
            >
              {f === "default" ? "Default" : f === "no-tools" ? "No-tools" : f === "user" ? "User" : "All"}
            </button>
          ))}
        </div>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto pt-1.5 pb-4 [mask-image:linear-gradient(to_bottom,transparent,#000_12px,#000_calc(100%_-_16px),transparent)]">
        {filtered.map((m, i) => (
          <SidebarEntry key={m.uuid ?? i} message={m} index={i} />
        ))}
        <div className="text-fg-faint mt-3 mb-2 text-center text-xs tabular-nums">
          {filtered.length} / {messages.length} entries
        </div>
      </div>

      <SidebarFooter />
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
    <div className="px-3" onClick={scrollTo}>
      {/* User/Assistant label + text */}
      {(isUser || firstText) && (
        <div className="flex items-center gap-1.5 px-2 py-1 min-h-[40px] rounded-md cursor-pointer hover:bg-sidebar-accent">
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
              "flex items-center gap-1.5 pl-7 pr-2 py-0.5 rounded-md cursor-pointer hover:bg-sidebar-accent text-xs",
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
