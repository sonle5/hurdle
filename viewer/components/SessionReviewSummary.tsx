import { RunCost } from "@/components/RunCost";
import { StatusBadge, type StatusKind } from "@/components/ui/StatusBadge";
type DeterministicOverall = "consistent" | "violated" | "insufficient_evidence" | "not_applicable";
import { cn } from "@/lib/utils";

const DETERMINISTIC_LABEL: Record<DeterministicOverall, string> = {
  consistent: "Consistent",
  violated: "Violated",
  insufficient_evidence: "Insufficient evidence",
  not_applicable: "Not applicable",
};

const DETERMINISTIC_TONE: Record<DeterministicOverall, string> = {
  consistent: "text-pass",
  violated: "text-fail",
  insufficient_evidence: "text-warn",
  not_applicable: "text-fg-muted",
};

const DETERMINISTIC_DESCRIPTION: Record<DeterministicOverall, string> = {
  consistent: "No required deterministic checks failed. This is not a pass verdict.",
  violated: "A required necessary condition failed.",
  insufficient_evidence: "Required evidence is missing or incomplete.",
  not_applicable: "No deterministic checks are registered for this task.",
};

function labelize(value: string | null | undefined): string {
  if (!value) return "Missing";
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatRunStart(value: string): { label: string; title: string; zone: string } {
  const timestamp = new Date(value);
  if (!value || Number.isNaN(timestamp.getTime())) {
    return { label: "Unknown start", title: "Unknown start time", zone: "" };
  }

  const label = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(timestamp);
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
  }).formatToParts(timestamp).find((part) => part.type === "timeZoneName")?.value ?? "";
  const title = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(timestamp);

  return { label, title, zone };
}

function DeterministicStatusLabel({
  label,
  tone,
  description,
}: {
  label: string;
  tone: string;
  description: string;
}) {
  return (
    <span className="group/deterministic relative inline-flex max-w-full">
      <span
        tabIndex={0}
        aria-label={`${label}: ${description}`}
        className={cn(
          "truncate cursor-help rounded-sm outline-none transition-[color,box-shadow]",
          "focus-visible:ring-2 focus-visible:ring-foreground/20",
          tone,
        )}
      >
        {label}
      </span>
      <span
        role="tooltip"
        className="invisible absolute bottom-full left-0 z-50 mb-2 w-56 rounded-md bg-foreground px-3 py-1.5 text-left text-xs font-normal leading-5 text-background opacity-0 shadow-lg transition-[opacity,visibility] duration-150 group-hover/deterministic:visible group-hover/deterministic:opacity-100 group-focus-within/deterministic:visible group-focus-within/deterministic:opacity-100"
      >
        {description}
        <span className="absolute left-4 top-full h-2 w-2 -translate-y-1 rotate-45 rounded-[2px] bg-foreground" aria-hidden />
      </span>
    </span>
  );
}

export function SessionReviewSummary({
  statusKind,
  auditVerdict,
  auditConfidence,
  judgeStatusLabel,
  deterministicOverall,
  deterministicNote,
  startedAt,
  duration,
  toolCalls,
  costUsd,
  costSource,
}: {
  statusKind: StatusKind;
  auditVerdict?: string | null;
  auditConfidence?: string | null;
  judgeStatusLabel?: string | null;
  deterministicOverall?: DeterministicOverall | null;
  deterministicNote?: string;
  startedAt: string;
  duration: string;
  toolCalls: number | null;
  costUsd: number | null;
  costSource?: "reported" | "estimated" | "unavailable";
}) {
  const deterministicLabel = deterministicOverall ? DETERMINISTIC_LABEL[deterministicOverall] : "Not checked";
  const deterministicTone = deterministicOverall ? DETERMINISTIC_TONE[deterministicOverall] : "text-fg-muted";
  const deterministicDescription = deterministicOverall
    ? DETERMINISTIC_DESCRIPTION[deterministicOverall]
    : "Deterministic checks were not run for this session.";
  const runStart = formatRunStart(startedAt);

  return (
    <section className="mb-8 overflow-hidden rounded-lg border border-rule bg-background">
      {/* 2×2 on narrow columns; one row of four, like the Leaderboard KPIs, once the page is wide. */}
      <div className="grid sm:grid-cols-6 @4xl:grid-cols-4">
        <div className="min-w-0 border-b border-rule px-5 py-5 sm:col-span-3 sm:border-r sm:px-6 @4xl:col-span-1 @4xl:border-b-0">
          <div className="meta-label mb-2 whitespace-nowrap">
            Decision
          </div>
          <div className="flex min-h-6 items-center gap-2">
            <StatusBadge kind={statusKind} size="md" />
          </div>
        </div>

        <div className="min-w-0 border-b border-rule px-5 py-5 sm:col-span-3 sm:px-6 @4xl:col-span-1 @4xl:border-b-0 @4xl:border-r">
          <div className="meta-label mb-2 whitespace-nowrap">
            Judge
          </div>
          <div className="truncate text-base font-medium leading-6 text-foreground">{auditVerdict ? labelize(auditVerdict) : judgeStatusLabel ?? "Missing"}</div>
          {auditConfidence && <div className="mt-0.5 text-xs text-fg-muted">{auditConfidence} confidence</div>}
        </div>

        <div className="min-w-0 border-b border-rule px-5 py-5 sm:col-span-3 sm:border-b-0 sm:border-r sm:px-6 @4xl:col-span-1">
          <div className="meta-label mb-2 whitespace-nowrap">
            Deterministic
          </div>
          <div className="text-base font-medium leading-6">
            <DeterministicStatusLabel
              label={deterministicLabel}
              tone={deterministicTone}
              description={deterministicDescription}
            />
          </div>
          {deterministicOverall && (
            <div className="mt-0.5 text-xs text-fg-muted">{deterministicNote ?? "stored evaluation result"}</div>
          )}
        </div>

        <div className="min-w-0 px-5 py-5 sm:col-span-3 sm:px-6 @4xl:col-span-1">
          <div className="meta-label mb-2 whitespace-nowrap">
            Run
          </div>
          <div className="text-base font-medium leading-6 tabular-nums text-foreground" title={runStart.title}>
            {runStart.label}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-fg-muted tabular-nums">
            <span>{runStart.zone && `${runStart.zone} · `}{duration}</span>
            <span>{toolCalls ?? "—"} tools · Agent cost <RunCost value={costUsd} source={costSource} /></span>
          </div>
        </div>
      </div>
    </section>
  );
}
