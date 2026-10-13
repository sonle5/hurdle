import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Brand } from "./Brand";

export type Crumb = { label: string; href?: string };

// One header bar for every page. It is the top edge of the inset panel and
// shares the rail's brand row (y=8–56 on desktop); its content shares the page
// container, so breadcrumbs, page titles and cards start on one left edge.
export function TopBar({
  crumbs,
  versionLabel,
  right,
  children,
}: {
  crumbs: Crumb[];
  versionLabel?: string;
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-30 border-b border-rule bg-background/90 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/80 sm:px-6 lg:px-8">
      <div className="mx-auto flex h-12 w-full max-w-7xl items-center gap-3">
        {/* Without the rail (below lg) the bar carries the brand; phones keep
            only the current page so its name is never truncated to a letter. */}
        <Brand collapsed className="mr-1 lg:hidden" />
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">
          {crumbs.map((crumb, index) => (
            <span
              key={`${index}:${crumb.label}`}
              className={cn("min-w-0 items-center gap-1", index < crumbs.length - 1 ? "hidden sm:inline-flex" : "inline-flex")}
            >
              {index > 0 && <ChevronRight className="hidden h-3 w-3 shrink-0 text-fg-faint sm:block" aria-hidden />}
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="truncate rounded-sm text-[13px] text-fg-muted transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current="page" className="truncate text-[13px] font-medium text-foreground">{crumb.label}</span>
              )}
            </span>
          ))}
          {versionLabel && (
            <span className="ml-2 hidden h-5 shrink-0 items-center rounded-md bg-foreground/[0.05] px-1.5 text-[12px] font-medium text-fg-muted sm:inline-flex">
              {versionLabel}
            </span>
          )}
        </nav>
        <div className="min-w-0 flex-1 overflow-x-auto">{children}</div>
        {right}
      </div>
    </div>
  );
}
