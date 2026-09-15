"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ClipboardCheck, Database, MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";

type SessionTab = "review" | "evidence" | "transcript";

type TabSpec = {
  key: SessionTab;
  label: string;
  count: number;
  icon: typeof ClipboardCheck;
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
    { key: "review", label: "Review", count: reviewCount, icon: ClipboardCheck },
    { key: "evidence", label: "Evidence", count: evidenceCount, icon: Database },
    { key: "transcript", label: "Transcript", count: transcriptCount, icon: MessagesSquare },
  ];

  const panels: Record<SessionTab, ReactNode> = {
    review,
    evidence,
    transcript,
  };

  return (
    <div className="space-y-8">
      <div className="sticky top-0 z-20 -mx-4 bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-8 sm:px-8">
        <div
          role="tablist"
          aria-label="Session sections"
          className="grid h-11 w-full grid-cols-3 rounded-lg border border-rule bg-surface/60 p-1"
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
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
                  "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-[color,background-color,box-shadow] duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
                  selected
                    ? "bg-background text-foreground ring-1 ring-foreground/[0.06]"
                    : "text-fg-muted hover:bg-background/60 hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{tab.label}</span>
                <span
                  className={cn(
                    "min-w-4 shrink-0 rounded-full px-1 text-[10px] tabular-nums",
                    selected ? "bg-surface text-fg-muted" : "bg-background/70 text-fg-faint",
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
