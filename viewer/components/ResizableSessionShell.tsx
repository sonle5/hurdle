"use client";

import type { ReactNode } from "react";
import type { ParsedMessage } from "@/lib/sessions";
import { SessionSidebar } from "@/components/SessionSidebar";
import { ResizableSidebarShell } from "@/components/shell/ResizableSidebarShell";

export function ResizableSessionShell({ messages, initialRailWidth, initialRailCollapsed = false, children }: {
  messages: ParsedMessage[];
  initialRailWidth?: number;
  initialRailCollapsed?: boolean;
  children: ReactNode;
}) {
  return (
    <ResizableSidebarShell
      id="session-shell"
      initialWidth={initialRailWidth}
      initialCollapsed={initialRailCollapsed}
      resizeLabel="Resize transcript sidebar"
      sidebar={(collapsed, onCollapsedChange) => (
        <SessionSidebar messages={messages} collapsed={collapsed} onCollapsedChange={onCollapsedChange} />
      )}
    >
      {children}
    </ResizableSidebarShell>
  );
}
