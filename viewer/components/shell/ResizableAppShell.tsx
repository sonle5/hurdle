"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import {
  Group,
  Panel,
  Separator,
  usePanelRef,
  type PanelSize,
} from "react-resizable-panels";
import { LeftRail, type RailFilters } from "./LeftRail";
import {
  readStoredBoolean,
  readStoredWidth,
  writeStoredBoolean,
  writeStoredWidth,
} from "@/lib/browser-layout-storage";

const COLLAPSED_RAIL_WIDTH = 56;
const DEFAULT_RAIL_WIDTH = 256;
const MIN_RAIL_WIDTH = 224;
const MAX_RAIL_WIDTH = 384;
const APP_RAIL_WIDTH_STORAGE_KEY = "tae-app-rail-width";
const APP_RAIL_COLLAPSED_STORAGE_KEY = "tae-app-rail-collapsed";

export function ResizableAppShell({
  filters,
  defaultRailCollapsed = false,
  children,
}: {
  filters: RailFilters;
  defaultRailCollapsed?: boolean;
  children: ReactNode;
}) {
  const railRef = usePanelRef();
  const readyToPersistRef = useRef(false);
  const [railCollapsed, setRailCollapsed] = useState(defaultRailCollapsed);

  useEffect(() => {
    const panel = railRef.current;
    if (!panel) return undefined;

    const collapsed = readStoredBoolean(APP_RAIL_COLLAPSED_STORAGE_KEY)
      ?? defaultRailCollapsed;
    const expandedWidth = readStoredWidth(
      APP_RAIL_WIDTH_STORAGE_KEY,
      DEFAULT_RAIL_WIDTH,
      MIN_RAIL_WIDTH,
      MAX_RAIL_WIDTH,
    );
    setRailCollapsed(collapsed);
    if (collapsed) panel.collapse();
    else panel.resize(expandedWidth);

    const frame = window.requestAnimationFrame(() => {
      readyToPersistRef.current = true;
    });
    return () => {
      readyToPersistRef.current = false;
      window.cancelAnimationFrame(frame);
    };
  }, [defaultRailCollapsed, railRef]);

  const setCollapsed = useCallback((collapsed: boolean) => {
    setRailCollapsed(collapsed);
    writeStoredBoolean(APP_RAIL_COLLAPSED_STORAGE_KEY, collapsed);
    if (collapsed) {
      railRef.current?.collapse();
    } else {
      railRef.current?.resize(readStoredWidth(
        APP_RAIL_WIDTH_STORAGE_KEY,
        DEFAULT_RAIL_WIDTH,
        MIN_RAIL_WIDTH,
        MAX_RAIL_WIDTH,
      ));
    }
  }, [railRef]);

  const handleRailResize = useCallback((size: PanelSize) => {
    const collapsed = size.inPixels <= COLLAPSED_RAIL_WIDTH + 1;
    setRailCollapsed((current) => current === collapsed ? current : collapsed);
    if (!readyToPersistRef.current) return;
    writeStoredBoolean(APP_RAIL_COLLAPSED_STORAGE_KEY, collapsed);
    if (!collapsed) writeStoredWidth(APP_RAIL_WIDTH_STORAGE_KEY, size.inPixels);
  }, []);

  return (
    <Group
      id="app-shell"
      orientation="horizontal"
      resizeTargetMinimumSize={{ fine: 20, coarse: 40 }}
      className="h-screen w-full overflow-hidden bg-canvas text-foreground"
    >
      <Panel
        id="app-rail"
        panelRef={railRef}
        defaultSize={defaultRailCollapsed ? COLLAPSED_RAIL_WIDTH : DEFAULT_RAIL_WIDTH}
        minSize={MIN_RAIL_WIDTH}
        maxSize={MAX_RAIL_WIDTH}
        collapsedSize={COLLAPSED_RAIL_WIDTH}
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        onResize={handleRailResize}
      >
        <Suspense>
          <LeftRail
            filters={filters}
            collapsed={railCollapsed}
            onCollapsedChange={setCollapsed}
          />
        </Suspense>
      </Panel>

      <Separator
        id="app-rail-resizer"
        aria-label="Resize sidebar"
        className="group/resize relative z-40 hidden w-px bg-rule outline-none lg:block hover:bg-foreground/30 focus-visible:bg-foreground/40"
      >
        <span className="pointer-events-none absolute left-1/2 top-1/2 inline-flex h-8 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border border-rule bg-background text-fg-faint opacity-40 shadow-sm transition-opacity group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100">
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
        </span>
      </Separator>

      <Panel id="app-content" minSize="50%" className="min-w-0 overflow-y-auto">
        {children}
      </Panel>
    </Group>
  );
}
