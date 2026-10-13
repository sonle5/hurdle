import { cn } from "@/lib/utils";

// Three-band color coding for pass-rate:
//   >= 90  → green (pass)
//   50–89  → orange (warn)
//   <  50  → red    (fail)
// The track is one neutral tone for every band, so colour carries only the
// result: the filled length and the number.
const TRACK = "bg-foreground/[0.07]";
function bandFor(pct: number): {
  bar: string;
  text: string;
  trough: string;
} {
  if (pct >= 90) return { bar: "bg-pass", text: "text-pass", trough: TRACK };
  if (pct >= 50) return { bar: "bg-warn", text: "text-warn", trough: TRACK };
  return            { bar: "bg-fail", text: "text-fail", trough: TRACK };
}

export function PassRateBar({
  pct,
  total,
  passCount,
  sub,
  compact = false,
  showNumber = true,
  emphasis = false,
  delta = null,
  className,
}: {
  pct: number;
  total?: number;
  passCount?: number;
  sub?: string;            // optional second line (e.g. "2m 30s · $0.51")
  compact?: boolean;       // shorter bar height + no sub
  showNumber?: boolean;
  emphasis?: boolean;      // bumps the % number weight — used for totals rows/cols
  delta?: number | null;   // pts vs baseline; null hides the chip
  className?: string;
}) {
  const safePct = Math.max(0, Math.min(100, pct));
  const band = bandFor(safePct);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-2">
        <div className={cn("relative w-full overflow-hidden rounded-full", band.trough, compact ? "h-1" : "h-1.5")}>
          <div
            className={cn("h-full rounded-full", band.bar)}
            style={{ width: `${safePct}%` }}
            aria-hidden
          />
        </div>
        {showNumber && (
          <span className={cn("shrink-0 text-xs tabular-nums w-9 text-right", emphasis ? "font-semibold" : "font-medium", band.text)}>
            {safePct}%
          </span>
        )}
      </div>
      {!compact && (sub || typeof passCount === "number" || delta !== null) && (
        <div className={cn("flex items-center justify-between text-[11px] tabular-nums leading-none", emphasis ? "text-fg-muted" : "text-fg-faint")}>
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="truncate">{sub ?? ""}</span>
            {delta !== null && <DeltaChip pts={delta} />}
          </span>
          {typeof passCount === "number" && typeof total === "number" && (
            <span>{passCount}/{total}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Pts-vs-baseline chip. `+5` green · `-3` red · `0` neutral. */
export function DeltaChip({ pts, suffix }: { pts: number; suffix?: string }) {
  const tone = pts > 0 ? "text-pass" : pts < 0 ? "text-fail" : "text-fg-faint";
  const sign = pts > 0 ? "+" : "";
  return (
    <span className={cn("font-medium tabular-nums", tone)}>
      {sign}{pts}{suffix}
    </span>
  );
}

// Just the bar — no number, no sub. For inline use inside dense rows.
export function PassRateMini({ pct, className }: { pct: number; className?: string }) {
  const safePct = Math.max(0, Math.min(100, pct));
  const band = bandFor(safePct);
  return (
    <div className={cn("relative h-1 w-12 overflow-hidden rounded-full", band.trough, className)}>
      <div className={cn("h-full rounded-full", band.bar)} style={{ width: `${safePct}%` }} aria-hidden />
    </div>
  );
}
