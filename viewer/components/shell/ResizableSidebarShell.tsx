"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { Group, Panel, Separator, usePanelRef, type Layout, type LayoutChangedMeta, type PanelSize } from "react-resizable-panels";
import {
  COLLAPSED_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY, SIDEBAR_COLLAPSED_STORAGE_KEY,
  readStoredBoolean, readStoredWidth, writeStoredBoolean, writeStoredWidth,
} from "@/lib/browser-layout-storage";

export function SidebarToggle({ collapsed, onCollapsedChange }: {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  return (
    <button
      onClick={() => onCollapsedChange(!collapsed)}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-faint hover:text-foreground hover:bg-foreground/5"
    >
      <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden className="h-3.5 w-3.5">
        <rect x="-0.35" y="0.35" width="13.3" height="13.3" rx="2.65" transform="matrix(-1 0 0 1 13.3 0)" stroke="currentColor" strokeWidth="0.7" />
        <rect width={collapsed ? 4 : 1.5} height="10" rx={collapsed ? 1 : 0.75} transform={`matrix(-1 0 0 1 ${collapsed ? 6 : 3.5} 2)`} fill="currentColor" />
      </svg>
    </button>
  );
}

export function ResizableSidebarShell({
  id, initialWidth = DEFAULT_SIDEBAR_WIDTH, initialCollapsed = false,
  resizeLabel = "Resize sidebar", contentClassName = "", sidebar, children,
}: {
  id: string;
  initialWidth?: number;
  initialCollapsed?: boolean;
  resizeLabel?: string;
  contentClassName?: string;
  sidebar: (collapsed: boolean, onCollapsedChange: (collapsed: boolean) => void) => ReactNode;
  children: ReactNode;
}) {
  const railRef = usePanelRef();
  const railElementRef = useRef<HTMLDivElement>(null);
  const contentElementRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  useEffect(() => {
    const panel = railRef.current;
    if (!panel) return;
    const savedCollapsed = readStoredBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY) ?? initialCollapsed;
    setCollapsed(savedCollapsed);
    if (savedCollapsed) panel.collapse();
    else panel.resize(readStoredWidth(SIDEBAR_WIDTH_STORAGE_KEY, initialWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
  }, [initialCollapsed, initialWidth, railRef]);

  const toggle = useCallback((nextCollapsed: boolean) => {
    setCollapsed(nextCollapsed);
    writeStoredBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY, nextCollapsed);
    if (nextCollapsed) railRef.current?.collapse();
    else railRef.current?.resize(readStoredWidth(SIDEBAR_WIDTH_STORAGE_KEY, initialWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
  }, [initialWidth, railRef]);

  const handleResize = useCallback((size: PanelSize) => {
    setCollapsed(size.inPixels <= COLLAPSED_SIDEBAR_WIDTH + 1);
  }, []);

  const persistUserLayout = useCallback((layout: Layout, { isUserInteraction }: LayoutChangedMeta) => {
    // Mounting, restoring a saved layout and viewport changes must not replace the user's choice.
    if (!isUserInteraction || !railElementRef.current || !contentElementRef.current) return;
    // Keyboard callbacks can precede the DOM resize; use the completed layout's percentage.
    const groupWidth = railElementRef.current.offsetWidth + contentElementRef.current.offsetWidth;
    const width = Math.round(layout[`${id}-rail`] / 100 * groupWidth);
    const nextCollapsed = width <= COLLAPSED_SIDEBAR_WIDTH + 1;
    writeStoredBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY, nextCollapsed);
    if (!nextCollapsed) writeStoredWidth(SIDEBAR_WIDTH_STORAGE_KEY, width);
  }, [id]);

  return (
    <Group
      id={id}
      orientation="horizontal"
      onLayoutChanged={persistUserLayout}
      resizeTargetMinimumSize={{ fine: 20, coarse: 40 }}
      className="h-screen w-full overflow-hidden bg-canvas text-foreground"
    >
      <Panel
        id={`${id}-rail`}
        panelRef={railRef}
        elementRef={railElementRef}
        defaultSize={initialCollapsed ? COLLAPSED_SIDEBAR_WIDTH : initialWidth}
        minSize={MIN_SIDEBAR_WIDTH}
        maxSize={MAX_SIDEBAR_WIDTH}
        collapsedSize={COLLAPSED_SIDEBAR_WIDTH}
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        onResize={handleResize}
      >
        {sidebar(collapsed, toggle)}
      </Panel>
      <Separator
        id={`${id}-resizer`}
        aria-label={resizeLabel}
        className="group/resize relative z-40 hidden w-px bg-rule outline-none lg:block hover:bg-foreground/30 focus-visible:bg-foreground/40"
      >
        <span className="pointer-events-none absolute left-1/2 top-1/2 inline-flex h-8 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border border-rule bg-background text-fg-faint opacity-40 shadow-sm transition-opacity group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100">
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
        </span>
      </Separator>
      <Panel id={`${id}-content`} elementRef={contentElementRef} minSize="50%" className={`min-w-0 ${contentClassName}`}>
        {children}
      </Panel>
    </Group>
  );
}
