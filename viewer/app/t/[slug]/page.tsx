import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { TaskHero } from "@/components/task/TaskHero";
import { KpiStrip, tonePassRate } from "@/components/leaderboard/KpiStrip";
import { MetricComparison, type ConfigSummary } from "@/components/task/MetricComparison";
import { RunsByConfig } from "@/components/task/RunsByConfig";
import { TaskFindings } from "@/components/task/TaskFindings";
import { TaskKeyboard } from "@/components/task/TaskKeyboard";
import { type RunRowData } from "@/components/leaderboard/RunRow";
import { getAllSessions, getDefaultEvalVersionId, getTaskFindings, getVersions } from "@/lib/queries";
import { formatModel } from "@/lib/utils";
import { evalVersionDisplayNameById } from "@/lib/version-display";

export const dynamic = "force-dynamic";

const AGENT_LABEL: Record<string, string> = { CC: "Claude Code", CDX: "Codex", OC: "OpenCode", Pi: "Pi" };

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

// Aggregate a list of sessions into per-config metrics. Pure so the "all models"
// view can call it once per model without blending pass-rates across models.
function buildConfigs(
  list: Awaited<ReturnType<typeof getAllSessions>>,
  configHighlight: string | null,
): ConfigSummary[] {
  type Accum = {
    label: string; pass: number; total: number;
    durTotal: number; durN: number; costTotal: number; costN: number;
    toolTotal: number; toolN: number;
    tokTotal: number; tokN: number; hallu: number; mcpCalls: number; skills: Set<string>;
  };
  const byConfig = new Map<string, Accum>();
  for (const s of list) {
    if (s.result === "running") continue;
    const scored = isScoredResult(s.result);
    const a = byConfig.get(s.configId) ?? {
      label: s.configLabel, pass: 0, total: 0,
      durTotal: 0, durN: 0, costTotal: 0, costN: 0,
      toolTotal: 0, toolN: 0,
      tokTotal: 0, tokN: 0, hallu: 0, mcpCalls: 0, skills: new Set<string>(),
    };
    if (scored) {
      a.total += 1;
      if (s.passed === true) a.pass += 1;
      if (s.durationSec > 0) { a.durTotal += s.durationSec; a.durN += 1; }
      if (s.costUsd !== null && s.costUsd >= 0) { a.costTotal += s.costUsd; a.costN += 1; }
      if (s.toolCalls != null) { a.toolTotal += s.toolCalls; a.toolN += 1; }
      if (s.totalTokens !== null) { a.tokTotal += s.totalTokens; a.tokN += 1; }
      a.mcpCalls += s.mcpCalls || 0;
      for (const sk of s.injectedSkills || []) a.skills.add(sk);
    }
    byConfig.set(s.configId, a);
  }
  const configs: ConfigSummary[] = [...byConfig.entries()]
    .map(([id, a]) => ({
      id, label: a.label, total: a.total, pass: a.pass,
      avgDurationSec: a.durN ? Math.round(a.durTotal / a.durN) : 0,
      avgCostUsd: a.costN ? a.costTotal / a.costN : 0,
      avgToolCalls: a.toolN ? a.toolTotal / a.toolN : null,
      avgTokens: a.tokN ? Math.round(a.tokTotal / a.tokN) : null,
      hallu: 0, mcpCalls: a.mcpCalls, skillsInjected: a.skills.size, hallucinations: a.hallu,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (configHighlight) {
    const idx = configs.findIndex((c) => c.id === configHighlight);
    if (idx > 0) { const [c] = configs.splice(idx, 1); configs.unshift(c); }
  }
  return configs;
}

// Summary KPIs for the hero / per-model sections. Pending audit, unknown, and
// running rows stay visible as runs, but are excluded from scored pass-rate and
// averages.
function buildHeroKpi(list: Awaited<ReturnType<typeof getAllSessions>>) {
  let runs = 0, total = 0, pass = 0, pendingAudit = 0, unknown = 0, running = 0, durSum = 0, durN = 0, costSum = 0, costN = 0;
  for (const s of list) {
    runs++;
    if (s.result === "pending_audit") pendingAudit++;
    if (s.result === "unknown") unknown++;
    if (s.result === "running") running++;
    if (!isScoredResult(s.result)) continue;
    total++;
    if (s.passed === true) pass++;
    if (s.durationSec > 0) { durSum += s.durationSec; durN++; }
    if (s.costUsd !== null && s.costUsd >= 0) { costSum += s.costUsd; costN++; }
  }
  return { runs, total, pass, pendingAudit, unknown, running, avgDuration: durN ? Math.round(durSum / durN) : 0, avgCost: costN ? costSum / costN : 0 };
}

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ v?: string; agent?: string; harness?: string; model?: string; config?: string; run?: string }>;
}) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const sp = await searchParams;

  // Resolve version (same logic as home).
  let dbVersions: { id: string; name: string; description: string | null; model?: string | null; ccVersion?: string | null }[] = [];
  try { dbVersions = await getVersions(); } catch {}
  const versionId = sp.v && dbVersions.some((v) => v.id === sp.v)
    ? sp.v
    : getDefaultEvalVersionId(dbVersions);

  if (!versionId) notFound();

  const [allSessions, taskFindings] = await Promise.all([
    getAllSessions(versionId),
    getTaskFindings(versionId),
  ]);

  const taskMeta = taskFindings.find((t) => t.slug === slug);
  const sessions = allSessions.filter((s) => s.task === slug);
  if (sessions.length === 0) notFound();

  // Filter by URL agent/run if set — config stays a column axis here.
  const agentFilter = sp.agent || sp.harness || "all";
  const runFilter = sp.run || "all";
  const configHighlight = sp.config || null;
  // Match the home leaderboard: a bare URL shows separately scored model
  // sections, while an explicit query selects one model.
  const modelFilter = sp.model ?? "all";

  const filtered = sessions.filter((s) => {
    if (agentFilter !== "all" && s.agent !== agentFilter) return false;
    if (runFilter !== "all" && s.run !== runFilter) return false;
    if (modelFilter !== "all" && (s.model ?? "") !== modelFilter) return false;
    return true;
  });

  // Hero KPIs (all-up; shown only in single-model mode — see below).
  const heroKpi = buildHeroKpi(filtered);

  // Per-config metrics. The union list drives the run-row groups below; in "all
  // models" mode both the metrics AND the section KPIs split per model so nothing
  // is blended. Each section tracks the resolved version for a specific header.
  const allConfigs = buildConfigs(filtered, configHighlight);
  // Map alias → resolved version across ALL sessions (so the rail filter labels
  // cover every model, even ones excluded by the current agent/run filter).
  const resolvedByAlias = new Map<string, string | null>();
  for (const s of allSessions) { const a = s.model ?? ""; if (!resolvedByAlias.has(a)) resolvedByAlias.set(a, s.modelResolved ?? null); }
  const presentModels = [...resolvedByAlias.keys()].sort();
  const isSplit = modelFilter === "all" && presentModels.length > 1;
  const metricSections = isSplit
    ? presentModels.map((m) => {
        const list = filtered.filter((s) => (s.model ?? "") === m);
        return {
          model: m as string | null,
          modelResolved: resolvedByAlias.get(m) ?? null,
          configs: buildConfigs(list, configHighlight),
          kpi: buildHeroKpi(list),
        };
      })
    : [{ model: null as string | null, modelResolved: null, configs: allConfigs, kpi: heroKpi }];

  // Runs grouped by config.
  const groups = allConfigs.map((c) => ({
    configId: c.id,
    configLabel: c.label,
    runs: filtered
      .filter((s) => s.configId === c.id)
      .sort((a, b) => (a.run || "").localeCompare(b.run || ""))
      .map<RunRowData>((s) => ({
        id: s.id,
        agent: s.agent as "CC" | "Pi" | "CDX" | "OC",
        agentLabel: AGENT_LABEL[s.agent] ?? s.agent,
        model: s.model,
        modelResolved: s.modelResolved,
        configId: s.configId,
        configLabel: s.configLabel,
        task: s.task,
        run: s.run,
        result: s.result,
        passed: s.passed,
        durationSec: s.durationSec,
        toolCalls: s.toolCalls,
        totalTokens: s.totalTokens,
        tokenUsage: s.tokenUsage,
        costUsd: s.costUsd,
        costSource: s.costSource,
        createdAt: s.createdAt.toISOString(),
        needsFollowup: s.needsFollowup,
        manualOverride: s.manualOverride ? { reason: s.manualOverride.reason } : null,
        docsCandidateCount: s.docsCandidateCount,
        docsCandidateStatuses: s.docsCandidateStatuses,
      })),
  }));

  // Rail filter data — same shape as home but task is locked to this slug.
  const agentCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const configCounts = new Map<string, { label: string; count: number }>();
  const taskCounts = new Map<string, number>();
  const runCounts = new Map<string, number>();
  for (const s of allSessions) {
    agentCounts.set(s.agent, (agentCounts.get(s.agent) ?? 0) + 1);
    modelCounts.set(s.model ?? "", (modelCounts.get(s.model ?? "") ?? 0) + 1);
    const c = configCounts.get(s.configId) ?? { label: s.configLabel, count: 0 };
    c.count += 1; configCounts.set(s.configId, c);
    taskCounts.set(s.task, (taskCounts.get(s.task) ?? 0) + 1);
    if (s.run) runCounts.set(s.run, (runCounts.get(s.run) ?? 0) + 1);
  }

  const filters = {
    versions: dbVersions,
    agents: [...agentCounts.entries()]
      .map(([slugAgt, count]) => ({ slug: slugAgt, label: AGENT_LABEL[slugAgt] ?? slugAgt, count }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    models: [...modelCounts.entries()]
      .map(([id, count]) => ({ id, label: formatModel(id, resolvedByAlias.get(id)) ?? "(legacy)", count }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    configs: [...configCounts.entries()]
      .map(([id, { label, count }]) => ({ id, label, count }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    tasks: [...taskCounts.entries()]
      .map(([s, count]) => ({ slug: s, label: s, count, cli: /^cli:|-cli$/.test(s) })),
    runs: [...runCounts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    current: {
      version: versionId,
      agent: agentFilter,
      model: modelFilter,
      config: configHighlight ?? "all",
      task: slug,
      run: runFilter,
      category: "all" as const,
    },
  };

  const taskLabel = Object.fromEntries(filters.tasks.map((t) => [t.slug, t.label]));

  return (
    <AppShell
      filters={filters}
      versionLabel={evalVersionDisplayNameById(dbVersions, versionId)}
      agentLabel={AGENT_LABEL}
      taskLabel={taskLabel}
    >
      <Suspense>
        <div className="space-y-6">
          <TaskHero
            slug={slug}
            prompt={taskMeta?.prompt}
            total={heroKpi.total}
            runs={heroKpi.runs}
            pass={heroKpi.pass}
            excluded={heroKpi.pendingAudit + heroKpi.unknown + heroKpi.running}
            avgDuration={heroKpi.avgDuration}
            avgCost={heroKpi.avgCost}
            showKpis={!isSplit}
          />
          <TaskFindings findings={taskMeta?.findings} />
          {metricSections.map(({ model, modelResolved, configs, kpi }) => (
            <div key={model ?? "_single"} className="space-y-3">
              {model !== null && (
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-muted">
                  {formatModel(model, modelResolved) ?? "(legacy)"}
                </h2>
              )}
              {isSplit && (
                <KpiStrip
                  items={[
                    { label: "Runs", value: kpi.runs.toString(), sub: excludedSub(kpi) },
                    { label: "Pass rate", value: `${kpi.total > 0 ? Math.round((kpi.pass / kpi.total) * 100) : 0}%`, sub: `${kpi.pass} of ${kpi.total} scored`, tone: tonePassRate(kpi.total > 0 ? Math.round((kpi.pass / kpi.total) * 100) : 0) },
                    { label: "Avg duration", value: kpi.avgDuration > 0 ? `${Math.floor(kpi.avgDuration / 60)}m ${kpi.avgDuration % 60}s` : "—" },
                    { label: "Avg agent cost", value: kpi.avgCost > 0 ? `$${kpi.avgCost.toFixed(2)}` : "—" },
                  ]}
                />
              )}
              <MetricComparison configs={configs} />
            </div>
          ))}
          <RunsByConfig groups={groups} taskSlug={slug} />
          <TaskKeyboard />
        </div>
      </Suspense>
    </AppShell>
  );
}
