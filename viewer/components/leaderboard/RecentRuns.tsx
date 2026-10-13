import { RunRow, type RunRowData } from "./RunRow";

export function RecentRuns({
  sessions,
  limit = 10,
  className,
}: {
  sessions: RunRowData[];
  limit?: number;
  className?: string;
}) {
  if (sessions.length === 0) return null;

  // Running first; then most recent.
  const sorted = [...sessions].sort((a, b) => {
    const aRunning = a.result === "running" ? 1 : 0;
    const bRunning = b.result === "running" ? 1 : 0;
    if (aRunning !== bRunning) return bRunning - aRunning;
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  }).slice(0, limit);

  return (
    <div className={`rounded-lg border border-rule bg-background overflow-hidden ${className ?? ""}`}>
      <div className="flex items-baseline justify-between px-5 py-3 border-b border-rule">
        <h2 className="text-sm font-semibold text-foreground">Recent runs</h2>
        <span className="text-[12px] tabular-nums text-fg-faint">{Math.min(limit, sessions.length)} of {sessions.length}</span>
      </div>
      <div>
        {sorted.map((s) => <RunRow key={s.id} s={s} />)}
      </div>
    </div>
  );
}
