import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared title block for detail pages (Task, Run, Compare): title, one line
// of context, and actions aligned to the title's first line. The breadcrumbs
// already say what kind of page this is, so pages rarely need an eyebrow.
export function PageHeader({
  eyebrow,
  title,
  description,
  meta,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0 space-y-2">
        {eyebrow && <div className="meta-label">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold leading-8 tracking-[-0.025em] text-balance text-foreground">{title}</h1>
        {description && <p className="max-w-[75ch] text-pretty text-sm leading-6 text-fg-muted">{description}</p>}
        {meta && <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 text-fg-muted">{meta}</div>}
      </div>
      {actions && <div className="flex max-w-full shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

// The quiet separator used in PageHeader meta rows.
export function MetaDot() {
  return <span aria-hidden className="text-fg-faint">·</span>;
}
