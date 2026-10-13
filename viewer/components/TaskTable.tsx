"use client";

import { RunCost } from "@/components/RunCost";
import { AgentTokens } from "@/components/TokensDisplay";
import { useState, useEffect } from "react";
import Link from "next/link";
import { ChevronRight, ArrowUp, ArrowDown } from "lucide-react";
import { AgentLogo } from "@/components/AgentLogo";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge, statusFromResult } from "@/components/ui/StatusBadge";
import { cn, formatDuration, formatModel } from "@/lib/utils";


const agentLabel = (a: string) =>
  a === "Pi" ? "Pi" : a === "CDX" ? "Codex" : a === "OC" ? "OpenCode" : "Claude Code";

type SessionRow = {
  id: string;
  run?: string;
  agent: "CC" | "Pi" | "CDX" | "OC";
  model?: string;
  modelResolved?: string | null;
  configId: string;
  configLabel: string;
  task: string;
  durationSec: number;
  interactions: number;
  passed: boolean | null;
  result?: string | null;
  createdAt?: string;
  toolCalls: number | null;
  totalTokens: number | null;
  tokenUsage: import("@/lib/session-usage.mjs").TokenUsage | null;
  costUsd: number | null;
  costSource?: "reported" | "estimated" | "unavailable";
  needsFollowup?: boolean;
  followupReason?: string | null;
  failureAnalysis?: unknown;
  failureReview?: unknown;
  manualOverride?: { reason?: string | null } | null;
};

type SortKey =
  | "configId" | "agent" | "passed" | "durationSec"
  | "toolCalls" | "totalTokens" | "costUsd";

const columns: { key: SortKey; label: string; thClassName?: string; cellClassName?: string; hideOnMobile?: boolean; align?: "left" | "right" }[] = [
  { key: "configId",       label: "Config",      thClassName: "w-44 pl-5", cellClassName: "pl-5" },
  { key: "agent",          label: "Harness",     thClassName: "w-40",      cellClassName: "w-40" },
  { key: "passed",         label: "Result",      thClassName: "w-28",      cellClassName: "w-28" },
  { key: "durationSec",    label: "Time",        align: "right",           thClassName: "w-24", cellClassName: "w-24" },
  { key: "toolCalls",      label: "Tool calls",  hideOnMobile: true, align: "right", thClassName: "w-24", cellClassName: "w-24" },
  { key: "totalTokens",    label: "Agent tokens", hideOnMobile: true, align: "right", thClassName: "w-28", cellClassName: "w-28" },
  { key: "costUsd",        label: "Agent cost",  align: "right",           thClassName: "w-24", cellClassName: "w-24" },
];

export function TaskTable({ sessions }: { sessions: SessionRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("durationSec");
  const [sortAsc, setSortAsc] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const INITIAL_ROWS = 5;

  const sorted = [...sessions].sort((a, b) => {
    if (sortKey === "passed") {
      const av = a.passed === true ? 0 : a.passed === false ? 1 : 2;
      const bv = b.passed === true ? 0 : b.passed === false ? 1 : 2;
      return sortAsc ? av - bv : bv - av;
    }
    const av = a[sortKey] ?? Infinity;
    const bv = b[sortKey] ?? Infinity;
    if (av < bv) return sortAsc ? -1 : 1;
    if (av > bv) return sortAsc ? 1 : -1;
    if (a.durationSec !== b.durationSec) return a.durationSec - b.durationSec;
    return (a.costUsd ?? Infinity) - (b.costUsd ?? Infinity);
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(true); }
  };

  const hide = "hidden md:table-cell";

  return (
    <div className="rounded-lg overflow-hidden border border-rule bg-background">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((col) => (
              <TableHead
                key={col.key}
                className={cn(
                  "cursor-pointer select-none text-[12px] font-medium text-fg-muted hover:text-foreground",
                  col.align === "right" && "text-right",
                  col.thClassName,
                  col.hideOnMobile && hide,
                )}
                onClick={() => toggleSort(col.key)}
              >
                <span className={cn("inline-flex items-center gap-1", col.align === "right" && "justify-end")}>
                  {col.label}
                  {sortKey === col.key && (sortAsc ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                </span>
              </TableHead>
            ))}
            <TableHead className="w-8" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {(showAll ? sorted : sorted.slice(0, INITIAL_ROWS)).map((s) => {
            return (
            <TableRow
              key={s.id}
              className="cursor-pointer hover:bg-surface transition-colors border-rule"
              onClick={() => (window.location.href = `/s/${s.id}`)}
            >
              <TableCell className="pl-5 py-3 w-44">
                <div className="font-medium text-foreground">{s.configId}</div>
                <div className="text-[11px] text-fg-muted mt-0.5">{s.configLabel}</div>
              </TableCell>
              <TableCell className="text-xs text-fg-muted py-3 w-40">
                <span className="inline-flex items-center gap-1.5">
                  <AgentLogo agent={s.agent} className="h-3 w-3" />
                  {agentLabel(s.agent)}
                </span>
                {formatModel(s.model, s.modelResolved) && (
                  <div className="text-[11px] text-fg-faint mt-0.5">{formatModel(s.model, s.modelResolved)}</div>
                )}
              </TableCell>
              <TableCell className="py-3 w-28">
                <div className="flex items-center gap-1.5">
                  <StatusBadge kind={statusFromResult(s.result, s.passed)} />
                  {s.needsFollowup && (
                    <span
                      title={s.followupReason || "needs followup"}
                      className="text-[11px] px-1.5 py-0.5 rounded-sm border border-warn/30 bg-warn-faint text-warn"
                    >
                      ↻ followup
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums text-fg-muted py-3 w-24">
                {s.result === "running" && s.createdAt ? <ElapsedTimer startedAt={s.createdAt} /> : formatDuration(s.durationSec)}
              </TableCell>
              <TableCell className={cn("text-right tabular-nums text-fg-muted py-3 w-24", hide)}>
                {s.toolCalls ?? "—"}
              </TableCell>
              <TableCell className={cn("text-right tabular-nums text-fg-muted py-3 w-24", hide)}>
                <AgentTokens total={s.totalTokens} usage={s.tokenUsage} />
              </TableCell>
              <TableCell className="text-right tabular-nums text-fg-muted py-3 w-24">
                <RunCost value={s.costUsd} source={s.costSource} />
              </TableCell>
              <TableCell className="py-3 w-8">
                <Link href={`/s/${s.id}`} className="text-fg-faint hover:text-foreground transition-colors">
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {sorted.length > INITIAL_ROWS && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="w-full py-2.5 text-[12px] text-fg-muted hover:text-foreground hover:bg-surface border-t border-rule transition-colors"
        >
          {showAll ? "Show less" : `Show all ${sorted.length} runs`}
        </button>
      )}
    </div>
  );
}

function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)));
  useEffect(() => {
    const i = setInterval(
      () => setElapsed(Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))),
      1000,
    );
    return () => clearInterval(i);
  }, [startedAt]);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return (
    <span className="text-info tabular-nums">
      {m}:{s.toString().padStart(2, "0")}
    </span>
  );
}
