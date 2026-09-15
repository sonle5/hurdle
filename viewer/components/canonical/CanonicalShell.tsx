import Link from "next/link";
import type { ReactNode } from "react";

export function CanonicalShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas text-foreground">
      <header className="border-b border-rule bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link
            href="/"
            className="flex min-h-10 items-center gap-3 rounded-md pr-3 text-foreground transition-colors hover:text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <span className="font-mono text-sm font-semibold tracking-tight">ae</span>
            <span className="h-4 w-px bg-rule" aria-hidden />
            <span className="text-sm font-medium">Evaluation runs</span>
          </Link>
          <span className="hidden rounded-full border border-rule bg-surface px-2.5 py-1 text-[11px] font-medium text-fg-muted sm:inline-flex">
            Canonical Result Store
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>
    </div>
  );
}
