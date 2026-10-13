import { cn } from "@/lib/utils";

export type Kpi = {
  label: string;
  value: string;
  sub?: string;
  tone?: "pass" | "fail" | "warn" | "neutral";
  delta?: {
    label: string;
    tone?: "pass" | "fail" | "warn" | "neutral";
    title?: string;
  };
};

const TONE_TEXT: Record<NonNullable<Kpi["tone"]>, string> = {
  pass: "text-pass",
  fail: "text-fail",
  warn: "text-warn",
  neutral: "text-foreground",
};

export function KpiStrip({ items, className }: { items: Kpi[]; className?: string }) {
  if (items.length === 0) return null;
  // Cells are bg-background; the parent uses `gap-px bg-rule` so the gap pixels
  // act as dividers — works cleanly across all grid breakpoints with no
  // per-cell border math.
  const cols =
    items.length === 1 ? "grid-cols-1" :
    items.length === 2 ? "grid-cols-2" :
    items.length === 3 ? "grid-cols-3" :
    items.length === 4 ? "grid-cols-2 md:grid-cols-4" :
    items.length === 5 ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" :
    "grid-cols-2 md:grid-cols-4";
  return (
    <div
      className={cn(
        "rounded-lg border border-rule overflow-hidden bg-rule",
        className,
      )}
    >
      <div className={cn("grid gap-px", cols)}>
        {items.map((k) => (
          <div key={k.label} className="bg-background px-5 py-4 flex flex-col gap-1.5">
            <span className="meta-label">{k.label}</span>
            <span className={cn("text-2xl font-semibold tracking-[-0.025em] tabular-nums leading-7", TONE_TEXT[k.tone ?? "neutral"])}>
              {k.value}
            </span>
            {k.sub && <span className="-mt-0.5 text-[12px] text-fg-faint tabular-nums">{k.sub}</span>}
            {k.delta && (
              <span
                title={k.delta.title}
                className={cn("-mt-0.5 text-[12px] font-medium tabular-nums", TONE_TEXT[k.delta.tone ?? "neutral"])}
              >
                {k.delta.label}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Three-band color coding for pass-rate, matching PassRateBar:
//   >= 90 → pass (green) · 50–89 → warn (orange) · < 50 → fail (red)
export function tonePassRate(pct: number): Kpi["tone"] {
  if (pct >= 90) return "pass";
  if (pct >= 50) return "warn";
  return "fail";
}
