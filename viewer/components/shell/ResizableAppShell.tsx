"use client";

import { Suspense, type ReactNode } from "react";
import { LeftRail, type RailFilters } from "./LeftRail";
import { ResizableSidebarShell } from "./ResizableSidebarShell";

export function ResizableAppShell({ filters, initialRailWidth, defaultRailCollapsed = false, children }: {
  filters: RailFilters;
  initialRailWidth?: number;
  defaultRailCollapsed?: boolean;
  children: ReactNode;
}) {
  return (
    <ResizableSidebarShell
      id="app-shell"
      initialWidth={initialRailWidth}
      initialCollapsed={defaultRailCollapsed}
      contentClassName="overflow-y-auto"
      sidebar={(collapsed, onCollapsedChange) => (
        <Suspense>
          <LeftRail filters={filters} collapsed={collapsed} onCollapsedChange={onCollapsedChange} />
        </Suspense>
      )}
    >
      {children}
    </ResizableSidebarShell>
  );
}
