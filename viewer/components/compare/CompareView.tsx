"use client";

import { RunCost } from "@/components/RunCost";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeftRight, ArrowRight, ExternalLink, X } from "lucide-react";
import { MetaDot, PageHeader } from "@/components/shell/PageHeader";
import { evalVersionDisplayNameById } from "@/lib/version-display";
import { KpiStrip, tonePassRate, type Kpi } from "@/components/leaderboard/KpiStrip";
import { StatusBadge, statusFromResult } from "@/components/ui/StatusBadge";
import { VersionCombobox } from "@/components/ui/VersionCombobox";
import { sameRecordedDefinition } from "@/lib/comparison-identity.mjs";
import { cn, formatDuration, formatModel } from "@/lib/utils";

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

type DocsSummary = { label: string | null; captured: string | null };

function docsSummary(sessions: CompareSession[]): DocsSummary {
  const labels = new Set<string>();
  const captured = new Set<string>();
  for (const session of sessions) {
    const label = docsLabel(session);
    if (label) labels.add(label);
    const capturedAt = docsCapturedAt(session);
    if (capturedAt) captured.add(capturedAt);
  }
  return {
    label: labels.size === 0 ? null : [...labels].slice(0, 2).join(", ") + (labels.size > 2 ? ` +${labels.size - 2}` : ""),
    captured: captured.size === 0 ? null : [...captured].sort().slice(0, 2).join(", ") + (captured.size > 2 ? ` +${captured.size - 2}` : ""),
  };
}

function docsText(docs: DocsSummary): string | null {
  if (!docs.label && !docs.captured) return null;
  return [docs.label ?? "unlabeled", docs.captured].filter(Boolean).join(", ");
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/** "2 regressed, 1 improved", or null when nothing moved. */
function changeSummary(regressed: number, improved: number): string | null {
  const parts = [regressed > 0 ? `${regressed} regressed` : null, improved > 0 ? `${improved} improved` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
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
  return sec > 0 ? formatDuration(sec) : "—";
}

function fmtCost(value: number): string {
  if (value <= 0) return "—";
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
        label: `${agentName} · ${modelLabel} · ${runner ? `Runner ${runner}` : "Runner not recorded"}`,
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
  if (delta === 0) return undefined;
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
  const durationDelta = avgDuration(cur) - avgDuration(base);
  const costDelta = Math.round((avgCost(cur) - avgCost(base)) * 100) / 100;
  const regressed = metrics.changes.filter((change) => change.row.change === "regressed").length;
  const improved = metrics.changes.length - regressed;
  const moved = changeSummary(regressed, improved);
  const deltaTitle = metrics.promptChanged > 0
    ? "Current minus baseline, including scored pairs with different prompts"
    : "Current minus baseline, over prompt-identical scored pairs";

  return [
    {
      label: "Pass rate",
      value: cur.total > 0 ? `${pct(cur)}%` : "—",
      sub: cur.total > 0 ? `was ${pct(base)}%` : "No scored pairs",
      tone: cur.total > 0 ? tonePassRate(pct(cur)) : "neutral",
      delta: cur.total > 0 ? deltaChip(passDelta, (v) => `${v}pp`, "up-good", deltaTitle) : undefined,
    },
    {
      label: "Changed cells",
      value: String(metrics.changes.length),
      sub: `of ${plural(metrics.scoredCells, "scored cell")}`,
      delta: moved ? { label: moved, tone: regressed > 0 ? "fail" : "pass", title: deltaTitle } : undefined,
    },
    {
      label: "Avg duration",
      value: fmtDuration(avgDuration(cur)),
      sub: avgDuration(base) > 0 ? `was ${fmtDuration(avgDuration(base))}` : undefined,
      delta: avgDuration(cur) > 0 && avgDuration(base) > 0
        ? deltaChip(durationDelta, (v) => fmtDuration(v), "down-good", deltaTitle)
        : undefined,
    },
    {
      label: "Avg agent cost",
      value: fmtCost(avgCost(cur)),
      sub: avgCost(base) > 0 ? `was ${fmtCost(avgCost(base))}` : undefined,
      delta: avgCost(cur) > 0 && avgCost(base) > 0
        ? deltaChip(costDelta, (v) => `$${v.toFixed(2)}`, "down-good", deltaTitle)
        : undefined,
    },
  ];
}

function buildMultiSegmentKpis(model: CompareModel): Kpi[] {
  const regressed = model.changes.filter((change) => change.row.change === "regressed").length;
  const improved = model.changes.length - regressed;
  const promptOut = model.includePromptChanges ? 0 : model.promptChanged;
  const excluded = promptOut + model.definitionChangedPairs;
  const excludedWhy = [
    promptOut > 0 ? `${promptOut} prompt changed` : null,
    model.definitionChangedPairs > 0 ? `${model.definitionChangedPairs} rubric changed` : null,
  ].filter(Boolean).join(", ");

  return [
    {
      label: "Segments",
      value: String(model.segments.length),
      sub: "Compared separately below",
    },
    {
      label: "Scored pairs",
      value: String(model.scoredPairs.length),
      sub: model.scoredPairs.some((pair) => pair.promptChanged) ? "Includes different prompts" : undefined,
    },
    {
      label: "Changed cells",
      value: String(model.changes.length),
      sub: changeSummary(regressed, improved) ?? "None regressed or improved",
      tone: regressed > 0 ? "fail" : improved > 0 ? "pass" : "neutral",
    },
    {
      label: "Excluded pairs",
      value: String(excluded),
      sub: excluded > 0 ? excludedWhy : "Prompts and rubrics match",
      tone: excluded > 0 ? "warn" : "neutral",
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

  // Show version names, not internal ids, in sentences and drill-downs.
  const baselineName = evalVersionDisplayNameById(versions, versionBaseline);
  const currentName = evalVersionDisplayNameById(versions, versionCurrent);
  const regressed = model.changes.filter((change) => change.row.change === "regressed").length;
  const improved = model.changes.length - regressed;
  const singleSegment = model.segments.length === 1 ? model.segments[0] : null;
  const sameVersion = versionBaseline === versionCurrent;
  const baseDocs = docsText(docsBase);
  const curDocs = docsText(docsCur);
  const docsLine = baseDocs || curDocs ? `Docs ${baseDocs ?? "unlabeled"} → ${curDocs ?? "unlabeled"}` : null;
  // When no pair has a deep audit, say so once instead of tagging every cell.
  const allUnaudited = model.pairs.length > 0 && model.unauditedPairs === model.pairs.length;
  const legend = {
    changes: model.changes.length > 0,
    unscored: model.segments.some((segment) => segment.rows.some((row) => row.change === "unscored")),
    promptMismatch: includePromptChanges && model.promptChanged > 0,
    excluded: model.definitionChangedPairs > 0,
    unaudited: model.unauditedPairs > 0 && !allUnaudited,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Compare versions"
        meta={singleSegment ? <SegmentMeta segment={singleSegment} /> : undefined}
        actions={(
          <div className="flex w-full flex-col items-stretch gap-1.5 sm:w-auto sm:items-end">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-full sm:w-56">
                <VersionCombobox
                  prefix="Baseline"
                  value={versionBaseline}
                  options={versions}
                  onChange={(value) => setVersion("b", value)}
                  ariaLabel="Baseline version"
                />
              </div>
              <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 text-fg-faint sm:block" aria-hidden />
              <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
                <VersionCombobox
                  prefix="Current"
                  value={versionCurrent}
                  options={versions}
                  onChange={(value) => setVersion("a", value)}
                  ariaLabel="Current version"
                />
              </div>
              <button
                type="button"
                onClick={swap}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-rule text-fg-muted hover:bg-surface hover:text-foreground"
                aria-label="Swap baseline and current"
                title="Swap baseline and current"
              >
                <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
            {docsLine && <p className="text-[12px] text-fg-faint">{docsLine}</p>}
          </div>
        )}
      />

      {model.promptChanged > 0 && (
        <PromptDifferenceNotice
          count={model.promptChanged}
          enabled={includePromptChanges}
          onChange={setIncludePromptChanges}
        />
      )}

      {model.pairs.length > 0 && (
        <p className="text-[15px] text-foreground">
          {sameVersion ? (
            versions.length < 2
              ? <>There&apos;s only one version so far, so both sides show <span className="font-semibold">{currentName}</span>.</>
              : <>Both sides show <span className="font-semibold">{currentName}</span>. Pick a different baseline to see changes.</>
          ) : model.changes.length === 0 ? (
            <><span className="font-semibold">No changes</span> since {baselineName}.</>
          ) : (
            <>
              <span className="font-semibold">
                {regressed > 0 && `${plural(regressed, "cell")} regressed`}
                {regressed > 0 && improved > 0 && ", "}
                {improved > 0 && `${regressed > 0 ? improved : plural(improved, "cell")} improved`}
              </span>
              {" "}since {baselineName}.
            </>
          )}
        </p>
      )}

      <KpiStrip items={kpis} />

      {model.changes.length > 0 && (
        <section className="space-y-2">
          <SectionHead title="What changed" count={plural(model.changes.length, "cell")} />
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
            ? "No cells share a prompt. Turn on “Compare different prompts” above to compare them anyway."
            : "No cells to compare for these versions."}
        </div>
      ) : (
        <section className="space-y-8">
          {model.segments.map((segment) => (
            <div key={segment.key} className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <SectionHead
                  title={singleSegment ? "Cells" : `${segment.agentName} · ${segment.modelLabel}`}
                  count={`${plural(segment.tasks.length, "task")} × ${plural(segment.configs.length, "config")}`}
                />
                {!singleSegment && (
                  <span className={cn("text-[12px]", segment.runner ? "text-fg-faint" : "text-warn")}>
                    {segment.runner ? `Runner ${segment.runner}` : "Runner not recorded"}
                  </span>
                )}
              </div>
              {!singleSegment && <KpiStrip items={buildKpis(metricsFromRows(segment.rows))} />}
              <CompareGrid
                segment={segment}
                activeRowKey={activeRowKey}
                onSelectRow={setActiveRowKey}
                showUnaudited={!allUnaudited}
              />
            </div>
          ))}
          <GridLegend {...legend} />
        </section>
      )}

      {activeRow && (
        <div ref={drilldownRef}>
          <DrilldownPanel
            key={activeRow.row.key}
            segmentLabel={activeRow.segment.label}
            row={activeRow.row}
            versionCurrent={currentName}
            versionBaseline={baselineName}
            showAudit={!allUnaudited}
            onClose={() => setActiveRowKey(null)}
          />
        </div>
      )}

      <CompareFootnote
        model={model}
        versionCurrent={currentName}
        versionBaseline={baselineName}
        allUnaudited={allUnaudited}
        showDeltaNote={!sameVersion}
      />
    </div>
  );
}

// What every cell on the page shares when there is a single segment.
function SegmentMeta({ segment }: { segment: Segment }) {
  return (
    <>
      <span>{segment.agentName}</span>
      <MetaDot />
      <span>{segment.modelLabel}</span>
      <MetaDot />
      {segment.runner
        ? <span>Runner {segment.runner}</span>
        : <span className="text-warn">Runner not recorded</span>}
    </>
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
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {count && <span className="text-[12px] text-fg-faint">{count}</span>}
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
      <span className={cn("w-[86px] shrink-0 text-[12px] font-semibold", regressed ? "text-fail" : "text-pass")}>
        {regressed ? "Regressed" : "Improved"}
      </span>
      <span className="min-w-52 text-[13px]">
        <b className="font-semibold text-foreground">{row.taskName}</b>
        <span className="text-fg-muted"> · {row.configLabel}</span>
        {row.promptChanged > 0 && (
          <span className="ml-2 rounded-sm bg-warn-faint px-1.5 py-0.5 text-[11px] font-medium text-warn">
            Prompt Δ
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
          <span className="mx-0.5 text-[11px] text-fg-faint">→</span>
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
          View runs
        </button>
      </span>
    </div>
  );
}

function CompareGrid({
  segment,
  activeRowKey,
  onSelectRow,
  showUnaudited,
}: {
  segment: Segment;
  activeRowKey: string | null;
  onSelectRow: (key: string) => void;
  showUnaudited: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-background">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left text-[12px] font-medium text-fg-faint">Task</th>
              {segment.configs.map((config) => (
                <th key={config.id} className="px-2 py-2 text-center text-[12px] font-medium text-fg-faint" style={{ minWidth: 150 }}>
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
                  <span className="ml-2 text-[12px] tabular-nums text-fg-faint">
                    {plural([...taskRow.byConfig.values()].reduce((sum, row) => sum + row.pairs.length, 0), "pair")}
                  </span>
                </td>
                {segment.configs.map((config) => {
                  const row = taskRow.byConfig.get(config.id);
                  return (
                    <td key={config.id} className="p-0 align-middle">
                      {row ? (
                        <GridCell row={row} active={activeRowKey === row.key} onSelect={() => onSelectRow(row.key)} showUnaudited={showUnaudited} />
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

function GridCell({ row, active, onSelect, showUnaudited }: { row: RowStats; active: boolean; onSelect: () => void; showUnaudited: boolean }) {
  const changed = row.change === "regressed" || row.change === "improved";

  if (row.change === "excluded") {
    return (
      <div
        className="relative flex min-h-11 items-center justify-center gap-1.5 px-2 py-2.5 text-[12px] text-fg-faint"
        title="Grading criteria changed between versions — excluded from comparison"
      >
        excluded
        <span className="absolute right-1.5 top-1 rounded-sm bg-warn-faint px-1 text-[11px] font-medium text-warn">Rubric Δ</span>
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
        <span className="text-[13px] text-fg-muted">{row.cur.total > 0 ? frac(row.cur) : frac(row.base)}</span>
      )}
      {row.promptChanged > 0 && (
        <span
          className="absolute left-1.5 top-1 rounded-sm bg-warn-faint px-1 text-[11px] font-medium text-warn"
          title={promptTitle}
        >
          Prompt Δ{row.promptChanged < row.pairs.length ? ` ${row.promptChanged}` : ""}
        </span>
      )}
      {showUnaudited && row.unaudited > 0 && (
        <span
          className="absolute right-1.5 top-1 rounded-sm bg-foreground/[0.05] px-1 text-[11px] font-medium text-fg-muted"
          title={`${row.unaudited} pair${row.unaudited === 1 ? "" : "s"} without a deep audit — exit-code result only`}
        >
          {row.unaudited} unaudited
        </span>
      )}
    </button>
  );
}

function GridLegend({
  changes,
  unscored,
  promptMismatch,
  excluded,
  unaudited,
}: {
  changes: boolean;
  unscored: boolean;
  promptMismatch: boolean;
  excluded: boolean;
  unaudited: boolean;
}) {
  if (!changes && !unscored && !promptMismatch && !excluded && !unaudited) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-fg-muted">
      {changes && (
        <>
          <span className="inline-flex items-center gap-1.5"><span className="font-bold text-fail" aria-hidden>▼</span> Regressed</span>
          <span className="inline-flex items-center gap-1.5"><span className="font-bold text-pass" aria-hidden>▲</span> Improved</span>
        </>
      )}
      {unscored && (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full border border-dashed border-fg-faint" aria-hidden /> Unscored
        </span>
      )}
      {promptMismatch && (
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded-sm bg-warn-faint px-1 text-[11px] font-medium text-warn">Prompt Δ</span>
          Different prompt, included
        </span>
      )}
      {excluded && (
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded-sm bg-warn-faint px-1 text-[11px] font-medium text-warn">Rubric Δ</span>
          Rubric changed, left out
        </span>
      )}
      {unaudited && (
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded-sm bg-foreground/[0.05] px-1 text-[11px] font-medium text-fg-muted">Unaudited</span>
          Exit code only
        </span>
      )}
    </div>
  );
}

// One quiet paragraph for the bookkeeping: what matched, what was left out.
function CompareFootnote({
  model,
  versionCurrent,
  versionBaseline,
  allUnaudited,
  showDeltaNote,
}: {
  model: CompareModel;
  versionCurrent: string;
  versionBaseline: string;
  allUnaudited: boolean;
  showDeltaNote: boolean;
}) {
  const sentences: string[] = [`${plural(model.matchedPairs, "pair")} matched, ${model.scoredPairs.length} scored.`];
  if (model.promptChanged > 0) {
    sentences.push(model.includePromptChanges
      ? `${model.promptChanged} with a different prompt ${model.promptChanged === 1 ? "is" : "are"} included.`
      : `${model.promptChanged} with a different prompt ${model.promptChanged === 1 ? "is" : "are"} left out.`);
  }
  if (model.definitionChangedPairs > 0) sentences.push(`${model.definitionChangedPairs} left out because the rubric changed.`);
  if (model.unpairedCur > 0) sentences.push(`${model.unpairedCur} only in ${versionCurrent}.`);
  if (model.unpairedBase > 0) sentences.push(`${model.unpairedBase} only in ${versionBaseline}.`);
  if (model.duplicateKeys > 0) sentences.push(`${plural(model.duplicateKeys, "duplicate")} skipped.`);
  if (allUnaudited) sentences.push("No pair has a deep audit, so results come from exit codes.");
  else if (model.unauditedPairs > 0) sentences.push(`${model.unauditedPairs} without a deep audit use the exit code only.`);
  if (showDeltaNote) sentences.push("Deltas are current minus baseline.");

  return <p className="max-w-[75ch] text-[12px] leading-5 text-fg-muted">{sentences.join(" ")}</p>;
}

function DrilldownPanel({
  segmentLabel,
  row,
  versionCurrent,
  versionBaseline,
  showAudit,
  onClose,
}: {
  segmentLabel: string;
  row: RowStats;
  versionCurrent: string;
  versionBaseline: string;
  showAudit: boolean;
  onClose: () => void;
}) {
  const docsRelevant = isDocsRelevant(row);
  return (
    <section className="rounded-lg border border-rule bg-background">
      <div className="flex items-start justify-between gap-4 border-b border-rule px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{row.taskName} · {row.configLabel}</h2>
          <p className="mt-0.5 text-[12px] text-fg-muted">{segmentLabel}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close runs"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
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
                      <div className="mt-0.5 text-[11px] text-warn">Prompt Δ — included with caution</div>
                    )}
                    {pair.definitionChanged && (
                      <div className="mt-0.5 text-[11px] text-warn">Rubric Δ — excluded</div>
                    )}
                  </td>
                  <SessionLinkCell session={pair.base} showAudit={showAudit} />
                  <SessionLinkCell session={pair.cur} showAudit={showAudit} />
                  <PairDeltaCell pair={pair} resultChanged={resultChanged} />
                  {docsRelevant && (
                    <td className="py-3 pr-5 align-top">
                      <div className="text-[11px] text-fg-muted">{docsUsageLabel(pair.base)} → {docsUsageLabel(pair.cur)}</div>
                      {(docsLabel(pair.base) || docsLabel(pair.cur)) && (
                        <div className="mt-1 text-[11px] text-fg-faint">
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
      className={cn("px-3 py-2 text-[12px] font-medium text-fg-faint", className)}
      style={minWidth ? { minWidth } : undefined}
    >
      {children}
    </th>
  );
}

function SessionLinkCell({ session, showAudit }: { session: CompareSession; showAudit: boolean }) {
  return (
    <td className="px-3 py-3 align-top">
      <Link
        href={`/s/${encodeURIComponent(session.id)}`}
        className="group inline-flex items-center gap-1.5 text-[12px] font-medium text-foreground"
        aria-label={`Open ${session.run} (${session.result || "unknown"})`}
      >
        <StatusBadge kind={statusFromResult(session.result, session.passed)} size="sm" />
        <ExternalLink className="h-3 w-3 text-fg-faint group-hover:text-foreground" aria-hidden />
      </Link>
      <div className="mt-1 text-[12px] tabular-nums text-fg-muted">
        {fmtDuration(session.durationSec)} · <RunCost value={session.costUsd} source={session.costSource} />
      </div>
      {showAudit && !session.auditVerdict && (
        <div className="mt-1 text-[12px] text-warn">No deep audit</div>
      )}
    </td>
  );
}

// What moved for one pair; a pair where nothing moved says so once.
function PairDeltaCell({ pair, resultChanged }: { pair: ComparePair; resultChanged: boolean }) {
  const durationDelta = pair.cur.durationSec - pair.base.durationSec;
  const costDelta = pair.cur.costUsd !== null && pair.base.costUsd !== null ? pair.cur.costUsd - pair.base.costUsd : null;
  const lines = [
    durationDelta !== 0 ? { text: fmtSignedDuration(durationDelta), tone: "text-fg-muted" } : null,
    costDelta !== null && Math.abs(costDelta) >= 0.005 ? { text: fmtSignedCost(costDelta), tone: "text-fg-muted" } : null,
    pair.bothScored && resultChanged
      ? { text: pair.cur.passed ? "Improved" : "Regressed", tone: cn("font-medium", pair.cur.passed ? "text-pass" : "text-fail") }
      : null,
  ].filter((line): line is { text: string; tone: string } => line !== null);

  return (
    <td className="px-3 py-3 text-right align-top text-[12px] tabular-nums">
      {lines.length === 0
        ? <span className="text-fg-faint">No change</span>
        : lines.map((line) => <div key={line.text} className={line.tone}>{line.text}</div>)}
    </td>
  );
}
