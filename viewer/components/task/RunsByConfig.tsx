"use client";

import { RunRow, type RunRowData } from "@/components/leaderboard/RunRow";
import { ExportMenu, type ExportFormat } from "@/components/ui/ExportMenu";

/**
 * Task-view runs list. Despite the name we no longer render per-config
 * section headers — runs are emitted in a single flat list (config already
 * shows on each row, e.g. "Baseline · run 1"). The "groups" prop is kept
 * because the export still serializes by config.
 */
export function RunsByConfig({
  groups,
  taskSlug,
}: {
  groups: { configId: string; configLabel: string; runs: RunRowData[] }[];
  taskSlug?: string;
}) {
  if (groups.length === 0) return null;

  const allRuns = groups.flatMap((g) => g.runs);

  const handleExport = (fmt: ExportFormat): { mime: string; content: string } => {
    if (fmt === "json") {
      return {
        mime: "application/json",
        content: JSON.stringify(
          groups.map((g) => ({
            config: g.configId,
            configLabel: g.configLabel,
            runs: g.runs,
          })),
          null,
          2,
        ),
      };
    }
    const headers = ["task", "config", "configLabel", "agent", "run", "result", "passed", "duration_sec", "tool_calls", "tokens_in", "cost_usd", "corrections", "needs_followup", "session_id"];
    const esc = (v: string | number | boolean | null | undefined) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [headers.join(",")];
    for (const r of allRuns) {
      rows.push([
        r.task,
        r.configId,
        r.configLabel,
        r.agentLabel ?? r.agent,
        r.run ?? "",
        r.result ?? "",
        r.passed === true ? "true" : r.passed === false ? "false" : "",
        r.durationSec,
        r.toolCalls ?? "",
        r.totalTokensIn,
        r.costUsd.toFixed(4),
        r.corrections,
        r.needsFollowup ? "true" : "false",
        r.id,
      ].map(esc).join(","));
    }
    return { mime: "text/csv;charset=utf-8", content: rows.join("\n") };
  };

  return (
    <section className="rounded-lg border border-rule bg-background overflow-hidden">
      <header className="px-5 py-3 border-b border-rule flex items-center justify-between">
        <div>
          <h2 className="text-[13px] font-semibold text-foreground">Runs</h2>
          <p className="text-[11px] text-fg-faint mt-0.5">Click any row to open the session and audit detail.</p>
        </div>
        <ExportMenu filenameBase={taskSlug ? `${taskSlug}-runs` : "task-runs"} onExport={handleExport} />
      </header>
      <div>
        {allRuns.map((r) => <RunRow key={r.id} s={r} showTask={false} />)}
      </div>
    </section>
  );
}
