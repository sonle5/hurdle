"use client";

import { useEffect, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { KpiStrip, tonePassRate, type Kpi } from "./KpiStrip";
import { MatrixTable, type MatrixData, type MatrixCell } from "./MatrixTable";
import { MATRIX_SEARCH_INPUT_ID } from "./MatrixSearch";
import { RecentRuns } from "./RecentRuns";
import { type RunRowData } from "./RunRow";
import { TaskTable } from "@/components/TaskTable";
import { useHotkeys, moveRowFocus } from "@/lib/hotkeys";
import { formatDuration, formatModel } from "@/lib/utils";

type SessionData = {
  id: string;
  version: string;
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
  docsCandidateCount?: number;
  docsCandidateStatuses?: string[];
  note?: string | null;
};

export type TaskGroup = {
  task: string;
  prompt?: string;
  findings?: string;
  sessions: SessionData[];
};

export type LeaderboardComparison = {
  versionId: string;
  versionName: string;
  taskGroups: TaskGroup[];
};

function isCliTask(slug: string): boolean {
  // New prefix style (cli:clusters) and legacy suffix style (clusters-cli).
  return /^cli:|-cli$/.test(slug);
}

function fmtTimeShort(sec: number) {
  return sec > 0 ? formatDuration(sec) : "—";
}

function fmtDurationCompact(sec: number) {
  return formatDuration(sec);
}

function fmtDirectionalTime(sec: number) {
  if (sec === 0) return "flat";
  return `${sec > 0 ? "up" : "down"} ${fmtDurationCompact(sec)}`;
}

function fmtDirectionalCost(cost: number) {
  if (Math.abs(cost) < 0.005) return "flat";
  return `${cost > 0 ? "up" : "down"} $${Math.abs(cost).toFixed(2)}`;
}

function fmtDirectionalPass(points: number) {
  if (points === 0) return "flat";
  return `${points > 0 ? "up" : "down"} ${Math.abs(points)}pp`;
}

function shortVersionLabel(id: string, name: string) {
  const raw = name || id;
  const date = raw.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? id.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return date ?? raw;
}

function isScoredResult(result: string | null | undefined): boolean {
  return result === "pass" || result === "fail" || result === "incomplete";
}

function excludedSub(kpi: { pendingAudit: number; unknown: number; running: number }): string | undefined {
  const parts = [];
  if (kpi.pendingAudit > 0) parts.push(`${kpi.pendingAudit} pending audit`);
  if (kpi.unknown > 0) parts.push(`${kpi.unknown} unknown`);
  if (kpi.running > 0) parts.push(`${kpi.running} running`);
  return parts.length > 0 ? `${parts.join(", ")} excluded` : undefined;
}

// Aggregate a set of task groups into the (task × config) matrix. Pure so the
// "all models" view can call it once per model without blending across them.
function buildMatrix(groups: TaskGroup[]): MatrixData {
  type Accum = { pass: number; total: number; durTotal: number; costTotal: number; costCount: number; failNotes: Map<string, number> };
  const configSet = new Map<string, string>();
  const taskList: { slug: string; label: string; findings?: string }[] = [];
  const accum = new Map<string, Accum>();
  for (const g of groups) {
    if (!taskList.find((t) => t.slug === g.task)) taskList.push({ slug: g.task, label: g.task, findings: g.findings });
    for (const s of g.sessions) {
      if (!configSet.has(s.configId)) configSet.set(s.configId, s.configLabel);
      if (!isScoredResult(s.result)) continue;
      const key = `${g.task}|${s.configId}`;
      const a = accum.get(key) ?? { pass: 0, total: 0, durTotal: 0, costTotal: 0, costCount: 0, failNotes: new Map<string, number>() };
      a.total += 1;
      a.durTotal += s.durationSec;
      if (s.costUsd !== null) { a.costTotal += s.costUsd; a.costCount++; }
      if (s.passed === true) a.pass += 1;
      if (s.passed === false && s.note && s.note.trim()) {
        const n = s.note.trim();
        a.failNotes.set(n, (a.failNotes.get(n) ?? 0) + 1);
      }
      accum.set(key, a);
    }
  }
  const grid = new Map<string, MatrixCell>();
  for (const [key, a] of accum) {
    const topFails = [...a.failNotes.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([note, count]) => (count > 1 ? `${note} (×${count})` : note));
    grid.set(key, {
      pass: a.pass,
      total: a.total,
      avgDurationSec: a.total ? Math.round(a.durTotal / a.total) : 0,
      avgCostUsd: a.costCount ? a.costTotal / a.costCount : 0,
      costCount: a.costCount,
      topFails: topFails.length > 0 ? topFails : undefined,
    });
  }
  const configs = [...configSet.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { configs, tasks: taskList, grid };
}

// Summary KPIs for a set of task groups. Computed per section so "all models"
// mode shows per-model summaries rather than one blended pass-rate.
function buildKpi(groups: TaskGroup[]) {
  let runs = 0, total = 0, pass = 0, pendingAudit = 0, unknown = 0, running = 0, dur = 0, durCount = 0, cost = 0, costCount = 0;
  for (const g of groups) {
    for (const s of g.sessions) {
      runs++;
      if (s.result === "pending_audit") pendingAudit++;
      if (s.result === "unknown") unknown++;
      if (s.result === "running") running++;
      if (!isScoredResult(s.result)) continue;
      total++;
      if (s.passed === true) pass++;
      if (s.durationSec > 0) { dur += s.durationSec; durCount++; }
      if (s.costUsd !== null && s.costUsd >= 0) { cost += s.costUsd; costCount++; }
    }
  }
  return {
    runs, total, pass, pendingAudit, unknown, running,
    passPct: total > 0 ? Math.round((pass / total) * 100) : 0,
    avgDuration: durCount > 0 ? Math.round(dur / durCount) : 0,
    avgCost: costCount > 0 ? cost / costCount : 0,
  };
}

function sessionKey(s: SessionData) {
  return [s.agent, s.model ?? "", s.configId, s.task, s.run ?? ""].join("\x1f");
}

function promptByTask(groups: TaskGroup[]) {
  return new Map(groups.map((g) => [g.task, g.prompt ?? ""]));
}

function groupsForKeys(groups: TaskGroup[], keys: Set<string>): TaskGroup[] {
  return groups
    .map((g) => ({
      ...g,
      sessions: g.sessions.filter((s) => keys.has(sessionKey(s))),
    }))
    .filter((g) => g.sessions.length > 0);
}

function buildComparisonKpi(currentGroups: TaskGroup[], previousGroups: TaskGroup[]) {
  const previousByKey = new Map<string, SessionData>();
  for (const g of previousGroups) for (const s of g.sessions) previousByKey.set(sessionKey(s), s);

  const currentPrompts = promptByTask(currentGroups);
  const previousPrompts = promptByTask(previousGroups);
  const comparableKeys = new Set<string>();
  const promptChangedKeys = new Set<string>();

  for (const g of currentGroups) {
    for (const s of g.sessions) {
      const key = sessionKey(s);
      if (!previousByKey.has(key)) continue;
      if ((currentPrompts.get(s.task) ?? "") !== (previousPrompts.get(s.task) ?? "")) {
        promptChangedKeys.add(key);
        continue;
      }
      comparableKeys.add(key);
    }
  }

  if (comparableKeys.size === 0) return null;

  return {
    cells: comparableKeys.size,
    promptChangedCells: promptChangedKeys.size,
    current: buildKpi(groupsForKeys(currentGroups, comparableKeys)),
    previous: buildKpi(groupsForKeys(previousGroups, comparableKeys)),
  };
}

function comparisonDeltaItems(comparison: ReturnType<typeof buildComparisonKpi>, versionLabel: string) {
  if (!comparison) return {};
  const passDelta = comparison.current.passPct - comparison.previous.passPct;
  const durationDelta = comparison.current.avgDuration - comparison.previous.avgDuration;
  const costDelta = comparison.current.avgCost - comparison.previous.avgCost;
  const title = `Compared with ${versionLabel} over ${comparison.cells} prompt-identical cells${
    comparison.promptChangedCells > 0 ? `; ${comparison.promptChangedCells} changed-prompt cells excluded` : ""
  }.`;
  return {
    pass: {
      label: `${fmtDirectionalPass(passDelta)} vs ${versionLabel}`,
      tone: passDelta > 0 ? "pass" : passDelta < 0 ? "warn" : "neutral",
      title,
    } satisfies Kpi["delta"],
    duration: comparison.current.avgDuration > 0 && comparison.previous.avgDuration > 0 ? {
      label: `${fmtDirectionalTime(durationDelta)} vs ${versionLabel}`,
      tone: durationDelta < 0 ? "pass" : durationDelta > 0 ? "warn" : "neutral",
      title,
    } satisfies Kpi["delta"] : undefined,
    cost: comparison.current.avgCost > 0 && comparison.previous.avgCost > 0 ? {
      label: `${fmtDirectionalCost(costDelta)} vs ${versionLabel}`,
      tone: costDelta < 0 ? "pass" : costDelta > 0 ? "warn" : "neutral",
      title,
    } satisfies Kpi["delta"] : undefined,
    sub: `vs ${versionLabel} · ${comparison.cells} cells${comparison.promptChangedCells > 0 ? ` · ${comparison.promptChangedCells} prompt-changed excluded` : ""}`,
  };
}

export function Leaderboard({
  taskGroups,
  showRecentRuns,
  comparison,
}: {
  taskGroups: TaskGroup[];
  showRecentRuns?: boolean;
  comparison?: LeaderboardComparison | null;
}) {
  const sp = useSearchParams();
  const router = useRouter();

  // Auto-refresh on running sessions.
  const hasRunning = taskGroups.some((g) => g.sessions.some((s) => s.result === "running"));
  useEffect(() => {
    const id = setInterval(() => router.refresh(), hasRunning ? 5_000 : 30_000);
    return () => clearInterval(id);
  }, [hasRunning, router]);

  // Keyboard navigation:
  //   j/k  → move focus across matrix rows
  //   /    → focus the matrix search input
  //   g l  → go to leaderboard (no-op here, useful as a memorable global)
  useHotkeys({
    "j": (e) => { e.preventDefault(); moveRowFocus("[data-row-focus]", +1); },
    "k": (e) => { e.preventDefault(); moveRowFocus("[data-row-focus]", -1); },
    "/": (e) => { e.preventDefault(); document.getElementById(MATRIX_SEARCH_INPUT_ID)?.focus(); },
    "g l": () => router.push("/"),
  });

  // Read filters from URL (rail writes them there).
  const filter = sp.get("agent") || sp.get("harness") || "all";
  const taskFilter = sp.get("task") || "all";
  const configFilter = sp.get("config") || "all";
  const runFilter = sp.get("run") || "all";
  // Default category follows the data: "general" normally, but "cli" when the
  // version holds ONLY cli tasks — otherwise a cli-only version renders blank on
  // the "general" default, and the rail's category control is hidden, leaving no
  // way to switch — a blank board with no recovery. Explicit ?category= always wins.
  // Mirrors the default in app/page.tsx and the escape hatch in LeftRail.
  const hasGeneralTask = taskGroups.some((g) => !isCliTask(g.task));
  const hasCliTask = taskGroups.some((g) => isCliTask(g.task));
  const categoryFilter = sp.get("category") || (hasGeneralTask || !hasCliTask ? "general" : "cli");

  // "All" is a split view, not an averaged score: every model gets its own KPI
  // and matrix section below. This is the safe default for a shareable bare URL,
  // especially when historical records have an empty (legacy) model label.
  const models = useMemo(() => {
    const set = new Set<string>();
    for (const g of taskGroups) for (const s of g.sessions) set.add(s.model ?? "");
    return [...set].sort();
  }, [taskGroups]);
  // An explicit model query selects one section. Without it, show all sections.
  const modelParam = sp.get("model");
  const modelFilter = modelParam || "all";

  // Apply filters.
  const filtered = useMemo(() => {
    return taskGroups
      .filter((g) => {
        if (taskFilter !== "all" && g.task !== taskFilter) return false;
        if (categoryFilter === "cli" && !isCliTask(g.task)) return false;
        if (categoryFilter === "general" && isCliTask(g.task)) return false;
        return true;
      })
      .map((g) => ({
        ...g,
        sessions: g.sessions.filter((s) => {
          if (runFilter !== "all" && s.run !== runFilter) return false;
          if (configFilter !== "all" && s.configId !== configFilter) return false;
          if (filter !== "all" && s.agent !== filter) return false;
          if (modelFilter !== "all" && (s.model ?? "") !== modelFilter) return false;
          return true;
        }),
      }));
  }, [taskGroups, taskFilter, categoryFilter, runFilter, configFilter, filter, modelFilter]);

  const filteredComparison = useMemo(() => {
    if (!comparison) return [];
    return comparison.taskGroups
      .filter((g) => {
        if (taskFilter !== "all" && g.task !== taskFilter) return false;
        if (categoryFilter === "cli" && !isCliTask(g.task)) return false;
        if (categoryFilter === "general" && isCliTask(g.task)) return false;
        return true;
      })
      .map((g) => ({
        ...g,
        sessions: g.sessions.filter((s) => {
          if (runFilter !== "all" && s.run !== runFilter) return false;
          if (configFilter !== "all" && s.configId !== configFilter) return false;
          if (filter !== "all" && s.agent !== filter) return false;
          if (modelFilter !== "all" && (s.model ?? "") !== modelFilter) return false;
          return true;
        }),
      }));
  }, [comparison, taskFilter, categoryFilter, runFilter, configFilter, filter, modelFilter]);

  // Sections: one by default; in "all models" mode (>1 model present) split into
  // one section per model — each carrying its OWN KPIs + matrix — so neither the
  // summary numbers nor the matrix are ever blended across models. Each section
  // also tracks the resolved version for a specific header (e.g. "Opus 4.7").
  const sections = useMemo(() => {
    const resolvedByAlias = new Map<string, string | null>();
    for (const g of filtered) for (const s of g.sessions) {
      const a = s.model ?? "";
      if (!resolvedByAlias.has(a)) resolvedByAlias.set(a, s.modelResolved ?? null);
    }
    const mk = (groups: TaskGroup[], previousGroups: TaskGroup[], model: string | null) => ({
      model,
      modelResolved: model === null ? null : (resolvedByAlias.get(model) ?? null),
      kpi: buildKpi(groups),
      data: buildMatrix(groups),
      comparisonKpi: comparison ? buildComparisonKpi(groups, previousGroups) : null,
    });
    if (modelFilter !== "all") return [mk(filtered, filteredComparison, null)];
    const present = [...resolvedByAlias.keys()].sort();
    if (present.length <= 1) return [mk(filtered, filteredComparison, null)];
    return present.map((m) => mk(
      filtered.map((g) => ({ ...g, sessions: g.sessions.filter((s) => (s.model ?? "") === m) })),
      filteredComparison.map((g) => ({ ...g, sessions: g.sessions.filter((s) => (s.model ?? "") === m) })),
      m,
    ));
  }, [filtered, filteredComparison, modelFilter, comparison]);

  const recentRuns: RunRowData[] = useMemo(() => {
    if (!showRecentRuns) return [];
    const all: RunRowData[] = [];
    for (const g of filtered) {
      for (const s of g.sessions) {
        all.push({
          id: s.id,
          agent: s.agent,
          model: s.model,
          modelResolved: s.modelResolved,
          configId: s.configId,
          configLabel: s.configLabel,
          task: s.task,
          run: s.run,
          result: s.result ?? null,
          passed: s.passed,
          durationSec: s.durationSec,
          toolCalls: s.toolCalls,
          totalTokens: s.totalTokens,
          tokenUsage: s.tokenUsage,
          costUsd: s.costUsd,
          costSource: s.costSource,
          createdAt: s.createdAt,
          needsFollowup: s.needsFollowup,
          manualOverride: s.manualOverride,
          docsCandidateCount: s.docsCandidateCount,
          docsCandidateStatuses: s.docsCandidateStatuses,
        });
      }
    }
    return all;
  }, [filtered, showRecentRuns]);

  return (
    <div className="space-y-6">
      {/* One section per model in "all models" mode — KPIs + matrix are computed
          per section so summaries are never blended. Findings show on hover of
          each matrix task name. */}
      <div className="flex flex-col gap-8">
        {sections.map(({ model, modelResolved, kpi, data, comparisonKpi }) => {
          const compareLabel = comparison ? shortVersionLabel(comparison.versionId, comparison.versionName) : "";
          const deltas = comparisonDeltaItems(comparisonKpi, compareLabel);
          const runsSub = [excludedSub(kpi), deltas.sub].filter(Boolean).join(" · ") || undefined;
          return (
            <div key={model ?? "_single"} className="space-y-3">
              {model !== null && (
                <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                  {formatModel(model, modelResolved) ?? "(legacy)"}
                </h2>
              )}
              <KpiStrip
                items={[
                  { label: "Runs", value: kpi.runs.toString(), sub: runsSub },
                  { label: "Strict pass", value: `${kpi.passPct}%`, sub: `${kpi.pass} of ${kpi.total} scored`, tone: tonePassRate(kpi.passPct), delta: deltas.pass },
                  { label: "Avg duration", value: fmtTimeShort(kpi.avgDuration), delta: deltas.duration },
                  { label: "Avg agent cost", value: kpi.avgCost > 0 ? `$${kpi.avgCost.toFixed(2)}` : "—", delta: deltas.cost },
                ]}
              />
              <MatrixTable data={data} />
            </div>
          );
        })}
      </div>

      {/* Per-task tables — v1 layout: one table per task with all runs visible. */}
      <div className="flex flex-col gap-8">
        <p className="text-[12px] text-fg-faint -mb-4">Sorted by fastest time, then lowest cost.</p>
        {filtered.map(({ task, prompt, sessions }) => {
          if (sessions.length === 0) return null;
          return (
            <section key={task}>
              <div className="mb-3">
                <h2 className="text-sm font-semibold text-foreground">{task}</h2>
                {prompt && (
                  <p className="mt-1 max-w-4xl line-clamp-2 text-pretty text-xs leading-5 text-fg-muted">
                    {prompt}
                  </p>
                )}
              </div>
              <TaskTable sessions={sessions} />
            </section>
          );
        })}
      </div>

      {/* Recent runs strip — local-sweep only, sits at the end as a
          drill-down activity feed. */}
      {showRecentRuns && recentRuns.length > 0 && (
        <RecentRuns sessions={recentRuns} limit={10} />
      )}
    </div>
  );
}
