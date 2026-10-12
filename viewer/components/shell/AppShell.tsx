import { Suspense } from "react";
import { cookies } from "next/headers";
import type { RailFilters } from "./LeftRail";
import { ContextBar } from "./ContextBar";
import { ResizableAppShell } from "./ResizableAppShell";
import { readSidebarLayout } from "@/lib/browser-layout-storage";

// AppShell is a server component; the rail and context bar are clients that
// read URL state directly. The page passes precomputed filter availability +
// label dictionaries so we don't re-query the DB on the client.
export async function AppShell({
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
  const cookieStore = await cookies();
  const layout = readSidebarLayout({ getItem: key => cookieStore.get(key)?.value ?? null }, defaultRailCollapsed);
  return (
    <ResizableAppShell
      filters={filters}
      initialRailWidth={layout.width}
      defaultRailCollapsed={layout.collapsed}
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
