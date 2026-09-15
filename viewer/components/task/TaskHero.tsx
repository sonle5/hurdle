import { KpiStrip, tonePassRate } from "@/components/leaderboard/KpiStrip";

function fmtTime(sec: number) {
  if (sec <= 0) return "—";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
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
    <header className="space-y-4">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Task</div>
        <h1 className="mt-1 font-mono text-xl font-semibold tracking-tight text-foreground">{slug}</h1>
        {prompt && (
          <p className="mt-2 max-w-3xl text-[13px] text-fg-muted leading-relaxed">{prompt}</p>
        )}
      </div>
      {showKpis && (
        <KpiStrip
          items={[
            { label: "Runs", value: runs.toString(), sub: excluded > 0 ? `${excluded} excluded` : undefined },
            { label: "Pass rate", value: `${passPct}%`, sub: `${pass} of ${total} scored`, tone: tonePassRate(passPct) },
            { label: "Avg duration", value: fmtTime(avgDuration) },
            { label: "Avg cost", value: avgCost > 0 ? `$${avgCost.toFixed(2)}` : "—" },
          ]}
        />
      )}
    </header>
  );
}
