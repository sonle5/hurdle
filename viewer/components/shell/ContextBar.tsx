"use client";

import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { X } from "lucide-react";
import { TopBar } from "./TopBar";

const KNOWN_PARAMS = ["agent", "harness", "config", "task", "run", "category"] as const;

type Breadcrumb = { label: string; href?: string };

export function ContextBar({
  versionLabel,
  agentLabel,
  taskLabel,
  sessionLabel,
}: {
  versionLabel?: string;
  agentLabel?: Record<string, string>;
  taskLabel?: Record<string, string>;
  sessionLabel?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const removeParam = (key: string) => {
    const p = new URLSearchParams(sp.toString());
    p.delete(key);
    // Legacy: clearing the agent chip should also drop the older `harness` key.
    if (key === "agent") p.delete("harness");
    const qs = p.toString();
    router.replace((pathname || "") + (qs ? `?${qs}` : ""), { scroll: false });
  };

  const resetAll = () => {
    const p = new URLSearchParams();
    const v = sp.get("v");
    if (v) p.set("v", v);
    router.replace((pathname || "") + (p.toString() ? `?${p.toString()}` : ""), { scroll: false });
  };

  // Crumb derivation: /, /t/<slug>, /s/<id>
  // On the Leaderboard itself the crumb is the current page, not a link.
  let crumbs: Breadcrumb[] = [{ label: "Leaderboard", href: pathname === "/" ? undefined : "/" }];
  if (pathname?.startsWith("/t/")) {
    const slug = decodeURIComponent(pathname.slice(3));
    crumbs.push({ label: taskLabel?.[slug] || slug });
  } else if (pathname?.startsWith("/s/")) {
    crumbs.push({ label: sessionLabel || "Session" });
  } else if (pathname?.startsWith("/compare")) {
    crumbs.push({ label: "Compare" });
  }

  // Active chips
  const chips: { key: string; value: string; label: string }[] = [];
  for (const key of KNOWN_PARAMS) {
    const v = sp.get(key);
    if (!v || v === "all") continue;
    let label: string = v;
    if (key === "agent" || key === "harness") label = agentLabel?.[v] || v;
    if (key === "task") label = taskLabel?.[v] || v;
    if (key === "run") label = v.replace("run", "Run ");
    if (key === "category") label = v === "cli" ? "CLI" : "General";
    chips.push({ key: key === "harness" ? "agent" : key, value: v, label: `${labelForKey(key)}: ${label}` });
  }

  const hasFilters = chips.length > 0;

  return (
    <TopBar
      crumbs={crumbs}
      versionLabel={versionLabel}
      right={hasFilters ? (
        <button
          onClick={resetAll}
          className="shrink-0 rounded-sm text-[12px] text-fg-muted transition-colors duration-150 hover:text-foreground"
        >
          Clear
        </button>
      ) : null}
    >
      {hasFilters && (
        <div className="flex items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={`${c.key}:${c.value}`}
              onClick={() => removeParam(c.key)}
              className="group inline-flex items-center gap-1 rounded-md border border-rule bg-background px-2 py-0.5 text-[12px] text-fg-muted transition-colors duration-150 hover:border-foreground/40 hover:text-foreground"
            >
              <span>{c.label}</span>
              <X className="h-3 w-3 shrink-0 text-fg-faint group-hover:text-foreground" />
            </button>
          ))}
        </div>
      )}
    </TopBar>
  );
}

function labelForKey(k: string): string {
  switch (k) {
    case "agent":
    case "harness": return "Agent";
    case "config": return "Config";
    case "task": return "Task";
    case "run": return "Run";
    case "category": return "Category";
  }
  return k;
}
