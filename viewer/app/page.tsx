import { Suspense } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { CanonicalShell } from "@/components/canonical/CanonicalShell";
import { Leaderboard, type LeaderboardComparison, type TaskGroup } from "@/components/leaderboard/Leaderboard";
import { getCanonicalDashboardSource } from "@/lib/canonical-dashboard-results.server";
import { getAllSessions, getDefaultEvalVersionId, getPreviousComparableVersion, getTaskFindings, getVersions, isWeeklyEvalVersion, type EvalVersionOption } from "@/lib/queries";
import { formatModel } from "@/lib/utils";
import { evalVersionDisplayNameById } from "@/lib/version-display";

export const dynamic = "force-dynamic";

const AGENT_LABEL: Record<string, string> = {
  CC: "Claude Code",
  CDX: "Codex",
  OC: "OpenCode",
  Pi: "Pi",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ v?: string; agent?: string; harness?: string; model?: string; config?: string; task?: string; run?: string; category?: string }>;
}) {
  const params = await searchParams;
  const canonicalSource = await getCanonicalDashboardSource();
  if (canonicalSource.status === "empty") {
    return (
      <CanonicalShell>
        <div className="mx-auto max-w-xl py-12 text-center sm:py-20">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">
            No runs yet
          </p>
          <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
            This Result Store is empty
          </h1>
          <p className="mx-auto mt-3 max-w-lg text-pretty text-sm leading-6 text-fg-muted">
            The Viewer is reading <code>{canonicalSource.root}</code>, which does not exist yet.
            Run an evaluation to create it, then reload this page.
          </p>
          <pre className="mt-6 overflow-x-auto rounded-xl border border-rule bg-surface p-4 text-left text-xs leading-6 text-foreground">
            <code>npm --prefix harness exec -- tae run examples/copy-message/example.suite.mjs</code>
          </pre>
        </div>
      </CanonicalShell>
    );
  }
  let dbVersions: EvalVersionOption[] = [];
  try { dbVersions = await getVersions(); } catch {}

  const latestWeekly = dbVersions.find(isWeeklyEvalVersion)?.id ?? null;
  const defaultVersion = getDefaultEvalVersionId(dbVersions);
  let requestedVersion: string | undefined = params.v;
  if (requestedVersion === "local" || requestedVersion === "local-sweep") {
    requestedVersion = latestWeekly ?? undefined;
  } else if (requestedVersion?.startsWith("local-") && /^local-\d{4}-\d{2}-\d{2}$/.test(requestedVersion)) {
    const bareDate = requestedVersion.slice("local-".length);
    requestedVersion = dbVersions.some((version) => version.id === bareDate)
      ? bareDate
      : (latestWeekly ?? undefined);
  }
  const versionId = requestedVersion && dbVersions.some((version) => version.id === requestedVersion)
    ? requestedVersion
    : defaultVersion;

  let allSessions: Awaited<ReturnType<typeof getAllSessions>> = [];
  let taskFindingsRows: Awaited<ReturnType<typeof getTaskFindings>> = [];
  let comparisonVersion: Awaited<ReturnType<typeof getPreviousComparableVersion>> = null;
  let comparisonSessions: Awaited<ReturnType<typeof getAllSessions>> = [];
  if (versionId) {
    [allSessions, taskFindingsRows, comparisonVersion] = await Promise.all([
      getAllSessions(versionId),
      getTaskFindings(versionId),
      getPreviousComparableVersion(versionId),
    ]);
    if (comparisonVersion) comparisonSessions = await getAllSessions(comparisonVersion.id);
  }

  const taskFindings: Record<string, string> = {};
  for (const task of taskFindingsRows) {
    if (task.findings) taskFindings[task.slug] = task.findings;
  }

  type SerializedSession = {
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
    corrections: number;
    interactions: number;
    passed: boolean | null;
    result?: string | null;
    createdAt?: string;
    toolCalls: number | null;
    totalTokensIn: number;
    costUsd: number;
    needsFollowup?: boolean;
    followupReason?: string | null;
    failureAnalysis?: unknown;
    failureReview?: unknown;
    manualOverride?: { reason?: string | null } | null;
    docsCandidateCount?: number;
    docsCandidateStatuses?: string[];
    note?: string | null;
  };

  const serialize = (session: Awaited<ReturnType<typeof getAllSessions>>[number]): SerializedSession => ({
    id: session.id,
    version: session.version,
    run: session.run,
    agent: session.agent as SerializedSession["agent"],
    model: session.model,
    modelResolved: session.modelResolved,
    configId: session.configId,
    configLabel: session.configLabel,
    task: session.task,
    durationSec: session.durationSec,
    corrections: session.corrections,
    interactions: 0,
    passed: session.passed,
    result: session.result,
    createdAt: session.createdAt.toISOString(),
    toolCalls: session.toolCalls,
    totalTokensIn: session.totalTokensIn,
    costUsd: session.costUsd,
    needsFollowup: session.needsFollowup,
    followupReason: session.followupReason,
    failureAnalysis: session.failureAnalysis,
    failureReview: session.failureReview,
    manualOverride: session.manualOverride ? { reason: session.manualOverride.reason } : null,
    docsCandidateCount: session.docsCandidateCount,
    docsCandidateStatuses: session.docsCandidateStatuses,
    note: session.note,
  });

  function groupSessions(sessions: Awaited<ReturnType<typeof getAllSessions>>) {
    const order: string[] = [];
    const groups = new Map<string, { sessions: SerializedSession[]; prompt?: string }>();
    const serialized = sessions.map(serialize);
    for (const session of serialized) {
      if (!groups.has(session.task)) {
        groups.set(session.task, { sessions: [] });
        order.push(session.task);
      }
      const group = groups.get(session.task)!;
      group.sessions.push(session);
      if (!group.prompt) {
        group.prompt = sessions.find((candidate) => candidate.id === session.id)?.prompt || undefined;
      }
    }
    return { order, groups, serialized };
  }

  const current = groupSessions(allSessions);
  const taskGroups: TaskGroup[] = current.order.map((task) => ({
    task,
    prompt: current.groups.get(task)!.prompt,
    findings: taskFindings[task],
    sessions: current.groups.get(task)!.sessions,
  }));

  let comparison: LeaderboardComparison | null = null;
  if (comparisonVersion && comparisonSessions.length > 0) {
    const previous = groupSessions(comparisonSessions);
    comparison = {
      versionId: comparisonVersion.id,
      versionName: comparisonVersion.name,
      taskGroups: previous.order.map((task) => ({
        task,
        prompt: previous.groups.get(task)!.prompt,
        sessions: previous.groups.get(task)!.sessions,
      })),
    };
  }

  const agentCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const modelResolvedByAlias = new Map<string, string | null>();
  const configCounts = new Map<string, { label: string; count: number }>();
  const taskCounts = new Map<string, number>();
  const runCounts = new Map<string, number>();
  for (const session of current.serialized) {
    agentCounts.set(session.agent, (agentCounts.get(session.agent) ?? 0) + 1);
    modelCounts.set(session.model ?? "", (modelCounts.get(session.model ?? "") ?? 0) + 1);
    if (!modelResolvedByAlias.has(session.model ?? "")) {
      modelResolvedByAlias.set(session.model ?? "", session.modelResolved ?? null);
    }
    const config = configCounts.get(session.configId) ?? { label: session.configLabel, count: 0 };
    config.count += 1;
    configCounts.set(session.configId, config);
    taskCounts.set(session.task, (taskCounts.get(session.task) ?? 0) + 1);
    if (session.run) runCounts.set(session.run, (runCounts.get(session.run) ?? 0) + 1);
  }

  // A version can contain historical records without a model label alongside
  // newer, explicitly versioned runs. Default to the split view so a bare URL
  // never silently selects that legacy bucket. Leaderboard keeps each model in
  // its own scorecard, so this does not blend their scores.
  const defaultModel = "all";
  const taskSlugs = [...taskCounts.keys()];
  const defaultCategory: "all" | "general" | "cli" =
    taskSlugs.some((slug) => !/^cli:|-cli$/.test(slug)) || !taskSlugs.some((slug) => /^cli:|-cli$/.test(slug))
      ? "general"
      : "cli";

  const filters = {
    versions: dbVersions,
    agents: [...agentCounts.entries()]
      .map(([slug, count]) => ({ slug, label: AGENT_LABEL[slug] ?? slug, count }))
      .sort((left, right) => left.slug.localeCompare(right.slug)),
    models: [...modelCounts.entries()]
      .map(([id, count]) => ({ id, label: formatModel(id, modelResolvedByAlias.get(id)) ?? "(legacy)", count }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    configs: [...configCounts.entries()]
      .map(([id, { label, count }]) => ({ id, label, count }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    tasks: [...taskCounts.entries()]
      .map(([slug, count]) => ({ slug, label: slug, count, cli: /^cli:|-cli$/.test(slug) })),
    runs: [...runCounts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    current: {
      version: versionId ?? "",
      agent: (params.agent || params.harness) ?? "all",
      model: params.model ?? defaultModel,
      config: params.config ?? "all",
      task: params.task ?? "all",
      run: params.run ?? "all",
      category: (params.category as "all" | "general" | "cli") ?? defaultCategory,
    },
  };

  const taskLabel = Object.fromEntries(filters.tasks.map((task) => [task.slug, task.label]));
  const isLocalDated = versionId ? /^\d{4}-\d{2}-\d{2}$/.test(versionId) : false;

  return (
    <AppShell
      filters={filters}
      versionLabel={evalVersionDisplayNameById(dbVersions, versionId) || undefined}
      agentLabel={AGENT_LABEL}
      taskLabel={taskLabel}
    >
      <Suspense>
        <Leaderboard taskGroups={taskGroups} showRecentRuns={isLocalDated} comparison={comparison} />
      </Suspense>
    </AppShell>
  );
}
