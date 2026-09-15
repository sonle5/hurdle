"use client";

import { GripVertical } from "lucide-react";
import { Group, Panel, Separator, type PanelSize } from "react-resizable-panels";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { ParsedMessage } from "@/lib/sessions";
import { SessionSidebar } from "@/components/SessionSidebar";
import {
  DEFAULT_TRANSCRIPT_RAIL_WIDTH,
  MAX_TRANSCRIPT_RAIL_WIDTH,
  MIN_TRANSCRIPT_RAIL_WIDTH,
  TRANSCRIPT_RAIL_WIDTH_STORAGE_KEY,
  writeStoredWidth,
} from "@/lib/browser-layout-storage";

export function ResizableSessionShell({
  messages,
  initialRailWidth = DEFAULT_TRANSCRIPT_RAIL_WIDTH,
  children,
}: {
  messages: ParsedMessage[];
  initialRailWidth?: number;
  children: ReactNode;
}) {
  const readyToPersistRef = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      readyToPersistRef.current = true;
    });
    return () => {
      readyToPersistRef.current = false;
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const handleRailResize = useCallback((size: PanelSize) => {
    if (readyToPersistRef.current) {
      writeStoredWidth(TRANSCRIPT_RAIL_WIDTH_STORAGE_KEY, size.inPixels);
    }
  }, []);

  return (
    <Group
      id="session-shell"
      orientation="horizontal"
      resizeTargetMinimumSize={{ fine: 20, coarse: 40 }}
      className="h-screen w-full overflow-hidden bg-canvas text-foreground"
    >
      <Panel
        id="session-transcript-rail"
        defaultSize={initialRailWidth}
        minSize={MIN_TRANSCRIPT_RAIL_WIDTH}
        maxSize={MAX_TRANSCRIPT_RAIL_WIDTH}
        groupResizeBehavior="preserve-pixel-size"
        onResize={handleRailResize}
      >
        <SessionSidebar messages={messages} />
      </Panel>

      <Separator
        id="session-transcript-resizer"
        aria-label="Resize transcript sidebar"
        className="group/resize relative z-40 hidden w-px bg-rule outline-none lg:block hover:bg-foreground/30 focus-visible:bg-foreground/40"
      >
        <span className="pointer-events-none absolute left-1/2 top-1/2 inline-flex h-8 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border border-rule bg-background text-fg-faint opacity-40 shadow-sm transition-opacity group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100">
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
        </span>
      </Separator>

      <Panel id="session-content" minSize="50%" className="min-w-0">
        {children}
      </Panel>
    </Group>
  );
}
