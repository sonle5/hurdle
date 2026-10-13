import { KpiStrip, tonePassRate } from "@/components/leaderboard/KpiStrip";
import { PageHeader } from "@/components/shell/PageHeader";
import { formatDuration } from "@/lib/utils";

function fmtTime(sec: number) {
  return sec > 0 ? formatDuration(sec) : "—";
}

export function TaskHero({
  slug,
  prompt,
  total,
  runs = total,
  pass,
  excluded = Math.max(0, runs - total),
  avgDuration,
  avgCost,
  showKpis = true,
}: {
  slug: string;
  prompt?: string;
  total: number;
  runs?: number;
  pass: number;
  excluded?: number;
  avgDuration: number;
  avgCost: number;
  // In "all models" mode the page renders per-model KPIs in each section, so the
  // hero suppresses its own (otherwise-blended) summary.
  showKpis?: boolean;
}) {
  const passPct = total > 0 ? Math.round((pass / total) * 100) : 0;
  return (
    <div className="space-y-6">
      <PageHeader title={slug} description={prompt} />
      {showKpis && (
        <KpiStrip
          items={[
            { label: "Runs", value: runs.toString(), sub: excluded > 0 ? `${excluded} excluded` : undefined },
            { label: "Pass rate", value: `${passPct}%`, sub: `${pass} of ${total} scored`, tone: tonePassRate(passPct) },
            { label: "Avg duration", value: fmtTime(avgDuration) },
            { label: "Avg agent cost", value: avgCost > 0 ? `$${avgCost.toFixed(2)}` : "—" },
          ]}
        />
      )}
    </div>
  );
}
