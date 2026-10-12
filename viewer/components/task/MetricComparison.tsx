"use client";

import { cn } from "@/lib/utils";
import { PassRateMini, DeltaChip } from "@/components/ui/PassRateBar";

const BASELINE_ID = "C1";

export type ConfigSummary = {
  id: string;
  label: string;
  total: number;
  pass: number;
  avgDurationSec: number;
  avgCostUsd: number;
  avgToolCalls: number | null;
  avgTokens: number | null;
  hallucinations: number;     // total models retried/hallucinated across runs
  mcpCalls: number;           // total
  skillsInjected: number;     // unique skills injected (count of distinct)
};

function fmtTime(sec: number) {
  if (sec <= 0) return "—";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function fmtTokens(n: number) {
  if (n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function fmtCost(usd: number) {
  if (usd <= 0) return "—";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

type Metric = {
  key: string;
  label: string;
  // higher == better controls best-of-row highlight + sort
  betterDirection: "higher" | "lower" | "none";
  render: (c: ConfigSummary) => React.ReactNode;
  // raw value for "best in row" comparison
  raw: (c: ConfigSummary) => number;
  // "—" when there's no meaningful value to show
  empty: (c: ConfigSummary) => boolean;
};

function buildMetrics(configs: ConfigSummary[]): Metric[] {
  const baseline = configs.find((c) => c.id === BASELINE_ID);
  const baselinePct = baseline && baseline.total > 0
    ? Math.round((baseline.pass / baseline.total) * 100)
    : null;
  return [
  {
    key: "pass",
    label: "Pass rate",
    betterDirection: "higher",
    render: (c) => {
      if (c.total === 0) return <span className="text-fg-faint">—</span>;
      const pct = Math.round((c.pass / c.total) * 100);
      const delta = (c.id !== BASELINE_ID && baselinePct !== null) ? pct - baselinePct : null;
      return (
        <div className="inline-flex items-center gap-2">
          <PassRateMini pct={pct} />
          <span className="tabular-nums text-[12px] font-medium text-foreground">{pct}%</span>
          <span className="tabular-nums text-[10px] text-fg-faint">{c.pass}/{c.total}</span>
          {delta !== null && <DeltaChip pts={delta} />}
        </div>
      );
    },
    raw: (c) => (c.total ? c.pass / c.total : -1),
    empty: (c) => c.total === 0,
  },
  {
    key: "duration",
    label: "Avg duration",
    betterDirection: "lower",
    render: (c) => <span className="tabular-nums text-[12px] text-foreground">{fmtTime(c.avgDurationSec)}</span>,
    raw: (c) => c.avgDurationSec || Infinity,
    empty: (c) => c.avgDurationSec <= 0,
  },
  {
    key: "tools",
    label: "Avg tool calls",
    betterDirection: "lower",
    render: (c) => <span className="tabular-nums text-[12px] text-foreground">{c.avgToolCalls === null ? "—" : c.avgToolCalls.toFixed(0)}</span>,
    raw: (c) => c.avgToolCalls ?? Infinity,
    empty: (c) => c.avgToolCalls === null,
  },
  {
    key: "tokens",
    label: "Avg agent tokens",
    betterDirection: "lower",
    render: (c) => <span className="tabular-nums text-[12px] text-foreground">{c.avgTokens === null ? "—" : fmtTokens(c.avgTokens)}</span>,
    raw: (c) => c.avgTokens ?? Infinity,
    empty: (c) => c.avgTokens === null,
  },
  {
    key: "cost",
    label: "Avg agent cost",
    betterDirection: "lower",
    render: (c) => <span className="tabular-nums text-[12px] text-foreground">{fmtCost(c.avgCostUsd)}</span>,
    raw: (c) => c.avgCostUsd || Infinity,
    empty: (c) => c.avgCostUsd <= 0,
  },
  {
    key: "hallucinations",
    label: "Hallucinations",
    betterDirection: "lower",
    render: (c) => <span className="tabular-nums text-[12px] text-foreground">{c.hallucinations || 0}</span>,
    raw: (c) => c.hallucinations,
    empty: () => false,
  },
  {
    key: "mcpCalls",
    label: "MCP calls",
    betterDirection: "none",
    render: (c) => <span className="tabular-nums text-[12px] text-foreground">{c.mcpCalls || 0}</span>,
    raw: (c) => c.mcpCalls,
    empty: () => false,
  },
  {
    key: "skills",
    label: "Skills injected",
    betterDirection: "none",
    render: (c) => <span className="tabular-nums text-[12px] text-foreground">{c.skillsInjected || 0}</span>,
    raw: (c) => c.skillsInjected,
    empty: () => false,
  },
  ];
}

function bestIndex(metric: Metric, configs: ConfigSummary[]): number | null {
  if (metric.betterDirection === "none") return null;
  let best: number | null = null;
  let bestVal: number = metric.betterDirection === "higher" ? -Infinity : Infinity;
  configs.forEach((c, i) => {
    if (metric.empty(c)) return;
    const v = metric.raw(c);
    if (metric.betterDirection === "higher" ? v > bestVal : v < bestVal) {
      bestVal = v;
      best = i;
    }
  });
  return best;
}

export function MetricComparison({ configs }: { configs: ConfigSummary[] }) {
  if (configs.length === 0) {
    return (
      <div className="rounded-lg border border-rule bg-background p-8 text-center text-fg-muted text-sm">
        No configs to compare for this task and filter combination.
      </div>
    );
  }
  const METRICS = buildMetrics(configs);
  return (
    <div className="rounded-lg border border-rule bg-background overflow-hidden">
      <div className="px-5 py-3 border-b border-rule">
        <h2 className="text-[13px] font-semibold text-foreground">Config comparison</h2>
        <p className="text-[11px] text-fg-faint mt-0.5">Best value per row marked ↑ — lower is better for duration and agent cost.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-surface/60">
              <th className="text-left px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-muted sticky left-0 bg-surface/60 z-10" style={{ minWidth: 180 }}>
                Metric
              </th>
              {configs.map((c) => (
                <th key={c.id} className="text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-muted" style={{ minWidth: 160 }}>
                  {c.label}
                  <div className="text-[9px] font-normal tabular-nums text-fg-faint normal-case">{c.total} run{c.total === 1 ? "" : "s"}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map((m) => {
              const best = bestIndex(m, configs);
              return (
                <tr key={m.key} className="border-t border-rule">
                  <td className="px-5 py-2.5 sticky left-0 bg-background z-10 text-[12px] text-fg-muted">
                    {m.label}
                  </td>
                  {configs.map((c, i) => (
                    <td key={c.id} className={cn(
                      "px-4 py-2.5",
                      best === i && "bg-pass-faint/40",
                    )}>
                      <div className="inline-flex items-center gap-1.5">
                        {m.render(c)}
                        {best === i && (
                          <span aria-label="best in row" className="text-[10px] text-pass">↑</span>
                        )}
                      </div>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
