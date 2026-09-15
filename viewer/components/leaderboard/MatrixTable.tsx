"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { PassRateBar } from "@/components/ui/PassRateBar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ExportMenu, type ExportFormat } from "@/components/ui/ExportMenu";
import { MatrixSearch } from "./MatrixSearch";

export type MatrixCell = {
  pass: number;
  total: number;
  avgDurationSec: number;
  avgCostUsd: number;
  topFails?: string[];
};

export type MatrixData = {
  configs: { id: string; label: string }[];
  tasks: { slug: string; label: string; findings?: string }[];
  // grid[`${task}|${config}`] -> cell
  grid: Map<string, MatrixCell>;
};

type SortKey = "name" | "overall" | string; // string ⇒ a config id

function aggregateRow(d: MatrixData, task: string): MatrixCell {
  let pass = 0, total = 0, dur = 0, cost = 0;
  for (const c of d.configs) {
    const cell = d.grid.get(`${task}|${c.id}`);
    if (!cell) continue;
    pass += cell.pass;
    total += cell.total;
    dur += cell.avgDurationSec * cell.total;
    cost += cell.avgCostUsd * cell.total;
  }
  return {
    pass,
    total,
    avgDurationSec: total ? Math.round(dur / total) : 0,
    avgCostUsd: total ? cost / total : 0,
  };
}

function aggregateCol(d: MatrixData, configId: string): MatrixCell {
  let pass = 0, total = 0, dur = 0, cost = 0;
  for (const t of d.tasks) {
    const cell = d.grid.get(`${t.slug}|${configId}`);
    if (!cell) continue;
    pass += cell.pass;
    total += cell.total;
    dur += cell.avgDurationSec * cell.total;
    cost += cell.avgCostUsd * cell.total;
  }
  return {
    pass,
    total,
    avgDurationSec: total ? Math.round(dur / total) : 0,
    avgCostUsd: total ? cost / total : 0,
  };
}

function aggregateAll(d: MatrixData): MatrixCell {
  let pass = 0, total = 0, dur = 0, cost = 0;
  for (const cell of d.grid.values()) {
    pass += cell.pass;
    total += cell.total;
    dur += cell.avgDurationSec * cell.total;
    cost += cell.avgCostUsd * cell.total;
  }
  return {
    pass,
    total,
    avgDurationSec: total ? Math.round(dur / total) : 0,
    avgCostUsd: total ? cost / total : 0,
  };
}

function fmtTime(sec: number) {
  if (sec <= 0) return "—";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function fmtCost(usd: number) {
  if (usd <= 0) return "—";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function MatrixTable({ data }: { data: MatrixData }) {
  const [sortKey, setSortKey] = useState<SortKey>("overall");
  const [sortDesc, setSortDesc] = useState<boolean>(true);
  const [search, setSearch] = useState("");

  const sortedTasks = useMemo(() => {
    const items = [...data.tasks];
    if (sortKey === "name") {
      items.sort((a, b) => a.label.localeCompare(b.label) * (sortDesc ? -1 : 1));
      return items;
    }
    items.sort((a, b) => {
      const va = sortKey === "overall" ? aggregateRow(data, a.slug) : (data.grid.get(`${a.slug}|${sortKey}`) ?? { pass: 0, total: 0, avgDurationSec: 0, avgCostUsd: 0 });
      const vb = sortKey === "overall" ? aggregateRow(data, b.slug) : (data.grid.get(`${b.slug}|${sortKey}`) ?? { pass: 0, total: 0, avgDurationSec: 0, avgCostUsd: 0 });
      const pa = va.total ? va.pass / va.total : -1;
      const pb = vb.total ? vb.pass / vb.total : -1;
      if (pa !== pb) return (pa - pb) * (sortDesc ? -1 : 1);
      return (vb.total - va.total) * (sortDesc ? 1 : -1);
    });
    return items;
  }, [data, sortKey, sortDesc]);

  const visibleTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedTasks;
    return sortedTasks.filter((t) => t.label.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q));
  }, [sortedTasks, search]);

  const colTotals = useMemo(() => {
    const m = new Map<string, MatrixCell>();
    for (const c of data.configs) m.set(c.id, aggregateCol(data, c.id));
    return m;
  }, [data]);

  const grand = useMemo(() => aggregateAll(data), [data]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDesc((v) => !v);
    else { setSortKey(k); setSortDesc(true); }
  };

  if (data.tasks.length === 0 || data.configs.length === 0) {
    return (
      <div className="rounded-lg border border-rule bg-background p-8 text-center text-fg-muted text-sm">
        No data for the current filters.
      </div>
    );
  }

  const handleExport = (fmt: ExportFormat): { mime: string; content: string } => {
    if (fmt === "json") {
      const out = {
        configs: data.configs,
        tasks: data.tasks,
        cells: Object.fromEntries([...data.grid.entries()].map(([k, v]) => [k, v])),
      };
      return { mime: "application/json", content: JSON.stringify(out, null, 2) };
    }
    const headers = ["task"];
    for (const c of data.configs) {
      headers.push(`${c.id}_pass_pct`, `${c.id}_pass`, `${c.id}_total`, `${c.id}_avg_sec`, `${c.id}_avg_cost`);
    }
    headers.push("overall_pass_pct", "overall_pass", "overall_total", "overall_avg_sec", "overall_avg_cost");
    const rows = [headers.join(",")];
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    for (const t of sortedTasks) {
      const rt = aggregateRow(data, t.slug);
      const row: (string | number)[] = [t.slug];
      for (const c of data.configs) {
        const cell = data.grid.get(`${t.slug}|${c.id}`);
        if (!cell || cell.total === 0) row.push("", "", 0, "", "");
        else row.push(
          Math.round((cell.pass / cell.total) * 100),
          cell.pass,
          cell.total,
          cell.avgDurationSec,
          cell.avgCostUsd.toFixed(4),
        );
      }
      if (rt.total === 0) row.push("", "", 0, "", "");
      else row.push(
        Math.round((rt.pass / rt.total) * 100),
        rt.pass,
        rt.total,
        rt.avgDurationSec,
        rt.avgCostUsd.toFixed(4),
      );
      rows.push(row.map(esc).join(","));
    }
    return { mime: "text/csv;charset=utf-8", content: rows.join("\n") };
  };

  return (
    <TooltipProvider delay={120}>
    <div className="rounded-lg border border-rule bg-background overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-rule">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-foreground">Pass rate by task × config</h2>
          <p className="text-[11px] text-fg-faint mt-0.5">
            Click a cell to drill in · hover a colored cell to preview fail reasons · unscored runs excluded.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <MatrixSearch value={search} onChange={setSearch} />
          <span className="text-[10px] tabular-nums text-fg-faint whitespace-nowrap">{grand.total} scored run{grand.total === 1 ? "" : "s"}</span>
          <ExportMenu filenameBase="leaderboard-matrix" onExport={handleExport} />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-surface/60">
              <Th
                onClick={() => toggleSort("name")}
                sortActive={sortKey === "name"}
                sortDesc={sortDesc}
                className="text-left pl-5 sticky left-0 bg-surface/60 z-10"
                style={{ minWidth: 200 }}
              >
                Task
              </Th>
              {data.configs.map((c) => (
                <Th
                  key={c.id}
                  onClick={() => toggleSort(c.id)}
                  sortActive={sortKey === c.id}
                  sortDesc={sortDesc}
                  className="text-right"
                  style={{ minWidth: 140 }}
                >
                  {c.label}
                </Th>
              ))}
              <Th
                onClick={() => toggleSort("overall")}
                sortActive={sortKey === "overall"}
                sortDesc={sortDesc}
                className="text-right pr-5 border-l border-rule bg-surface/60 text-foreground"
                style={{ minWidth: 140 }}
              >
                Overall
              </Th>
            </tr>
          </thead>
          <tbody>
            {visibleTasks.length === 0 && (
              <tr>
                <td colSpan={data.configs.length + 2} className="px-5 py-8 text-center text-fg-muted text-[12px]">
                  No tasks match &ldquo;{search}&rdquo;.
                </td>
              </tr>
            )}
            {visibleTasks.map((t) => {
              const rowTotal = aggregateRow(data, t.slug);
              const taskLinkInner = (
                <>
                  <div className="text-[13px] font-medium text-foreground truncate">{t.label}</div>
                  <div className="text-[10px] text-fg-faint tabular-nums">
                    {rowTotal.total} run{rowTotal.total === 1 ? "" : "s"}
                  </div>
                </>
              );
              const taskLinkClass = "block min-w-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40 focus-visible:rounded-sm -mx-1 px-1";
              return (
                <tr key={t.slug} className="group/row border-t border-rule hover:bg-surface">
                  <td className="pl-5 py-3 sticky left-0 z-10 bg-background group-hover/row:bg-surface">
                    {t.findings && t.findings.trim() ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Link
                              data-row-focus
                              href={`/t/${encodeURIComponent(t.slug)}`}
                              className={taskLinkClass}
                            />
                          }
                        >
                          {taskLinkInner}
                        </TooltipTrigger>
                        <TooltipContent side="right" sideOffset={6} className="max-w-md">
                          <div className="text-left">
                            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] mb-1.5 opacity-60">
                              Findings · {t.label}
                            </div>
                            <p className="text-[11px] leading-snug whitespace-pre-wrap">{t.findings.trim()}</p>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <Link
                        data-row-focus
                        href={`/t/${encodeURIComponent(t.slug)}`}
                        className={taskLinkClass}
                      >
                        {taskLinkInner}
                      </Link>
                    )}
                  </td>
                  {data.configs.map((c) => {
                    const cell = data.grid.get(`${t.slug}|${c.id}`);
                    if (!cell || cell.total === 0) {
                      return <td key={c.id} className="px-3 py-3 align-middle"><span className="block text-right text-fg-faint">—</span></td>;
                    }
                    const href = `/t/${encodeURIComponent(t.slug)}?config=${encodeURIComponent(c.id)}`;
                    const thisPct = Math.round((cell.pass / cell.total) * 100);
                    const bar = (
                      <PassRateBar
                        pct={thisPct}
                        total={cell.total}
                        passCount={cell.pass}
                        sub={`${fmtTime(cell.avgDurationSec)} · ${fmtCost(cell.avgCostUsd)}`}
                      />
                    );
                    const linkClass = "block";
                    const failedCount = cell.total - cell.pass;
                    return (
                      <td key={c.id} className="px-3 py-3 align-middle">
                        {failedCount > 0 ? (
                          <Tooltip>
                            <TooltipTrigger render={<Link href={href} className={linkClass} />}>
                              {bar}
                            </TooltipTrigger>
                            <TooltipContent side="top" sideOffset={6} className="max-w-xs">
                              <div className="text-left">
                                <div className="text-[10px] font-semibold uppercase tracking-[0.08em] mb-1.5 opacity-60">
                                  {failedCount}/{cell.total} failed
                                </div>
                                {cell.topFails && cell.topFails.length > 0 ? (
                                  <ul className="space-y-1 text-[11px] leading-snug">
                                    {cell.topFails.map((f, i) => (
                                      <li key={i}>• {f}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="text-[11px] leading-snug opacity-70">
                                    No failure notes captured. Click to open the failing runs.
                                  </p>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Link href={href} className={linkClass}>{bar}</Link>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 pr-5 py-3 align-middle border-l border-rule bg-surface/60 group-hover/row:bg-surface">
                    {rowTotal.total > 0 ? (
                      <PassRateBar
                        pct={Math.round((rowTotal.pass / rowTotal.total) * 100)}
                        total={rowTotal.total}
                        passCount={rowTotal.pass}
                        sub={`${fmtTime(rowTotal.avgDurationSec)} · ${fmtCost(rowTotal.avgCostUsd)}`}
                        emphasis
                      />
                    ) : (
                      <span className="block text-right text-fg-faint">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-rule bg-surface/60">
              <td className="pl-5 py-3 sticky left-0 bg-surface/60 z-10 text-[12px] font-semibold text-foreground">Overall</td>
              {data.configs.map((c) => {
                const ct = colTotals.get(c.id);
                if (!ct || ct.total === 0) {
                  return <td key={c.id} className="px-3 py-3 text-right text-fg-faint">—</td>;
                }
                return (
                  <td key={c.id} className="px-3 py-3">
                    <PassRateBar
                      pct={Math.round((ct.pass / ct.total) * 100)}
                      total={ct.total}
                      passCount={ct.pass}
                      sub={`${fmtTime(ct.avgDurationSec)} · ${fmtCost(ct.avgCostUsd)}`}
                      emphasis
                    />
                  </td>
                );
              })}
              <td className="px-3 pr-5 py-3 border-l border-rule">
                {grand.total > 0 ? (
                  <PassRateBar
                    pct={Math.round((grand.pass / grand.total) * 100)}
                    total={grand.total}
                    passCount={grand.pass}
                    sub={`${fmtTime(grand.avgDurationSec)} · ${fmtCost(grand.avgCostUsd)}`}
                    emphasis
                  />
                ) : (
                  <span className="block text-right text-fg-faint">—</span>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
    </TooltipProvider>
  );
}

function Th({
  children, className, style, onClick, sortActive, sortDesc,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick: () => void;
  sortActive: boolean;
  sortDesc: boolean;
}) {
  return (
    <th
      className={cn(
        "px-3 py-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-muted select-none cursor-pointer hover:text-foreground",
        className,
      )}
      style={style}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1 justify-end">
        {children}
        {sortActive ? (sortDesc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />) : null}
      </span>
    </th>
  );
}
