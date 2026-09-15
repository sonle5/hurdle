"use client";

import { useEffect, useRef } from "react";

type Handler = (e: KeyboardEvent) => void;
export type HotkeyMap = Record<string, Handler>;

const isEditable = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

/**
 * Lightweight global keyboard shortcut hook.
 *
 * - Single keys: `"j"`, `"/"`, `"ArrowLeft"`, …
 * - Two-key chords: `"g l"` (press g, then l within 800ms). Only `g` is a
 *   recognized prefix today; extend `PREFIXES` to add more.
 * - Ignored while focus is inside an input/textarea/select/contentEditable.
 *
 * Cmd/Ctrl/Alt-modified keys are never matched (so browser shortcuts win).
 */
const PREFIXES = new Set(["g"]);

export function useHotkeys(map: HotkeyMap) {
  // Refs avoid re-binding the document listener whenever the map identity
  // changes — handlers are typically inline arrow fns.
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    let pendingPrefix: string | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const clearPending = () => {
      pendingPrefix = null;
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") { clearPending(); return; }
      if (isEditable(e.target)) return;

      const key = e.key;
      const combo = pendingPrefix ? `${pendingPrefix} ${key}` : null;

      if (combo && mapRef.current[combo]) {
        mapRef.current[combo](e);
        clearPending();
        return;
      }

      if (mapRef.current[key]) {
        mapRef.current[key](e);
        clearPending();
        return;
      }

      if (!pendingPrefix && PREFIXES.has(key)) {
        // Only start a prefix if there's actually at least one chord
        // registered with this prefix — otherwise the `g` press is a no-op.
        const hasChord = Object.keys(mapRef.current).some((k) => k.startsWith(`${key} `));
        if (!hasChord) return;
        pendingPrefix = key;
        pendingTimer = setTimeout(() => { pendingPrefix = null; pendingTimer = null; }, 800);
        return;
      }

      clearPending();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (pendingTimer) clearTimeout(pendingTimer);
    };
  }, []);
}

/** Move document focus to the next / previous element matching `selector`. */
export function moveRowFocus(selector: string, dir: 1 | -1) {
  const els = Array.from(document.querySelectorAll<HTMLElement>(selector));
  if (els.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const idx = active ? els.indexOf(active) : -1;
  const nextIdx = idx === -1
    ? (dir === 1 ? 0 : els.length - 1)
    : (idx + dir + els.length) % els.length;
  const next = els[nextIdx];
  next.focus();
  next.scrollIntoView({ block: "nearest", behavior: "instant" as ScrollBehavior });
}
