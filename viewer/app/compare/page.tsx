import { Suspense } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { CompareView, type CompareSession } from "@/components/compare/CompareView";
import {
  getAllSessions,
  getDefaultEvalVersionId,
  getPreviousComparableVersion,
  getVersions,
  isWeeklyEvalVersion,
  type EvalVersionOption,
  type SessionSummary,
} from "@/lib/queries";
import { formatModel } from "@/lib/utils";
import { evalVersionDisplayNameById } from "@/lib/version-display";

export const dynamic = "force-dynamic";

const AGENT_LABEL: Record<string, string> = {
  CC: "Claude Code",
  CDX: "Codex",
  OC: "OpenCode",
  Pi:  "Pi",
};

function resolveRequestedVersion(requested: string | undefined, versions: EvalVersionOption[]): string | null {
  const latestWeekly = versions.find(isWeeklyEvalVersion)?.id ?? null;

  let candidate = requested;
  if (candidate === "local" || candidate === "local-sweep") {
    candidate = latestWeekly ?? undefined;
  } else if (candidate?.startsWith("local-") && /^local-\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    const bareDate = candidate.slice("local-".length);
    candidate = versions.some((version) => version.id === bareDate) ? bareDate : (latestWeekly ?? undefined);
  }

  if (candidate && versions.some((version) => version.id === candidate)) return candidate;
  return getDefaultEvalVersionId(versions);
}

function previousById(versionId: string, versions: EvalVersionOption[]): string | null {
  const index = versions.findIndex((version) => version.id === versionId);
  return index >= 0 ? versions[index + 1]?.id ?? null : null;
}

function serializeSession(session: SessionSummary): CompareSession {
  return {
    id: session.id,
    version: session.version,
    run: session.run,
    agent: session.agent,
    agentName: session.agentName,
    model: session.model,
    modelResolved: session.modelResolved,
    configId: session.configId,
    configLabel: session.configLabel,
    configDir: session.configDir,
    task: session.task,
    taskName: session.taskName,
    durationSec: session.durationSec,
    passed: session.passed,
    result: session.result,
    rawResult: session.rawResult,
    auditVerdict: session.auditVerdict,
    costUsd: session.costUsd,
    mcpCalls: session.mcpCalls,
    mcpMethods: session.mcpMethods,
    toolVersions: session.toolVersions,
    prompt: session.prompt,
    gradingCriteria: session.gradingCriteria,
    snapshotFingerprint: session.snapshotFingerprint,
  };
}

function buildRailFilters({
  versions,
  sessions,
  currentVersion,
  params,
}: {
  versions: EvalVersionOption[];
  sessions: SessionSummary[];
  currentVersion: string;
  params: { agent?: string; harness?: string; model?: string; config?: string; task?: string; run?: string; category?: string };
}) {
  const agentCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const modelResolvedByAlias = new Map<string, string | null>();
  const configCounts = new Map<string, { label: string; count: number }>();
  const taskCounts = new Map<string, number>();
  const runCounts = new Map<string, number>();

  for (const session of sessions) {
    agentCounts.set(session.agent, (agentCounts.get(session.agent) ?? 0) + 1);
    modelCounts.set(session.model ?? "", (modelCounts.get(session.model ?? "") ?? 0) + 1);
    if (!modelResolvedByAlias.has(session.model ?? "")) modelResolvedByAlias.set(session.model ?? "", session.modelResolved ?? null);
    const config = configCounts.get(session.configId) ?? { label: session.configLabel, count: 0 };
    config.count += 1;
    configCounts.set(session.configId, config);
    taskCounts.set(session.task, (taskCounts.get(session.task) ?? 0) + 1);
    runCounts.set(session.run, (runCounts.get(session.run) ?? 0) + 1);
  }

  return {
    versions,
    agents: [...agentCounts.entries()]
      .map(([slug, count]) => ({ slug, label: AGENT_LABEL[slug] ?? slug, count }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    models: [...modelCounts.entries()]
      .map(([id, count]) => ({ id, label: formatModel(id, modelResolvedByAlias.get(id)) ?? "(legacy)", count }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    configs: [...configCounts.entries()]
      .map(([id, { label, count }]) => ({ id, label, count }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    tasks: [...taskCounts.entries()]
      .map(([slug, count]) => ({ slug, label: slug, count, cli: /^cli:|-cli$/.test(slug) })),
    runs: [...runCounts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    current: {
      version: currentVersion,
      agent: (params.agent || params.harness) ?? "all",
      model: params.model ?? "all",
      config: params.config ?? "all",
      task: params.task ?? "all",
      run: params.run ?? "all",
      category: (params.category as "all" | "general" | "cli") ?? "all",
    },
  };
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string; v?: string; agent?: string; harness?: string; model?: string; config?: string; task?: string; run?: string; category?: string }>;
}) {
  const params = await searchParams;
  let versions: EvalVersionOption[] = [];
  try { versions = await getVersions(); } catch {}

  const versionA = resolveRequestedVersion(params.a || params.v, versions);
  let previousComparable: Awaited<ReturnType<typeof getPreviousComparableVersion>> = null;
  if (versionA) previousComparable = await getPreviousComparableVersion(versionA);

  const versionB =
    params.b && versions.some((version) => version.id === params.b)
      ? params.b
      : previousComparable?.id ?? (versionA ? previousById(versionA, versions) : null) ?? versionA;

  let sessionsA: SessionSummary[] = [];
  let sessionsB: SessionSummary[] = [];
  if (versionA) {
    [sessionsA, sessionsB] = await Promise.all([
      getAllSessions(versionA),
      versionB ? getAllSessions(versionB) : Promise.resolve([]),
    ]);
  }

  const filters = buildRailFilters({
    versions,
    sessions: sessionsA,
    currentVersion: versionA ?? "",
    params,
  });
  const taskLabel = Object.fromEntries(filters.tasks.map((task) => [task.slug, task.label]));
  const versionALabel = evalVersionDisplayNameById(versions, versionA);
  const versionBLabel = evalVersionDisplayNameById(versions, versionB);

  return (
    <AppShell
      filters={filters}
      versionLabel={versionA && versionB ? `${versionBLabel} → ${versionALabel}` : versionALabel || undefined}
      agentLabel={AGENT_LABEL}
      taskLabel={taskLabel}
    >
      <Suspense>
        {versionA && versionB ? (
          <CompareView
            versions={versions}
            versionCurrent={versionA}
            versionBaseline={versionB}
            sessionsCurrent={sessionsA.map(serializeSession)}
            sessionsBaseline={sessionsB.map(serializeSession)}
          />
        ) : (
          <div className="rounded-lg border border-rule bg-background p-8 text-center text-sm text-fg-muted">
            No eval versions are available to compare.
          </div>
        )}
      </Suspense>
    </AppShell>
  );
}
