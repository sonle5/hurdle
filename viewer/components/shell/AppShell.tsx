import { Suspense } from "react";
import type { RailFilters } from "./LeftRail";
import { ContextBar } from "./ContextBar";
import { ResizableAppShell } from "./ResizableAppShell";

// AppShell is a server component; the rail and context bar are clients that
// read URL state directly. The page passes precomputed filter availability +
// label dictionaries so we don't re-query the DB on the client.
export function AppShell({
  filters,
  versionLabel,
  agentLabel,
  taskLabel,
  sessionLabel,
  defaultRailCollapsed = false,
  children,
}: {
  filters: RailFilters;
  versionLabel?: string;
  agentLabel?: Record<string, string>;
  taskLabel?: Record<string, string>;
  sessionLabel?: string;
  defaultRailCollapsed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <ResizableAppShell
      filters={filters}
      defaultRailCollapsed={defaultRailCollapsed}
    >
      <div className="flex-1 min-w-0">
        <div className="px-4 sm:px-6 lg:px-8">
          <Suspense>
            <ContextBar
              versionLabel={versionLabel}
              agentLabel={agentLabel}
              taskLabel={taskLabel}
              sessionLabel={sessionLabel}
            />
          </Suspense>
          <main className="py-6 lg:pl-8">{children}</main>
        </div>
      </div>
    </ResizableAppShell>
  );
}
