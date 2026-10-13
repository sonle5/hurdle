"use client";

import { Drawer } from "@base-ui/react/drawer";
import { Check, Code2, Copy, FileCode2, GripVertical, LoaderCircle, X } from "lucide-react";
import { checkSourcePath, highlightCheckSource } from "@/lib/evaluator-source-display.mjs";
import { readStoredWidth, writeStoredWidth } from "@/lib/browser-layout-storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";

const DEFAULT_DRAWER_WIDTH = 760;
const MIN_DRAWER_WIDTH = 420;
const MAX_DRAWER_WIDTH = 1_200;
const DRAWER_KEYBOARD_STEP = 40;
const DRAWER_WIDTH_STORAGE_KEY = "hurdle-check-code-drawer-width";

function constrainedDrawerWidth(width: number) {
  const viewportMaximum = typeof window === "undefined"
    ? MAX_DRAWER_WIDTH
    : Math.max(MIN_DRAWER_WIDTH, window.innerWidth - 48);
  return Math.min(Math.max(width, MIN_DRAWER_WIDTH), Math.min(MAX_DRAWER_WIDTH, viewportMaximum));
}

export type EvaluatorSourceSummary = {
  path: string;
  sha256: string;
  sizeBytes: number;
  entry: boolean;
};

type LoadedSource = {
  path: string;
  sha256: string;
  source: string;
};

type HighlightedSource = {
  path: string;
  html: string;
};

export function EvaluatorSourceDrawer({
  runId,
  title,
  sources,
  children,
  triggerClassName,
}: {
  runId: string;
  title: string;
  sources: readonly EvaluatorSourceSummary[];
  children?: ReactNode;
  triggerClassName?: string;
}) {
  const activePath = useMemo(() => checkSourcePath(sources), [sources]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);
  const [highlighted, setHighlighted] = useState<HighlightedSource | null>(null);
  const [highlightErrorPath, setHighlightErrorPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_DRAWER_WIDTH);
  const [resizing, setResizing] = useState(false);
  const resizeSession = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    currentWidth: number;
  } | null>(null);

  useEffect(() => {
    setDrawerWidth(constrainedDrawerWidth(readStoredWidth(
      DRAWER_WIDTH_STORAGE_KEY,
      DEFAULT_DRAWER_WIDTH,
      MIN_DRAWER_WIDTH,
      MAX_DRAWER_WIDTH,
    )));
  }, []);

  const saveDrawerWidth = useCallback((width: number) => {
    const nextWidth = constrainedDrawerWidth(width);
    setDrawerWidth(nextWidth);
    writeStoredWidth(DRAWER_WIDTH_STORAGE_KEY, nextWidth);
  }, []);

  const startResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeSession.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: drawerWidth,
      currentWidth: drawerWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  }, [drawerWidth]);

  const continueResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const session = resizeSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const nextWidth = constrainedDrawerWidth(session.startWidth + session.startX - event.clientX);
    session.currentWidth = nextWidth;
    setDrawerWidth(nextWidth);
  }, []);

  const stopResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const session = resizeSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    resizeSession.current = null;
    writeStoredWidth(DRAWER_WIDTH_STORAGE_KEY, session.currentWidth);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(false);
  }, []);

  const resizeWithKeyboard = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = drawerWidth + DRAWER_KEYBOARD_STEP;
    if (event.key === "ArrowRight") nextWidth = drawerWidth - DRAWER_KEYBOARD_STEP;
    if (event.key === "Home") nextWidth = MIN_DRAWER_WIDTH;
    if (event.key === "End") nextWidth = MAX_DRAWER_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    saveDrawerWidth(nextWidth);
  }, [drawerWidth, saveDrawerWidth]);

  useEffect(() => {
    if (!open || !activePath) return undefined;
    const controller = new AbortController();
    setLoaded(null);
    setHighlighted(null);
    setCopied(false);
    setError(null);
    fetch(
      `/api/runs/${encodeURIComponent(runId)}/evaluator-source?path=${encodeURIComponent(activePath)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("Source unavailable");
        return response.json() as Promise<LoadedSource>;
      })
      .then(setLoaded)
      .catch((cause: Error) => {
        if (cause.name !== "AbortError") {
          setError("The exact evaluator source could not be loaded from this Result Store.");
        }
      });
    return () => controller.abort();
  }, [activePath, open, runId]);

  useEffect(() => {
    if (!loaded) return undefined;
    let cancelled = false;
    setHighlightErrorPath(null);
    highlightCheckSource(loaded.source, loaded.path)
      .then((html) => {
        if (!cancelled) setHighlighted({ path: loaded.path, html });
      })
      .catch(() => {
        if (!cancelled) setHighlightErrorPath(loaded.path);
      });
    return () => {
      cancelled = true;
    };
  }, [loaded]);

  if (sources.length === 0) return null;

  const copySource = async () => {
    if (!loaded) return;
    await navigator.clipboard.writeText(loaded.source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <Drawer.Root open={open} onOpenChange={setOpen} swipeDirection="right">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View check code for ${title}`}
        className={triggerClassName ?? "ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rule bg-background px-2.5 text-[11px] font-medium text-fg-muted transition-colors duration-150 hover:border-foreground/20 hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"}
      >
        {children ?? (
          <>
            <Code2 className="h-3 w-3" aria-hidden />
            View check code
          </>
        )}
      </button>
      <Drawer.Portal>
        <Drawer.Backdrop className="evaluator-source-backdrop" />
        <Drawer.Viewport className="fixed inset-0 z-[100] flex items-stretch justify-end">
          <Drawer.Popup
            className="evaluator-source-drawer text-foreground"
            style={{ width: drawerWidth, maxWidth: "100%" }}
          >
            <div
              role="separator"
              aria-label="Resize check code panel"
              aria-orientation="vertical"
              aria-valuemin={MIN_DRAWER_WIDTH}
              aria-valuemax={MAX_DRAWER_WIDTH}
              aria-valuenow={Math.round(drawerWidth)}
              tabIndex={0}
              data-resizing={resizing ? "" : undefined}
              className="evaluator-source-resizer group/resize hidden sm:flex"
              onPointerDown={startResize}
              onPointerMove={continueResize}
              onPointerUp={stopResize}
              onPointerCancel={stopResize}
              onLostPointerCapture={() => {
                resizeSession.current = null;
                setResizing(false);
              }}
              onKeyDown={resizeWithKeyboard}
              onDoubleClick={() => saveDrawerWidth(DEFAULT_DRAWER_WIDTH)}
            >
              <span className="pointer-events-none inline-flex h-8 w-3 items-center justify-center rounded-md border border-rule bg-background text-fg-faint opacity-40 shadow-sm transition-opacity group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100 group-data-[resizing]/resize:opacity-100">
                <GripVertical className="h-3.5 w-3.5" aria-hidden />
              </span>
            </div>
            <Drawer.Content className="flex h-full min-h-0 flex-col">
              <header className="flex shrink-0 items-start justify-between gap-5 border-b border-rule px-5 py-5 sm:px-6">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-fg-muted">
                    <FileCode2 className="h-4 w-4" aria-hidden />
                    <span className="text-[12px] font-medium">
                      Check code
                    </span>
                  </div>
                  <Drawer.Title className="mt-2 truncate text-base font-semibold">
                    {title}
                  </Drawer.Title>
                  <Drawer.Description className="mt-1 text-sm text-fg-muted">
                    Exact source captured with this run and verified against its immutable definition.
                  </Drawer.Description>
                </div>
                <Drawer.Close
                  aria-label="Close evaluator source"
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                >
                  <X className="h-4 w-4" aria-hidden />
                </Drawer.Close>
              </header>

              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <div className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-rule px-4 sm:px-5">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-fg-muted" title={activePath}>{activePath.split("/").at(-1)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={copySource}
                      disabled={!loaded}
                      aria-label="Copy check code"
                      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-xs text-fg-muted transition-colors duration-150 hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                    >
                      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>

                  <div className="evaluator-source-code min-h-0 flex-1 overflow-auto bg-surface/30 font-mono text-[12px] text-foreground">
                    {error ? (
                      <p className="px-5 py-4 font-sans text-sm text-fg-muted">{error}</p>
                    ) : !loaded ? (
                      <div className="flex items-center gap-2 px-5 py-4 font-sans text-sm text-fg-muted">
                        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                        Loading exact source…
                      </div>
                    ) : highlightErrorPath === loaded.path ? (
                      <pre className="min-w-max px-5 py-4"><code>{loaded.source}</code></pre>
                    ) : highlighted?.path !== loaded.path ? (
                      <div className="flex items-center gap-2 px-5 py-4 font-sans text-sm text-fg-muted">
                        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                        Highlighting exact source…
                      </div>
                    ) : (
                      <div
                        dangerouslySetInnerHTML={{ __html: highlighted.html }}
                      />
                    )}
                  </div>
                </div>
              </div>
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
