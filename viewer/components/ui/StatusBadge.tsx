import { CheckCircle2, CircleDashed, CircleMinus, CircleHelp, RotateCw, XCircle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type StatusKind =
  | "pass"
  | "fail"
  | "incomplete"
  | "pending_audit"
  | "unknown"
  | "needs-testing"
  | "running"
  | "followup";

const TOKEN: Record<StatusKind, {
  label: string;
  icon: LucideIcon | null;
  pill: string;
  dotBg: string;
}> = {
  pass:            { label: "Pass",          icon: CheckCircle2, pill: "border-pass/30 bg-pass-faint text-pass", dotBg: "bg-pass" },
  fail:            { label: "Fail",          icon: XCircle,      pill: "border-fail/30 bg-fail-faint text-fail", dotBg: "bg-fail" },
  incomplete:      { label: "Incomplete",    icon: CircleMinus,  pill: "border-rule bg-surface text-fg-muted",   dotBg: "bg-fg-faint" },
  pending_audit:   { label: "Pending audit", icon: CircleDashed, pill: "border-warn/30 bg-warn-faint text-warn", dotBg: "bg-warn" },
  unknown:         { label: "Unknown",       icon: CircleHelp,   pill: "border-warn/30 bg-warn-faint text-warn", dotBg: "bg-warn" },
  "needs-testing": { label: "Needs testing", icon: CircleDashed, pill: "border-warn/30 bg-warn-faint text-warn", dotBg: "bg-warn" },
  running:         { label: "Running",       icon: null,         pill: "border-info/30 bg-info-faint text-info", dotBg: "bg-info" },
  followup:        { label: "Followup",      icon: RotateCw,     pill: "border-warn/30 bg-warn-faint text-warn", dotBg: "bg-warn" },
};

export function statusFromResult(
  result: string | null | undefined,
  passed: boolean | null | undefined,
): StatusKind {
  if (result === "running") return "running";
  if (result === "needs-testing") return "needs-testing";
  if (result === "pending_audit") return "pending_audit";
  if (result === "unknown") return "unknown";
  if (passed === true) return "pass";
  if (passed === false) return "fail";
  return "incomplete";
}

// Compact pill. `dot` is shown when there isn't horizontal room for the label
// (use it in tight tables; the default with text is preferred when space allows).
export function StatusBadge({
  kind,
  label,
  size = "sm",
  className,
}: {
  kind: StatusKind;
  label?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const t = TOKEN[kind];
  const Icon = t.icon;
  const sizeClass = size === "md" ? "h-6 gap-1.5 px-2 text-xs" : "h-5 gap-1 px-1.5 text-[11px]";
  const iconClass = size === "md" ? "h-3.5 w-3.5" : "h-3 w-3";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-medium leading-none",
        sizeClass,
        t.pill,
        className,
      )}
    >
      {kind === "running" || !Icon ? (
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping", t.dotBg)} />
          <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", t.dotBg)} />
        </span>
      ) : (
        <Icon className={iconClass} aria-hidden />
      )}
      <span>{label ?? t.label}</span>
    </span>
  );
}

// Just the dot. Useful for left-side rails, table-row prefixes, etc.
export function StatusDot({
  kind,
  className,
}: {
  kind: StatusKind;
  className?: string;
}) {
  const t = TOKEN[kind];
  if (kind === "running") {
    return (
      <span className={cn("relative inline-flex h-2 w-2 shrink-0", className)}>
        <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping", t.dotBg)} />
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", t.dotBg)} />
      </span>
    );
  }
  if (kind === "incomplete") {
    return (
      <span
        aria-hidden
        className={cn("inline-block h-2 w-2 shrink-0 rounded-full border border-rule", className)}
      />
    );
  }
  return <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", t.dotBg, className)} />;
}
