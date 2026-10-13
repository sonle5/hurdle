import Link from "next/link";
import { cn } from "@/lib/utils";

// The Hurdle mark: a drawn "h" in an ink tile (app/icon.svg, the favicon, uses the same
// paths), followed by the wordmark. Collapsed rails show the tile alone.
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-5 shrink-0", className)}>
      <rect width="32" height="32" rx="8" className="fill-foreground" />
      <path
        d="M11.5 7.5v17M11.5 17c0-2.8 2-4.75 4.6-4.75s4.4 1.95 4.4 4.75v7.5"
        fill="none"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-background"
      />
    </svg>
  );
}

export function Brand({ collapsed = false, className }: { collapsed?: boolean; className?: string }) {
  return (
    <Link
      href="/"
      aria-label={collapsed ? "Hurdle home" : undefined}
      className={cn(
        "inline-flex items-center gap-2 rounded-md text-foreground outline-offset-2 focus-visible:outline-2",
        className,
      )}
    >
      <BrandMark />
      {!collapsed && <span className="text-[15px] font-semibold tracking-[-0.02em]">hurdle</span>}
    </Link>
  );
}
