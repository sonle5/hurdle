import type { ReactNode } from "react";
import { Brand } from "@/components/shell/Brand";

export function CanonicalShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas text-foreground">
      <header className="border-b border-rule bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex min-h-10 items-center gap-3">
            <Brand />
            <span className="h-4 w-px bg-rule" aria-hidden />
            <span className="text-sm font-medium text-fg-muted">Results Viewer</span>
          </div>
          <span className="hidden rounded-full bg-foreground/[0.05] px-2.5 py-1 text-[12px] font-medium text-fg-muted sm:inline-flex">
            Read only
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>
    </div>
  );
}
