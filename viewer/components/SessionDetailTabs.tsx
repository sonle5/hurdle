"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type SessionTab = "review" | "evidence" | "transcript";

type TabSpec = {
  key: SessionTab;
  label: string;
  count: number;
};

const TAB_KEYS = new Set<SessionTab>(["review", "evidence", "transcript"]);
const TAB_HASHES: Record<SessionTab, string> = {
  review: "#review",
  evidence: "#evidence",
  transcript: "#conversation",
};

function replaceTabHash(tab: SessionTab) {
  const url = `${window.location.pathname}${window.location.search}${TAB_HASHES[tab]}`;
  window.history.replaceState(null, "", url);
}

function tabFromHash(hash: string): SessionTab {
  if (hash.startsWith("#msg-") || hash === "#conversation") return "transcript";
  if (hash === "#evidence") return "evidence";
  if (hash === "#review") return "review";
  return "review";
}

export function SessionDetailTabs({
  review,
  evidence,
  transcript,
  reviewCount,
  evidenceCount,
  transcriptCount,
}: {
  review: ReactNode;
  evidence: ReactNode;
  transcript: ReactNode;
  reviewCount: number;
  evidenceCount: number;
  transcriptCount: number;
}) {
  const [active, setActive] = useState<SessionTab>("review");

  const selectTab = (tab: SessionTab) => {
    setActive(tab);
    replaceTabHash(tab);
  };

  useEffect(() => {
    const syncFromHash = () => setActive(tabFromHash(window.location.hash));
    const handleTabRequest = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail === "string" && TAB_KEYS.has(detail as SessionTab)) {
        const tab = detail as SessionTab;
        setActive(tab);
        replaceTabHash(tab);
      }
    };

    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("session-detail-tab", handleTabRequest);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("session-detail-tab", handleTabRequest);
    };
  }, []);

  const tabs: TabSpec[] = [
    { key: "review", label: "Review", count: reviewCount },
    { key: "evidence", label: "Evidence", count: evidenceCount },
    { key: "transcript", label: "Transcript", count: transcriptCount },
  ];

  const panels: Record<SessionTab, ReactNode> = {
    review,
    evidence,
    transcript,
  };

  return (
    <div className="space-y-8">
      {/* Underline tabs, stuck under the 48px top bar on the panel surface. */}
      <div className="sticky top-12 z-20 bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/80">
        <div
          role="tablist"
          aria-label="Session sections"
          className="flex gap-6 border-b border-rule"
        >
          {tabs.map((tab) => {
            const selected = active === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`session-${tab.key}-panel`}
                id={`session-${tab.key}-tab`}
                onClick={() => selectTab(tab.key)}
                className={cn(
                  "-mb-px inline-flex h-11 min-w-0 items-center gap-2 border-b-2 text-[13px] font-medium transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:rounded-sm",
                  selected
                    ? "border-foreground text-foreground"
                    : "border-transparent text-fg-muted hover:border-foreground/15 hover:text-foreground",
                )}
              >
                <span className="truncate">{tab.label}</span>
                <span
                  className={cn(
                    "min-w-5 shrink-0 rounded-full px-1.5 text-center text-[11px] font-medium leading-[18px] tabular-nums",
                    selected ? "bg-foreground/[0.08] text-foreground" : "bg-foreground/[0.05] text-fg-muted",
                  )}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        id={`session-${active}-panel`}
        role="tabpanel"
        aria-labelledby={`session-${active}-tab`}
        className="outline-none"
      >
        {panels[active]}
      </div>
    </div>
  );
}
