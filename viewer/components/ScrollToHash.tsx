"use client";

import { useEffect } from "react";

// The session page uses a custom scroll container (`#main-scroll`) instead
// of the window, so the browser's native hash scrolling does nothing on
// load. `scrollIntoView` scrolls the nearest scrollable ancestor, which is
// what we want.
export function ScrollToHash() {
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;

    const tryScroll = () => {
      const el = document.getElementById(hash);
      if (!el) return false;
      el.scrollIntoView({ behavior: "instant", block: "start" });
      return true;
    };

    if (tryScroll()) return;

    // The target may not be mounted yet (lazy block, late hydration). Retry
    // a few times on animation frames, then give up.
    let frames = 0;
    let raf = 0;
    const loop = () => {
      if (tryScroll() || frames++ > 30) return;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return null;
}
