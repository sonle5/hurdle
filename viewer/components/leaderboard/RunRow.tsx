"use client";

import { RunCost } from "@/components/RunCost";
import { AgentTokens } from "@/components/TokensDisplay";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cn, formatDuration, formatModel } from "@/lib/utils";
import { AgentLogo } from "@/components/AgentLogo";
import { StatusDot, statusFromResult, StatusBadge } from "@/components/ui/StatusBadge";

export type RunRowData = {
  id: string;
  agent: "CC" | "Pi" | "CDX" | "OC";
  agentLabel?: string;
  model?: string;
  modelResolved?: string | null;
  configId: string;
  configLabel: string;
  task: string;
  run?: string;
  result: string | null;
  passed: boolean | null;
  durationSec: number;
  toolCalls: number | null;
  totalTokens: number | null;
  tokenUsage: import("@/lib/session-usage.mjs").TokenUsage | null;
  costUsd: number | null;
  costSource?: "reported" | "estimated" | "unavailable";
  createdAt?: string;
  needsFollowup?: boolean;
  manualOverride?: { reason?: string | null } | null;
  docsCandidateCount?: number;
  docsCandidateStatuses?: string[];
};

function fmtDuration(sec: number) {
  return sec > 0 ? formatDuration(sec) : "—";
}

function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)),
  );
  useEffect(() => {
    const t = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return <span className="tabular-nums text-info">{m}:{s.toString().padStart(2, "0")}</span>;
}

export function RunRow({ s, showTask = true, density = "comfortable", className }: {
  s: RunRowData;
  showTask?: boolean;
  density?: "comfortable" | "compact";
  className?: string;
}) {
  const kind = statusFromResult(s.result, s.passed);
  const isRunning = kind === "running";

  return (
    <Link
      data-row-focus
      href={`/s/${s.id}`}
      className={cn(
        "group flex items-center gap-3 border-b border-rule last:border-b-0 hover:bg-foreground/[0.03] transition-colors",
        "focus-visible:outline-none focus-visible:bg-foreground/[0.04]",
        density === "compact" ? "px-3 py-1.5" : "px-5 py-2.5",
        className,
      )}
    >
      <StatusDot kind={kind} />

      <div className="min-w-0 flex-1 flex items-baseline gap-2">
        {showTask && (
          <span className="text-[13px] font-medium text-foreground truncate">{s.task}</span>
        )}
        <span className={cn("truncate", showTask ? "text-[12px] text-fg-faint" : "text-[13px] text-foreground")}>
          {s.configLabel}
          {s.run ? ` · ${s.run.replace("run", "run ")}` : ""}
        </span>
      </div>

      <span className="hidden sm:inline-flex items-center gap-1.5 text-[12px] text-fg-muted">
        <AgentLogo agent={s.agent} className="h-3 w-3" />
        <span className="hidden md:inline">{s.agentLabel ?? s.agent}</span>
        {formatModel(s.model, s.modelResolved) && (
          <span className="hidden md:inline text-fg-faint">· {formatModel(s.model, s.modelResolved)}</span>
        )}
      </span>

      <div className="flex items-center gap-3 text-[12px] tabular-nums text-fg-muted">
        <span className="w-14 text-right">
          {isRunning && s.createdAt ? <ElapsedTimer startedAt={s.createdAt} /> : fmtDuration(s.durationSec)}
        </span>
        <span className="w-12 text-right hidden md:inline"><AgentTokens total={s.totalTokens} usage={s.tokenUsage} /></span>
        <span className="w-14 text-right"><RunCost value={s.costUsd} source={s.costSource} /></span>
      </div>

      {s.needsFollowup && <StatusBadge kind="followup" size="sm" label="followup" />}
    </Link>
  );
}
