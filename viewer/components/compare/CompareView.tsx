"use client";

import { RunCost } from "@/components/RunCost";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeftRight, ExternalLink, GitCompareArrows } from "lucide-react";
import { KpiStrip, tonePassRate, type Kpi } from "@/components/leaderboard/KpiStrip";
import { StatusBadge, statusFromResult } from "@/components/ui/StatusBadge";
import { VersionCombobox } from "@/components/ui/VersionCombobox";
import { sameRecordedDefinition } from "@/lib/comparison-identity.mjs";
import { cn, formatModel } from "@/lib/utils";

export type CompareVersionOption = {
  id: string;
  name: string;
  description: string | null;
  kind?: "weekly" | "experiment" | "smoke" | null;
  runAt?: string | null;
  createdAt?: string | null;
};

export type CompareSession = {
  id: string;
  version: string;
  run: string;
  agent: string;
  agentName: string;
  model: string;
  modelResolved: string | null;
  configId: string;
  configLabel: string;
  configDir: string;
  task: string;
  taskName: string;
  durationSec: number;
  passed: boolean | null;
  result: string | null;
  rawResult?: string | null;
  auditVerdict: string | null;
  costUsd: number | null;
  costSource?: "reported" | "estimated" | "unavailable";
  mcpCalls: number;
  mcpMethods: string[];
  toolVersions?: unknown;
  prompt: string;
  gradingCriteria: string | null;
  snapshotFingerprint?: string;
};

// Direction is fixed: `base` is the older version (left), `cur` is the newer
// (right). Every delta on this page is cur − base, colored by better/worse.
type ComparePair = {
  key: string;
  segmentKey: string;
  rowKey: string;
  cur: CompareSession;
  base: CompareSession;
  promptChanged: boolean;
  definitionChanged: boolean;
  bothScored: boolean;
  unaudited: boolean;
};

type SideStats = {
  pass: number;
  total: number;
  durationTotal: number;
  durationCount: number;
  costTotal: number;
  costCount: number;
};

type RowChange = "regressed" | "improved" | "held" | "unscored" | "excluded";

type RowStats = {
  key: string;
  task: string;
  taskName: string;
  configId: string;
  configLabel: string;
  cur: SideStats;
  base: SideStats;
  pairs: ComparePair[];
  promptChanged: number;
  definitionChanged: number;
  unaudited: number;
  unscored: number;
  change: RowChange;
};

type Segment = {
  key: string;
  label: string;
  agentName: string;
  modelLabel: string;
  runner: string;
  rows: RowStats[];
  configs: { id: string; label: string }[];
  tasks: { task: string; taskName: string; byConfig: Map<string, RowStats> }[];
};

type CompareModel = {
  pairs: ComparePair[];
  matchedPairs: number;
  promptChanged: number;
  definitionChangedPairs: number;
  duplicateKeys: number;
  unpairedCur: number;
  unpairedBase: number;
  unauditedPairs: number;
  scoredPairs: ComparePair[];
  segments: Segment[];
  changes: { segment: Segment; row: RowStats }[];
  scoredCells: number;
  heldCells: number;
  includePromptChanges: boolean;
};

type KpiMetrics = {
  scoredPairs: ComparePair[];
  changes: { row: RowStats }[];
  scoredCells: number;
  heldCells: number;
  promptChanged: number;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toolVersionsRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function runnerOf(session: CompareSession): string {
  return readString(toolVersionsRecord(session.toolVersions).runner) || "";
}

function docsMeta(session: CompareSession): Record<string, unknown> | null {
  const docs = toolVersionsRecord(session.toolVersions).docs;
  return docs && typeof docs === "object" ? docs as Record<string, unknown> : null;
}

function docsLabel(session: CompareSession): string | null {
  const docs = docsMeta(session);
  if (!docs) return null;
  return readString(docs.fingerprint) || readString(docs.label) || null;
}

function docsCapturedAt(session: CompareSession): string | null {
  const captured = readString(docsMeta(session)?.capturedAt);
  if (!captured) return null;
  const parsed = new Date(captured);
  if (Number.isNaN(parsed.getTime())) return captured;
  return parsed.toISOString().slice(0, 10);
}

function docsSummary(sessions: CompareSession[]): { label: string; captured: string } {
  const labels = new Set<string>();
  const captured = new Set<string>();
  for (const session of sessions) {
    const label = docsLabel(session);
    if (label) labels.add(label);
    const capturedAt = docsCapturedAt(session);
    if (capturedAt) captured.add(capturedAt);
  }
  return {
    label: labels.size === 0 ? "unlabeled" : [...labels].slice(0, 2).join(", ") + (labels.size > 2 ? ` +${labels.size - 2}` : ""),
    captured: captured.size === 0 ? "no capture timestamp" : [...captured].sort().slice(0, 2).join(", ") + (captured.size > 2 ? ` +${captured.size - 2}` : ""),
  };
}

function modelKey(session: CompareSession): string {
  return session.modelResolved || session.model || "";
}

function segmentKey(session: CompareSession): string {
  return [session.agent, modelKey(session), runnerOf(session)].join("\x1f");
}

function pairKey(session: CompareSession): string {
  return [segmentKey(session), session.task, session.configDir, session.run].join("\x1f");
}

function rowKey(session: CompareSession): string {
  return [session.task, session.configDir].join("\x1f");
}

function isScoredResult(result: string | null | undefined): boolean {
  return result === "pass" || result === "fail" || result === "incomplete";
}

function isCliTask(slug: string): boolean {
  return /^cli:|-cli$/.test(slug);
}

function filterSessions(
  sessions: CompareSession[],
  filters: {
    agent: string;
    model: string;
    config: string;
    task: string;
    run: string;
    category: string;
  },
): CompareSession[] {
  return sessions.filter((session) => {
    if (filters.agent !== "all" && session.agent !== filters.agent) return false;
    if (filters.model !== "all" && (session.model ?? "") !== filters.model) return false;
    if (filters.config !== "all" && session.configId !== filters.config) return false;
    if (filters.task !== "all" && session.task !== filters.task) return false;
    if (filters.run !== "all" && session.run !== filters.run) return false;
    if (filters.category === "cli" && !isCliTask(session.task)) return false;
    if (filters.category === "general" && isCliTask(session.task)) return false;
    return true;
  });
}

function emptyStats(): SideStats {
  return { pass: 0, total: 0, durationTotal: 0, durationCount: 0, costTotal: 0, costCount: 0 };
}

function addSide(stats: SideStats, session: CompareSession) {
  if (!isScoredResult(session.result) || session.passed == null) return;
  stats.total += 1;
  if (session.passed) stats.pass += 1;
  if (session.durationSec > 0) {
    stats.durationTotal += session.durationSec;
    stats.durationCount += 1;
  }
  if (session.costUsd !== null && session.costUsd >= 0) {
    stats.costTotal += session.costUsd;
    stats.costCount += 1;
  }
}

function pct(stats: SideStats): number {
  return stats.total > 0 ? Math.round((stats.pass / stats.total) * 100) : 0;
}

function avgDuration(stats: SideStats): number {
  return stats.durationCount > 0 ? Math.round(stats.durationTotal / stats.durationCount) : 0;
}

function avgCost(stats: SideStats): number {
  return stats.costCount > 0 ? stats.costTotal / stats.costCount : 0;
}

function fmtDuration(sec: number): string {
  if (sec <= 0) return "-";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function fmtCost(value: number): string {
  if (value <= 0) return "-";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

function fmtSignedDuration(value: number): string {
  if (value === 0) return "±0s";
  const abs = Math.abs(value);
  return `${value > 0 ? "+" : "−"}${fmtDuration(abs)}`;
}

function fmtSignedCost(value: number): string {
  if (Math.abs(value) < 0.005) return "flat";
  return `${value > 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;
}

function frac(stats: SideStats): string {
  return `${stats.pass}/${stats.total}`;
}

// Prompt differences are filtered before this check unless the user explicitly
// opts in. Rubric differences always remain excluded from score deltas.
function isCountable(pair: ComparePair): boolean {
  return pair.bothScored && !pair.definitionChanged;
}

function classifyRow(row: RowStats): RowChange {
  if (row.pairs.length > 0 && row.pairs.every((pair) => pair.definitionChanged)) return "excluded";
  if (row.cur.total === 0 && row.base.total === 0) return "unscored";
  if (row.cur.total === 0 || row.base.total === 0) return "held";
  const delta = pct(row.cur) - pct(row.base);
  if (delta < 0) return "regressed";
  if (delta > 0) return "improved";
  return "held";
}

function buildCompareModel(
  sessionsCur: CompareSession[],
  sessionsBase: CompareSession[],
  includePromptChanges: boolean,
): CompareModel {
  const byBase = new Map<string, CompareSession>();
  const duplicateKeys = new Set<string>();
  for (const session of sessionsBase) {
    const key = pairKey(session);
    if (byBase.has(key)) duplicateKeys.add(key);
    else byBase.set(key, session);
  }

  const seenBase = new Set<string>();
  const pairs: ComparePair[] = [];
  let promptChanged = 0;
  let definitionChangedPairs = 0;
  let unpairedCur = 0;

  for (const cur of sessionsCur) {
    const key = pairKey(cur);
    const base = byBase.get(key);
    if (!base || duplicateKeys.has(key)) {
      unpairedCur += 1;
      continue;
    }
    seenBase.add(key);
    const pair: ComparePair = {
      key,
      segmentKey: segmentKey(cur),
      rowKey: rowKey(cur),
      cur,
      base,
      promptChanged: (cur.prompt || "") !== (base.prompt || ""),
      definitionChanged: !sameRecordedDefinition(cur, base) || (cur.gradingCriteria || "") !== (base.gradingCriteria || ""),
      bothScored: isScoredResult(cur.result) && isScoredResult(base.result) && cur.passed != null && base.passed != null,
      unaudited: !cur.auditVerdict || !base.auditVerdict,
    };
    if (pair.promptChanged) promptChanged += 1;
    pairs.push(pair);
  }

  let unpairedBase = 0;
  for (const session of sessionsBase) {
    const key = pairKey(session);
    if (!seenBase.has(key) && !duplicateKeys.has(key)) unpairedBase += 1;
  }

  const comparablePairs = pairs.filter((pair) => includePromptChanges || !pair.promptChanged);
  definitionChangedPairs = comparablePairs.filter((pair) => pair.definitionChanged).length;
  const scoredPairs = comparablePairs.filter(isCountable);
  const unauditedPairs = comparablePairs.filter((pair) => pair.unaudited).length;
  const rowsBySegment = new Map<string, Map<string, RowStats>>();

  for (const pair of comparablePairs) {
    let rows = rowsBySegment.get(pair.segmentKey);
    if (!rows) {
      rows = new Map();
      rowsBySegment.set(pair.segmentKey, rows);
    }
    let row = rows.get(pair.rowKey);
    if (!row) {
      row = {
        key: `${pair.segmentKey}\x1f${pair.rowKey}`,
        task: pair.cur.task,
        taskName: pair.cur.taskName || pair.cur.task,
        configId: pair.cur.configDir,
        configLabel: pair.cur.configLabel || pair.cur.configId || pair.cur.configDir,
        cur: emptyStats(),
        base: emptyStats(),
        pairs: [],
        promptChanged: 0,
        definitionChanged: 0,
        unaudited: 0,
        unscored: 0,
        change: "held",
      };
      rows.set(pair.rowKey, row);
    }
    row.pairs.push(pair);
    if (pair.promptChanged) row.promptChanged += 1;
    if (pair.definitionChanged) row.definitionChanged += 1;
    if (pair.unaudited) row.unaudited += 1;
    if (!pair.bothScored) row.unscored += 1;
    if (isCountable(pair)) {
      addSide(row.cur, pair.cur);
      addSide(row.base, pair.base);
    }
  }

  const segments: Segment[] = [...rowsBySegment.entries()]
    .map(([key, rowMap]) => {
      const rows = [...rowMap.values()]
        .map((row) => ({ ...row, change: classifyRow(row) }))
        .sort((x, y) => x.task.localeCompare(y.task) || x.configId.localeCompare(y.configId));
      const sample = rows[0]?.pairs[0]?.cur;
      const agentName = sample ? sample.agentName || sample.agent : "unknown agent";
      const modelLabel = sample ? formatModel(sample.model, sample.modelResolved) || modelKey(sample) || "unknown" : "unknown";
      const runner = sample ? runnerOf(sample) : "";

      const configMap = new Map<string, string>();
      for (const row of rows) if (!configMap.has(row.configId)) configMap.set(row.configId, row.configLabel);
      const configs = [...configMap.entries()]
        .map(([id, label]) => ({ id, label }))
        .sort((x, y) => x.id.localeCompare(y.id));

      const taskMap = new Map<string, { task: string; taskName: string; byConfig: Map<string, RowStats> }>();
      for (const row of rows) {
        let entry = taskMap.get(row.task);
        if (!entry) {
          entry = { task: row.task, taskName: row.taskName, byConfig: new Map() };
          taskMap.set(row.task, entry);
        }
        entry.byConfig.set(row.configId, row);
      }

      return {
        key,
        label: `${agentName} / ${modelLabel} / ${runner || "runner not recorded"}`,
        agentName,
        modelLabel,
        runner,
        rows,
        configs,
        tasks: [...taskMap.values()].sort((x, y) => x.task.localeCompare(y.task)),
      };
    })
    .sort((x, y) => x.label.localeCompare(y.label));

  const changes: { segment: Segment; row: RowStats }[] = [];
  let scoredCells = 0;
  let heldCells = 0;
  for (const segment of segments) {
    for (const row of segment.rows) {
      if (row.change === "regressed" || row.change === "improved") changes.push({ segment, row });
      if (row.change === "regressed" || row.change === "improved" || row.change === "held") {
        if (row.cur.total > 0 && row.base.total > 0) {
          scoredCells += 1;
          if (row.change === "held") heldCells += 1;
        }
      }
    }
  }
  changes.sort((x, y) => {
    if (x.row.change !== y.row.change) return x.row.change === "regressed" ? -1 : 1;
    return x.row.task.localeCompare(y.row.task) || x.row.configId.localeCompare(y.row.configId);
  });

  return {
    pairs: comparablePairs,
    matchedPairs: pairs.length,
    promptChanged,
    definitionChangedPairs,
    duplicateKeys: duplicateKeys.size,
    unpairedCur,
    unpairedBase,
    unauditedPairs,
    scoredPairs,
    segments,
    changes,
    scoredCells,
    heldCells,
    includePromptChanges,
  };
}

function aggregatePairs(pairs: ComparePair[], side: "cur" | "base"): SideStats {
  const stats = emptyStats();
  for (const pair of pairs) addSide(stats, pair[side]);
  return stats;
}

function deltaChip(
  delta: number,
  fmt: (v: number) => string,
  direction: "up-good" | "down-good",
  title: string,
): Kpi["delta"] {
  if (delta === 0) return { label: "flat", tone: "neutral" };
  const good = direction === "up-good" ? delta > 0 : delta < 0;
  const arrow = delta > 0 ? "▲" : "▼";
  return {
    label: `${arrow} ${fmt(Math.abs(delta))}`,
    tone: good ? "pass" : direction === "up-good" && delta < 0 ? "fail" : "warn",
    title,
  };
}

function metricsFromRows(rows: RowStats[]): KpiMetrics {
  const changes: { row: RowStats }[] = [];
  const scoredPairs: ComparePair[] = [];
  let scoredCells = 0;
  let heldCells = 0;

  for (const row of rows) {
    if (row.change === "regressed" || row.change === "improved") changes.push({ row });
    if (row.change === "regressed" || row.change === "improved" || row.change === "held") {
      if (row.cur.total > 0 && row.base.total > 0) {
        scoredCells += 1;
        if (row.change === "held") heldCells += 1;
      }
    }
    scoredPairs.push(...row.pairs.filter(isCountable));
  }

  return {
    scoredPairs,
    changes,
    scoredCells,
    heldCells,
    promptChanged: scoredPairs.filter((pair) => pair.promptChanged).length,
  };
}

function buildKpis(metrics: KpiMetrics): Kpi[] {
  const cur = aggregatePairs(metrics.scoredPairs, "cur");
  const base = aggregatePairs(metrics.scoredPairs, "base");
  const passDelta = pct(cur) - pct(base);
  const netPassing = cur.pass - base.pass;
  const durationDelta = avgDuration(cur) - avgDuration(base);
  const costDelta = Math.round((avgCost(cur) - avgCost(base)) * 100) / 100;
  const regressed = metrics.changes.filter((change) => change.row.change === "regressed").length;
  const improved = metrics.changes.length - regressed;
  const deltaTitle = metrics.promptChanged > 0
    ? "Current minus baseline, including scored pairs with different prompts"
    : "Current minus baseline, over prompt-identical scored pairs";

  return [
    {
      label: "Pass rate",
      value: cur.total > 0 ? `${pct(cur)}%` : "-",
      sub: cur.total > 0 ? `was ${pct(base)}% · ${cur.pass} of ${cur.total} pairs passing` : "no scored pairs",
      tone: cur.total > 0 ? tonePassRate(pct(cur)) : "neutral",
      delta: cur.total > 0 ? deltaChip(passDelta, (v) => `${v}pp`, "up-good", deltaTitle) : undefined,
    },
    {
      label: "Scored cells",
      value: String(metrics.scoredCells),
      sub: `${metrics.scoredPairs.length} pairs · ${regressed} regressed · ${improved} improved`,
      delta: netPassing !== 0 ? deltaChip(netPassing, (v) => `${v} net passing`, "up-good", deltaTitle) : undefined,
    },
    {
      label: "Avg duration",
      value: fmtDuration(avgDuration(cur)),
      sub: avgDuration(base) > 0 ? `was ${fmtDuration(avgDuration(base))}` : undefined,
      delta: avgDuration(cur) > 0 && avgDuration(base) > 0 && durationDelta !== 0
        ? deltaChip(durationDelta, (v) => fmtDuration(v), "down-good", deltaTitle)
        : undefined,
    },
    {
      label: "Avg cost / run",
      value: fmtCost(avgCost(cur)),
      sub: avgCost(base) > 0 ? `was ${fmtCost(avgCost(base))}` : undefined,
      delta: avgCost(cur) > 0 && avgCost(base) > 0 && costDelta !== 0
        ? deltaChip(costDelta, (v) => `$${v.toFixed(2)}`, "down-good", deltaTitle)
        : undefined,
    },
  ];
}

function buildMultiSegmentKpis(model: CompareModel): Kpi[] {
  const regressed = model.changes.filter((change) => change.row.change === "regressed").length;
  const improved = model.changes.length - regressed;
  const guarded = (model.includePromptChanges ? 0 : model.promptChanged) + model.definitionChangedPairs;

  return [
    {
      label: "Compare scope",
      value: `${model.segments.length} segments`,
      sub: "agent/model/runner metrics are split below",
      tone: "warn",
    },
    {
      label: "Scored pairs",
      value: String(model.scoredPairs.length),
      sub: model.scoredPairs.some((pair) => pair.promptChanged)
        ? "different-prompt pairs included"
        : "not aggregated into pass-rate deltas",
    },
    {
      label: "Changed cells",
      value: String(model.changes.length),
      sub: `${regressed} regressed · ${improved} improved`,
      tone: regressed > 0 ? "fail" : improved > 0 ? "pass" : "neutral",
    },
    {
      label: "Guarded out",
      value: String(guarded),
      sub: `${model.includePromptChanges ? 0 : model.promptChanged} prompt · ${model.definitionChangedPairs} definition`,
      tone: guarded > 0 ? "warn" : "neutral",
    },
  ];
}

function docsCalls(row: RowStats, side: "cur" | "base"): number {
  return row.pairs.reduce((sum, pair) => sum + pair[side].mcpCalls, 0);
}

function isDocsRelevant(row: RowStats): boolean {
  return row.configId.toLowerCase().includes("mcp") || row.pairs.some((pair) => pair.cur.mcpCalls > 0 || pair.base.mcpCalls > 0);
}

function docsUsageLabel(session: CompareSession): string {
  const methods = session.mcpMethods.map((method) => method.replace("mcp__TogetherAIDocs__", ""));
  if (methods.length === 0) return `${session.mcpCalls} call${session.mcpCalls === 1 ? "" : "s"}`;
  return `${session.mcpCalls} call${session.mcpCalls === 1 ? "" : "s"}: ${methods.slice(0, 2).join(", ")}${methods.length > 2 ? ` +${methods.length - 2}` : ""}`;
}

export function CompareView({
  versions,
  versionCurrent,
  versionBaseline,
  sessionsCurrent,
  sessionsBaseline,
}: {
  versions: CompareVersionOption[];
  versionCurrent: string;
  versionBaseline: string;
  sessionsCurrent: CompareSession[];
  sessionsBaseline: CompareSession[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
  const drilldownRef = useRef<HTMLDivElement | null>(null);
  const filters = {
    agent: searchParams.get("agent") || searchParams.get("harness") || "all",
    model: searchParams.get("model") || "all",
    config: searchParams.get("config") || "all",
    task: searchParams.get("task") || "all",
    run: searchParams.get("run") || "all",
    category: searchParams.get("category") || "all",
  };
  const includePromptChanges = searchParams.get("comparePrompts") === "1";
  const filteredCur = useMemo(() => filterSessions(sessionsCurrent, filters), [sessionsCurrent, filters.agent, filters.model, filters.config, filters.task, filters.run, filters.category]);
  const filteredBase = useMemo(() => filterSessions(sessionsBaseline, filters), [sessionsBaseline, filters.agent, filters.model, filters.config, filters.task, filters.run, filters.category]);
  const model = useMemo(
    () => buildCompareModel(filteredCur, filteredBase, includePromptChanges),
    [filteredCur, filteredBase, includePromptChanges],
  );
  const kpis = useMemo(() => {
    if (model.segments.length > 1) return buildMultiSegmentKpis(model);
    return buildKpis(metricsFromRows(model.segments[0]?.rows ?? []));
  }, [model]);
  const activeRow = useMemo(() => {
    if (!activeRowKey) return null;
    for (const segment of model.segments) {
      const row = segment.rows.find((candidate) => candidate.key === activeRowKey);
      if (row) return { segment, row };
    }
    return null;
  }, [activeRowKey, model.segments]);
  const docsCur = useMemo(() => docsSummary(sessionsCurrent), [sessionsCurrent]);
  const docsBase = useMemo(() => docsSummary(sessionsBaseline), [sessionsBaseline]);

  useEffect(() => {
    if (!activeRow) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    drilldownRef.current?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  }, [activeRow]);

  const setVersion = (key: "a" | "b", value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("v");
    params.set(key, value);
    router.push(`/compare?${params.toString()}`);
  };

  const swap = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("v");
    params.set("a", versionBaseline);
    params.set("b", versionCurrent);
    router.push(`/compare?${params.toString()}`);
  };

  const setIncludePromptChanges = (include: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    if (include) params.set("comparePrompts", "1");
    else params.delete("comparePrompts");
    setActiveRowKey(null);
    router.replace(`/compare?${params.toString()}`, { scroll: false });
  };

  const regressed = model.changes.filter((change) => change.row.change === "regressed").length;
  const improved = model.changes.length - regressed;
  const singleSegment = model.segments.length === 1 ? model.segments[0] : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
            <GitCompareArrows className="h-3.5 w-3.5" aria-hidden />
            Compare
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground">Version comparison</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Reads left to right: baseline → current. Deltas are current minus baseline
            {includePromptChanges ? ", including marked different-prompt cells." : ", over prompt-identical cells."}
          </p>
        </div>

        <div className="shrink-0">
          <div className="flex items-end gap-2">
            <VersionPicker
              label="Baseline (older)"
              value={versionBaseline}
              versions={versions}
              docs={docsBase}
              onChange={(value) => setVersion("b", value)}
            />
            <span className="pb-6 text-sm text-fg-muted" aria-hidden>→</span>
            <VersionPicker
              label="Current (newer)"
              value={versionCurrent}
              versions={versions}
              docs={docsCur}
              onChange={(value) => setVersion("a", value)}
            />
            <button
              type="button"
              onClick={swap}
              className="mb-5 inline-flex h-8 w-8 items-center justify-center rounded-md border border-rule text-fg-muted hover:bg-surface hover:text-foreground"
              aria-label="Swap baseline and current"
              title="Swap baseline and current"
            >
              <ArrowLeftRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {singleSegment && (
            <div className="mt-1 flex flex-wrap justify-end gap-1.5">
              <ConstantChip label="Agent" value={singleSegment.agentName} />
              <ConstantChip label="Model" value={singleSegment.modelLabel} />
              {singleSegment.runner
                ? <ConstantChip label="Runner" value={singleSegment.runner} />
                : <ConstantChip label="Runner" value="not recorded" warn />}
            </div>
          )}
        </div>
      </div>

      {model.promptChanged > 0 && (
        <PromptDifferenceNotice
          count={model.promptChanged}
          enabled={includePromptChanges}
          onChange={setIncludePromptChanges}
        />
      )}

      {model.pairs.length > 0 && (
        <p className="text-[15px] text-foreground">
          {model.changes.length === 0 ? (
            <>
              <span className="font-semibold">No changes</span>
              {" "}since {versionBaseline} — all {model.scoredCells} scored cell{model.scoredCells === 1 ? "" : "s"} held.
            </>
          ) : (
            <>
              <span className="font-semibold">
                {regressed > 0 && `${regressed} cell${regressed === 1 ? "" : "s"} regressed`}
                {regressed > 0 && improved > 0 && ", "}
                {improved > 0 && `${improved} improved`}
              </span>
              {" "}since {versionBaseline} — the other {model.heldCells} scored cell{model.heldCells === 1 ? "" : "s"} held.
            </>
          )}
        </p>
      )}

      <KpiStrip items={kpis} />

      {model.changes.length > 0 && (
        <section className="space-y-2">
          <SectionHead title="What changed" count={`${model.changes.length} cell${model.changes.length === 1 ? "" : "s"}`} />
          <div className="space-y-2">
            {model.changes.map(({ segment, row }) => (
              <ChangeCard
                key={row.key}
                row={row}
                segment={segment}
                showSegment={model.segments.length > 1}
                onSelect={() => setActiveRowKey(row.key)}
              />
            ))}
          </div>
        </section>
      )}

      {model.segments.length === 0 ? (
        <div className="rounded-lg border border-rule bg-background p-8 text-center text-sm text-fg-muted">
          {model.matchedPairs > 0 && model.promptChanged > 0 && !includePromptChanges
            ? "No prompt-identical comparable cells. Turn on “Compare different prompts” above to inspect these versions anyway."
            : "No comparable cells for these versions."}
        </div>
      ) : (
        <section className="space-y-6">
          {model.segments.map((segment) => (
            <div key={segment.key} className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <SectionHead
                  title="All cells"
                  count={`${segment.tasks.length} task${segment.tasks.length === 1 ? "" : "s"} × ${segment.configs.length} config${segment.configs.length === 1 ? "" : "s"} · current shown, arrow marks movement`}
                />
                {!singleSegment && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <ConstantChip label="Agent" value={segment.agentName} />
                    <ConstantChip label="Model" value={segment.modelLabel} />
                    {segment.runner
                      ? <ConstantChip label="Runner" value={segment.runner} />
                      : <ConstantChip label="Runner" value="not recorded" warn />}
                  </div>
                )}
              </div>
              {!singleSegment && <KpiStrip items={buildKpis(metricsFromRows(segment.rows))} />}
              <CompareGrid segment={segment} activeRowKey={activeRowKey} onSelectRow={setActiveRowKey} />
            </div>
          ))}
          <GridLegend showPromptMismatch={includePromptChanges && model.promptChanged > 0} />
        </section>
      )}

      {activeRow && (
        <div ref={drilldownRef}>
          <DrilldownPanel
            key={activeRow.row.key}
            segmentLabel={activeRow.segment.label}
            row={activeRow.row}
            versionCurrent={versionCurrent}
            versionBaseline={versionBaseline}
            onClose={() => setActiveRowKey(null)}
          />
        </div>
      )}

      <GuardsFootnote model={model} versionCurrent={versionCurrent} versionBaseline={versionBaseline} />
    </div>
  );
}

function PromptDifferenceNotice({
  count,
  enabled,
  onChange,
}: {
  count: number;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warn/40 bg-warn-faint px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
        <div>
          <div className="text-[13px] font-semibold text-foreground">Prompts differ between versions</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">
            {enabled
              ? `${count} matched pair${count === 1 ? " uses" : "s use"} different prompts and ${count === 1 ? "is" : "are"} included. Treat the deltas as directional, not apples-to-apples.`
              : `${count} matched pair${count === 1 ? " uses" : "s use"} different prompts and ${count === 1 ? "is" : "are"} excluded by default.`}
          </p>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        className="inline-flex shrink-0 items-center gap-2.5 self-start rounded-md border border-warn/40 bg-background px-3 py-2 text-[12px] font-medium text-foreground shadow-sm transition-colors hover:border-warn/70 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/40 sm:self-center"
      >
        <span
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors",
            enabled ? "border-warn bg-warn" : "border-fg-faint/50 bg-surface",
          )}
          aria-hidden
        >
          <span
            className={cn(
              "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform",
              enabled ? "translate-x-[17px]" : "translate-x-0.5",
            )}
          />
        </span>
        Compare different prompts
      </button>
    </div>
  );
}

function SectionHead({ title, count }: { title: string; count?: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">{title}</h2>
      {count && <span className="text-[11px] text-fg-faint">{count}</span>}
    </div>
  );
}

function ConstantChip({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px]",
        warn ? "border-warn/40 bg-warn-faint text-warn" : "border-rule bg-surface text-fg-muted",
      )}
    >
      {label} <b className={cn("font-medium", warn ? "text-warn" : "text-foreground")}>{value}</b>
    </span>
  );
}

function VersionPicker({
  label,
  value,
  versions,
  docs,
  onChange,
}: {
  label: string;
  value: string;
  versions: CompareVersionOption[];
  docs: { label: string; captured: string };
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0">
      <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{label}</span>
      <div className="mt-1">
        <VersionCombobox value={value} options={versions} onChange={onChange} ariaLabel={label} />
      </div>
      <span className="mt-1 block max-w-44 truncate text-[10px] text-fg-faint" title={`${docs.label} · ${docs.captured}`}>
        docs: {docs.label} · {docs.captured}
      </span>
    </div>
  );
}

// Run dots encode result by shape as well as color: pass = round dot,
// fail = rotated square, so state never rides on color alone.
function RunDot({ passed, title }: { passed: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-block h-2 w-2 shrink-0",
        passed ? "rounded-full bg-pass" : "rotate-45 rounded-[1px] bg-fail",
      )}
      aria-label={title || (passed ? "pass" : "fail")}
    />
  );
}

function ChangeCard({
  row,
  segment,
  showSegment,
  onSelect,
}: {
  row: RowStats;
  segment: Segment;
  showSegment: boolean;
  onSelect: () => void;
}) {
  const regressed = row.change === "regressed";
  const scoredPairs = row.pairs.filter(isCountable).sort((x, y) => x.cur.run.localeCompare(y.cur.run));
  const durationDelta = avgDuration(row.cur) - avgDuration(row.base);
  const docsRelevant = isDocsRelevant(row);
  const docsBefore = docsCalls(row, "base");
  const docsAfter = docsCalls(row, "cur");

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-rule border-l-[3px] bg-background px-4 py-2.5",
        regressed ? "border-l-fail" : "border-l-pass",
      )}
    >
      <span className={cn("w-[86px] shrink-0 text-[10px] font-bold uppercase tracking-[0.08em]", regressed ? "text-fail" : "text-pass")}>
        {regressed ? "Regressed" : "Improved"}
      </span>
      <span className="min-w-52 text-[13px]">
        <b className="font-semibold text-foreground">{row.taskName}</b>
        <span className="text-fg-muted"> · {row.configLabel}</span>
        {row.promptChanged > 0 && (
          <span className="ml-2 rounded-[3px] border border-warn/40 bg-warn-faint px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.05em] text-warn">
            prompt Δ
          </span>
        )}
        {showSegment && <span className="ml-2 text-[11px] text-fg-faint">{segment.agentName} · {segment.modelLabel}</span>}
      </span>
      <span className="flex items-center gap-2 text-[14px] tabular-nums">
        <span className="font-medium text-fg-muted">{frac(row.base)}</span>
        <span className="text-fg-faint">→</span>
        <span className="font-semibold text-foreground">{frac(row.cur)}</span>
        <span className="ml-1 flex items-center gap-1" aria-hidden>
          {scoredPairs.map((pair) => <RunDot key={`b-${pair.key}`} passed={!!pair.base.passed} title={`${pair.base.run} baseline: ${pair.base.passed ? "pass" : "fail"}`} />)}
          <span className="mx-0.5 text-[10px] text-fg-faint">→</span>
          {scoredPairs.map((pair) => <RunDot key={`c-${pair.key}`} passed={!!pair.cur.passed} title={`${pair.cur.run} current: ${pair.cur.passed ? "pass" : "fail"}`} />)}
        </span>
      </span>
      <span className="ml-auto flex items-center gap-4 text-[12px] tabular-nums text-fg-muted">
        {durationDelta !== 0 && <span>{fmtSignedDuration(durationDelta)}</span>}
        {docsRelevant && (docsBefore > 0 || docsAfter > 0) && (
          <span title="Docs MCP calls, baseline → current">docs MCP: {docsBefore} → {docsAfter} calls</span>
        )}
        <button
          type="button"
          onClick={onSelect}
          className="border-b border-rule text-fg-muted hover:border-fg-faint hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40"
        >
          sessions →
        </button>
      </span>
    </div>
  );
}

function CompareGrid({
  segment,
  activeRowKey,
  onSelectRow,
}: {
  segment: Segment;
  activeRowKey: string | null;
  onSelectRow: (key: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-background">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-surface/60">
              <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Task</th>
              {segment.configs.map((config) => (
                <th key={config.id} className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint" style={{ minWidth: 150 }}>
                  {config.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {segment.tasks.map((taskRow) => (
              <tr key={taskRow.task} className="border-t border-rule">
                <td className="whitespace-nowrap px-4 py-2.5">
                  <span className="text-[13px] font-medium text-foreground">{taskRow.taskName}</span>
                  <span className="ml-2 text-[10px] tabular-nums text-fg-faint">
                    {[...taskRow.byConfig.values()].reduce((sum, row) => sum + row.pairs.length, 0)} pairs
                  </span>
                </td>
                {segment.configs.map((config) => {
                  const row = taskRow.byConfig.get(config.id);
                  return (
                    <td key={config.id} className="p-0 align-middle">
                      {row ? (
                        <GridCell row={row} active={activeRowKey === row.key} onSelect={() => onSelectRow(row.key)} />
                      ) : (
                        <div className="py-2.5 text-center text-[12px] text-fg-faint">–</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GridCell({ row, active, onSelect }: { row: RowStats; active: boolean; onSelect: () => void }) {
  const changed = row.change === "regressed" || row.change === "improved";

  if (row.change === "excluded") {
    return (
      <div
        className="relative flex min-h-11 items-center justify-center gap-1.5 px-2 py-2.5 text-[12px] text-fg-faint"
        title="Grading criteria changed between versions — excluded from comparison"
      >
        excluded
        <span className="absolute right-1.5 top-1 rounded-[3px] border border-warn/40 bg-warn-faint px-1 text-[9px] font-semibold text-warn">rubric Δ</span>
      </div>
    );
  }

  const title =
    row.change === "unscored" ? "No scored pairs on either side" :
    changed ? `${frac(row.base)} → ${frac(row.cur)}, ${row.change}` :
    `${frac(row.cur)}, unchanged${row.base.total === 0 ? " — no scored baseline" : ""}`;
  const promptTitle = row.promptChanged > 0
    ? `${row.promptChanged} pair${row.promptChanged === 1 ? " has" : "s have"} different prompts`
    : "";

  return (
    <button
      type="button"
      onClick={onSelect}
      title={promptTitle ? `${title} — ${promptTitle}` : title}
      className={cn(
        "relative flex min-h-11 w-full items-center justify-center gap-1.5 px-2 py-2.5 tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-foreground/40",
        row.change === "regressed" && "bg-fail-faint hover:bg-fail-faint/70",
        row.change === "improved" && "bg-pass-faint hover:bg-pass-faint/70",
        !changed && "hover:bg-surface",
        active && !changed && "bg-surface",
      )}
    >
      {row.change === "unscored" ? (
        <>
          <span className="inline-block h-2 w-2 rounded-full border border-dashed border-fg-faint" aria-hidden />
          <span className="text-[12px] text-fg-faint">unscored</span>
        </>
      ) : changed ? (
        <>
          <span className={cn("text-[11px] font-bold", row.change === "regressed" ? "text-fail" : "text-pass")} aria-hidden>
            {row.change === "regressed" ? "▼" : "▲"}
          </span>
          <span className="text-[13px] font-semibold text-foreground">{frac(row.cur)}</span>
          <span className="text-[11px] text-fg-muted">was {frac(row.base)}</span>
        </>
      ) : (
        <>
          <span className="text-[13px] text-fg-muted">{row.cur.total > 0 ? frac(row.cur) : frac(row.base)}</span>
          <span className="text-[11px] text-fg-faint" aria-hidden>·</span>
        </>
      )}
      {row.promptChanged > 0 && (
        <span
          className="absolute left-1.5 top-1 rounded-[3px] border border-warn/40 bg-warn-faint px-1 text-[9px] font-semibold text-warn"
          title={promptTitle}
        >
          prompt Δ{row.promptChanged < row.pairs.length ? ` ${row.promptChanged}` : ""}
        </span>
      )}
      {row.unaudited > 0 && (
        <span
          className="absolute right-1.5 top-1 rounded-[3px] border border-rule bg-background px-1 text-[9px] font-semibold text-fg-faint"
          title={`${row.unaudited} pair${row.unaudited === 1 ? "" : "s"} without a deep audit — exit-code result only`}
        >
          {row.unaudited} unaudited
        </span>
      )}
    </button>
  );
}

function GridLegend({ showPromptMismatch }: { showPromptMismatch: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-fg-muted">
      <span className="inline-flex items-center gap-1.5"><span className="font-bold text-fail" aria-hidden>▼</span> regressed</span>
      <span className="inline-flex items-center gap-1.5"><span className="font-bold text-pass" aria-hidden>▲</span> improved</span>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden>·</span> unchanged</span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full border border-dashed border-fg-faint" aria-hidden /> unscored
      </span>
      {showPromptMismatch && (
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded-[3px] border border-warn/40 bg-warn-faint px-1 text-[9px] font-semibold text-warn">prompt Δ</span>
          different prompts — included with caution
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <span className="rounded-[3px] border border-warn/40 bg-warn-faint px-1 text-[9px] font-semibold text-warn">rubric Δ</span>
        grading criteria differ — excluded
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="rounded-[3px] border border-rule bg-background px-1 text-[9px] font-semibold text-fg-faint">unaudited</span>
        exit-code result only
      </span>
    </div>
  );
}

function GuardsFootnote({ model, versionCurrent, versionBaseline }: { model: CompareModel; versionCurrent: string; versionBaseline: string }) {
  const items: string[] = [
    `${model.matchedPairs} pairs matched`,
    `${model.scoredPairs.length} scored & compared`,
  ];
  if (model.promptChanged > 0) {
    items.push(model.includePromptChanges
      ? `${model.promptChanged} prompt-changed — included with caution`
      : `${model.promptChanged} excluded — prompt changed`);
  }
  if (model.definitionChangedPairs > 0) items.push(`${model.definitionChangedPairs} excluded — definition changed or unavailable`);
  if (model.unpairedCur > 0) items.push(`${model.unpairedCur} unpaired (only in ${versionCurrent})`);
  if (model.unpairedBase > 0) items.push(`${model.unpairedBase} unpaired (only in ${versionBaseline})`);
  if (model.duplicateKeys > 0) items.push(`${model.duplicateKeys} duplicate keys skipped`);
  if (model.unauditedPairs > 0) items.push(`${model.unauditedPairs} unaudited`);

  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1.5 rounded-md border border-rule bg-surface px-4 py-3 text-[12px] text-fg-muted">
      {items.map((item) => <span key={item} className="whitespace-nowrap">{item}</span>)}
    </div>
  );
}

function DrilldownPanel({
  segmentLabel,
  row,
  versionCurrent,
  versionBaseline,
  onClose,
}: {
  segmentLabel: string;
  row: RowStats;
  versionCurrent: string;
  versionBaseline: string;
  onClose: () => void;
}) {
  const docsRelevant = isDocsRelevant(row);
  return (
    <section className="rounded-lg border border-rule bg-background">
      <div className="flex items-start justify-between border-b border-rule px-5 py-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Sessions</div>
          <h2 className="mt-1 text-sm font-semibold text-foreground">{row.taskName} / {row.configLabel}</h2>
          <p className="mt-1 text-[12px] text-fg-muted">{segmentLabel}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-rule px-2 py-1 text-[11px] text-fg-muted hover:bg-surface hover:text-foreground"
        >
          close
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-surface/60">
              <DrillTh className="pl-5 text-left" minWidth={140}>Run</DrillTh>
              <DrillTh className="text-left" minWidth={210}>{versionBaseline} (baseline)</DrillTh>
              <DrillTh className="text-left" minWidth={210}>{versionCurrent} (current)</DrillTh>
              <DrillTh className="text-right" minWidth={130}>Delta</DrillTh>
              {docsRelevant && <DrillTh className="pr-5 text-left" minWidth={240}>Docs usage</DrillTh>}
            </tr>
          </thead>
          <tbody>
            {row.pairs.map((pair) => {
              const resultChanged = pair.bothScored && pair.cur.passed !== pair.base.passed;
              return (
                <tr key={pair.key} className="border-t border-rule">
                  <td className="py-3 pl-5 pr-3 align-top">
                    <div className="text-[12px] font-medium text-foreground">{pair.cur.run}</div>
                    {pair.promptChanged && (
                      <div className="mt-0.5 text-[10px] text-warn">prompt Δ — included with caution</div>
                    )}
                    {pair.definitionChanged && (
                      <div className="mt-0.5 text-[10px] text-warn">rubric Δ — excluded</div>
                    )}
                  </td>
                  <SessionLinkCell session={pair.base} />
                  <SessionLinkCell session={pair.cur} />
                  <td className="px-3 py-3 text-right align-top text-[11px] tabular-nums text-fg-muted">
                    <div>{fmtSignedDuration(pair.cur.durationSec - pair.base.durationSec)}</div>
                    <div>{pair.cur.costUsd !== null && pair.base.costUsd !== null ? fmtSignedCost(pair.cur.costUsd - pair.base.costUsd) : "—"}</div>
                    {pair.bothScored && (
                      <div className={cn("font-medium", !resultChanged ? "text-fg-faint" : pair.cur.passed ? "text-pass" : "text-fail")}>
                        {!resultChanged ? "same result" : pair.cur.passed ? "improved" : "regressed"}
                      </div>
                    )}
                  </td>
                  {docsRelevant && (
                    <td className="py-3 pr-5 align-top">
                      <div className="text-[11px] text-fg-muted">{docsUsageLabel(pair.base)} → {docsUsageLabel(pair.cur)}</div>
                      {(docsLabel(pair.base) || docsLabel(pair.cur)) && (
                        <div className="mt-1 text-[10px] text-fg-faint">
                          docs: {docsLabel(pair.base) || "unlabeled"} → {docsLabel(pair.cur) || "unlabeled"}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DrillTh({
  children,
  className,
  minWidth,
}: {
  children: React.ReactNode;
  className?: string;
  minWidth?: number;
}) {
  return (
    <th
      className={cn("px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint", className)}
      style={minWidth ? { minWidth } : undefined}
    >
      {children}
    </th>
  );
}

function SessionLinkCell({ session }: { session: CompareSession }) {
  return (
    <td className="px-3 py-3 align-top">
      <Link
        href={`/s/${encodeURIComponent(session.id)}`}
        className="group inline-flex items-center gap-1 text-[12px] font-medium text-foreground hover:text-info"
      >
        <StatusBadge kind={statusFromResult(session.result, session.passed)} size="sm" />
        <span>{session.result || "unknown"}</span>
        <ExternalLink className="h-3 w-3 text-fg-faint group-hover:text-info" aria-hidden />
      </Link>
      <div className="mt-1 text-[10px] tabular-nums text-fg-faint">
        {fmtDuration(session.durationSec)} · <RunCost value={session.costUsd} source={session.costSource} />
      </div>
      {!session.auditVerdict && (
        <div className="mt-1 text-[10px] text-warn">no deep audit</div>
      )}
    </td>
  );
}
