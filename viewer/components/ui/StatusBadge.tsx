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
  glyph: string;
  ring: string;
  text: string;
  dotBg: string;
}> = {
  pass:            { label: "Pass",          glyph: "✓",  ring: "border-pass/40",  text: "text-pass",  dotBg: "bg-pass" },
  fail:            { label: "Fail",          glyph: "✗",  ring: "border-fail/40",  text: "text-fail",  dotBg: "bg-fail" },
  incomplete:      { label: "Incomplete",    glyph: "—",  ring: "border-rule",     text: "text-fg-muted", dotBg: "bg-fg-faint" },
  pending_audit:   { label: "Pending audit", glyph: "◐",  ring: "border-warn/40",  text: "text-warn",  dotBg: "bg-warn" },
  unknown:          { label: "Unknown",       glyph: "?",  ring: "border-warn/40",  text: "text-warn",  dotBg: "bg-warn" },
  "needs-testing": { label: "Needs testing", glyph: "◐",  ring: "border-warn/40",  text: "text-warn",  dotBg: "bg-warn" },
  running:         { label: "Running",       glyph: "●",  ring: "border-info/40",  text: "text-info",  dotBg: "bg-info" },
  followup:        { label: "Followup",      glyph: "↻",  ring: "border-warn/40",  text: "text-warn",  dotBg: "bg-warn" },
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
  const sizeClass =
    size === "md"
      ? "h-6 px-2 text-xs"
      : "h-5 px-1.5 text-[10px] tracking-wide uppercase";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border bg-transparent font-medium",
        sizeClass,
        t.ring,
        t.text,
        className,
      )}
    >
      {kind === "running" ? (
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping", t.dotBg)} />
          <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", t.dotBg)} />
        </span>
      ) : (
        <span aria-hidden className="leading-none">{t.glyph}</span>
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
