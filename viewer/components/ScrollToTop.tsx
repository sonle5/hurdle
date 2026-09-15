"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

export function ScrollToTop({ scrollContainerId }: { scrollContainerId: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const container = document.getElementById(scrollContainerId);
    if (!container) return;

    const onScroll = () => {
      setVisible(container.scrollTop > 400);
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [scrollContainerId]);

  const scrollToTop = () => {
    const container = document.getElementById(scrollContainerId);
    container?.scrollTo({ top: 0, behavior: "instant" });
  };

  if (!visible) return null;

  return (
    <button
      onClick={scrollToTop}
      className="fixed bottom-6 right-6 h-10 w-10 rounded-full bg-background border border-rule shadow-md shadow-black/10 flex items-center justify-center text-fg-muted transition-colors hover:text-foreground"
      title="Scroll to top"
    >
      <ArrowUp className="h-4 w-4" />
    </button>
  );
}
