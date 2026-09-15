"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn, formatModel } from "@/lib/utils";
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
  totalTokensIn: number;
  costUsd: number;
  corrections: number;
  createdAt?: string;
  needsFollowup?: boolean;
  manualOverride?: { reason?: string | null } | null;
  docsCandidateCount?: number;
  docsCandidateStatuses?: string[];
};

function fmtDuration(sec: number) {
  if (sec <= 0) return "—";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function fmtTokens(n: number) {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
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
        "group flex items-center gap-3 border-b border-rule last:border-b-0 hover:bg-foreground/[0.02] transition-colors",
        "focus-visible:outline-none focus-visible:bg-foreground/[0.04]",
        density === "compact" ? "px-3 py-1.5" : "px-4 py-2.5",
        className,
      )}
    >
      <StatusDot kind={kind} />

      <div className="min-w-0 flex-1 flex items-baseline gap-2">
        {showTask && (
          <span className="text-[12px] font-medium text-foreground truncate">{s.task}</span>
        )}
        <span className="text-[11px] text-fg-faint truncate">
          {s.configLabel}
          {s.run ? ` · ${s.run.replace("run", "run ")}` : ""}
        </span>
      </div>

      <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-fg-muted">
        <AgentLogo agent={s.agent} className="h-3 w-3" />
        <span className="hidden md:inline">{s.agentLabel ?? s.agent}</span>
        {formatModel(s.model, s.modelResolved) && (
          <span className="hidden md:inline text-fg-faint">· {formatModel(s.model, s.modelResolved)}</span>
        )}
      </span>

      <div className="flex items-center gap-3 text-[11px] tabular-nums text-fg-muted">
        <span className="w-14 text-right">
          {isRunning && s.createdAt ? <ElapsedTimer startedAt={s.createdAt} /> : fmtDuration(s.durationSec)}
        </span>
        <span className="w-12 text-right hidden md:inline">{fmtTokens(s.totalTokensIn)}</span>
        <span className="w-14 text-right">{s.costUsd > 0 ? `$${s.costUsd.toFixed(2)}` : "—"}</span>
      </div>

      {s.needsFollowup && <StatusBadge kind="followup" size="sm" label="followup" />}
    </Link>
  );
}
